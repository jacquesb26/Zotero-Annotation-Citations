import {
	App,
	Editor,
	EditorPosition,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	requestUrl,
} from "obsidian";
import { promises as fs } from "fs";
import {
	CitekeyResolver,
	ResolveItem,
	BibFileResolver,
	convertZoteroCitations,
	stripAnnotationLinks,
	CLUSTER_RE,
} from "./transform";

/**
 * Minimal shape of the CodeMirror 6 EditorView that Obsidian's Editor
 * wraps at `.cm`. Only the bit we actually use is typed; the real
 * EditorView has far more surface than this.
 */
interface EditorViewLike {
	posAtCoords(coords: { x: number; y: number }): number | null;
}

/* ------------------------------------------------------------------ */
/*  Settings                                                          */
/* ------------------------------------------------------------------ */

type CitekeySource = "betterbibtex" | "bibfile";

interface ZoteroAnnotationSettings {
	source: CitekeySource;
	bbtPort: number;
	bibFilePath: string; // absolute filesystem path
	linkTarget: "pdf" | "select"; // which zotero link to use when both are available
	warnOnUnresolved: boolean;
	autoConvert: boolean; // convert automatically on paste/drop instead of via command
}

const DEFAULT_SETTINGS: ZoteroAnnotationSettings = {
	source: "betterbibtex",
	bbtPort: 23119,
	bibFilePath: "",
	linkTarget: "pdf",
	warnOnUnresolved: true,
	autoConvert: true,
};

/* ------------------------------------------------------------------ */
/*  Resolver: live Zotero via Better BibTeX JSON-RPC                  */
/* ------------------------------------------------------------------ */

interface BetterBibTexJsonRpcResponse {
	result?: Record<string, string>;
	error?: { code?: number; message?: string };
}

class BetterBibTexResolver implements CitekeyResolver {
	private map = new Map<string, string>(); // "libPath:itemKey" -> citekey

	constructor(private port: number) {}

	private cacheKey(item: { libPath: string; itemKey: string }): string {
		return `${item.libPath}:${item.itemKey}`;
	}

	async prepare(items: ResolveItem[]): Promise<void> {
		const unique = new Map<string, ResolveItem>();
		for (const it of items) unique.set(this.cacheKey(it), it);
		if (unique.size === 0) return;

		// Better BibTeX wants "[libraryID]:[itemKey]" strings. For the
		// personal library the libraryID prefix is omitted; for group
		// libraries we pass the numeric group id as the libraryID.
		const params: string[] = [];
		const paramToKey: string[] = [];
		for (const it of unique.values()) {
			const groupMatch = /^groups\/(\d+)$/.exec(it.libPath);
			const param = groupMatch ? `${groupMatch[1]}:${it.itemKey}` : it.itemKey;
			params.push(param);
			paramToKey.push(this.cacheKey(it));
		}

		const body = {
			jsonrpc: "2.0",
			method: "item.citationkey",
			params: [params],
		};

		let json: BetterBibTexJsonRpcResponse;
		try {
			const res = await requestUrl({
				url: `http://127.0.0.1:${this.port}/better-bibtex/json-rpc`,
				method: "POST",
				contentType: "application/json",
				// Zotero 9's server cancels any request carrying an Origin header
				// (Obsidian's requestUrl always sends Origin: app://obsidian.md)
				// unless it carries this header. Without it every call silently
				// fails with an empty reply. See:
				// https://github.com/retorquere/zotero-better-bibtex/issues/3607
				headers: {
					Accept: "application/json",
					"zotero-allowed-request": "true",
				},
				body: JSON.stringify(body),
				throw: false,
			});
			json = res.json as BetterBibTexJsonRpcResponse;
		} catch {
			throw new Error(
				"Could not reach Zotero / Better BibTeX on port " +
					this.port +
					". Make sure Zotero is running with Better BibTeX installed, and that no firewall is blocking localhost."
			);
		}

		if (json.error) {
			throw new Error(
				"Better BibTeX returned an error: " + JSON.stringify(json.error)
			);
		}

		const result = json.result;
		if (!result) return;

		// item.citationkey returns { "[libraryID]:[itemKey]": "citekey" },
		// using the same params we sent, in the same order/shape.
		for (let i = 0; i < params.length; i++) {
			const citekey = result[params[i]];
			if (citekey) this.map.set(paramToKey[i], citekey);
		}
	}

	resolve(item: ResolveItem): string | null {
		return this.map.get(this.cacheKey(item)) ?? null;
	}
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

export default class ZoteroAnnotationCitationsPlugin extends Plugin {
	settings: ZoteroAnnotationSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "convert-selection",
			name: "Convert Zotero annotation links to Pandoc citations (selection)",
			editorCallback: (editor: Editor) => this.runOnSelection(editor),
		});

		this.addCommand({
			id: "convert-file",
			name: "Convert Zotero annotation links to Pandoc citations (whole note)",
			editorCallback: (editor: Editor) => this.runOnWholeFile(editor),
		});

		this.addCommand({
			id: "strip-annotation-links",
			name: "Remove annotation links from Pandoc citations (whole note, for export)",
			editorCallback: (editor: Editor) => this.runStripLinks(editor),
		});

		this.addSettingTab(new ZoteroAnnotationSettingTab(this.app, this));

		// Automatic conversion: intercept Zotero citations as they're pasted
		// or dragged in, before Obsidian inserts the raw text.
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt: ClipboardEvent, editor: Editor) =>
				this.handleIncomingText(evt, editor, evt.clipboardData)
			)
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", (evt: DragEvent, editor: Editor) =>
				this.handleIncomingText(evt, editor, evt.dataTransfer, evt)
			)
		);
	}

	/**
	 * Shared handler for both paste and drop. Only intercepts text that
	 * actually contains a convertible Zotero citation cluster; everything
	 * else (images, other links, plain text) is left to Obsidian's default
	 * handling so this plugin never interferes with normal pasting.
	 */
	private handleIncomingText(
		evt: ClipboardEvent | DragEvent,
		editor: Editor,
		dataTransfer: DataTransfer | null,
		dragEvt?: DragEvent
	) {
		if (!this.settings.autoConvert || !dataTransfer) return;

		const text = dataTransfer.getData("text/plain");
		if (!text) return;

		CLUSTER_RE.lastIndex = 0;
		if (!CLUSTER_RE.test(text)) return; // nothing Zotero-shaped in here, don't touch it

		evt.preventDefault();
		evt.stopPropagation();

		const dropPos = dragEvt ? this.getDropPosition(editor, dragEvt) : null;

		void this.convertAndInsert(text, editor, dropPos);
	}

	private getDropPosition(editor: Editor, evt: DragEvent): EditorPosition | null {
		try {
			// Obsidian's Editor wraps a CodeMirror 6 EditorView at `.cm`.
			// This is undocumented but stable across recent Obsidian versions,
			// and is how other community plugins locate a drop precisely.
			const cm = (editor as unknown as { cm?: EditorViewLike }).cm;
			const offset = cm?.posAtCoords({ x: evt.clientX, y: evt.clientY });
			if (typeof offset === "number") return editor.offsetToPos(offset);
		} catch {
			/* fall through to cursor position below */
		}
		return null;
	}

	private async convertAndInsert(
		text: string,
		editor: Editor,
		dropPos: EditorPosition | null
	) {
		try {
			const resolver = this.buildResolver();
			const { output, converted, unresolved } = await convertZoteroCitations(
				text,
				resolver,
				this.settings.linkTarget
			);

			if (dropPos) {
				editor.replaceRange(output, dropPos);
				const end = editor.offsetToPos(editor.posToOffset(dropPos) + output.length);
				editor.setCursor(end);
			} else {
				editor.replaceSelection(output);
			}

			if (unresolved > 0) {
				new Notice(
					`Converted ${converted} citation${converted === 1 ? "" : "s"}; ${unresolved} left as-is (citekey not found).`,
					6000
				);
			}
		} catch (e) {
			// Never swallow the user's citation: fall back to inserting the
			// original Zotero text untouched, and say why conversion failed.
			if (dropPos) {
				editor.replaceRange(text, dropPos);
			} else {
				editor.replaceSelection(text);
			}
			new Notice(
				"Zotero → Pandoc: " + (e as Error).message + " Pasted the original link instead.",
				8000
			);
		}
	}

	private buildResolver(): CitekeyResolver {
		if (this.settings.source === "betterbibtex") {
			return new BetterBibTexResolver(this.settings.bbtPort);
		}
		return new BibFileResolver(() => this.readBibFile());
	}

	/**
	 * Reads the configured .bib file from disk. Pulled out into its own
	 * explicitly-typed method (rather than an inline arrow passed to
	 * BibFileResolver) so `fs.readFile`'s resolved type is pinned to
	 * `string` rather than being inferred loosely at the call site.
	 */
	private async readBibFile(): Promise<string> {
		const path = this.settings.bibFilePath;
		if (!path) {
			throw new Error(
				"No .bib file path is set. Add one in the plugin settings."
			);
		}
		try {
			const contents: string = await fs.readFile(path, "utf8");
			return contents;
		} catch (e) {
			throw new Error(
				`Could not read bib file at "${path}": ${(e as Error).message}`
			);
		}
	}

	private async runOnSelection(editor: Editor) {
		const selection = editor.getSelection();
		const source = selection && selection.length > 0 ? selection : editor.getValue();
		const usingSelection = selection && selection.length > 0;

		try {
			const resolver = this.buildResolver();
			const { output, converted, unresolved } = await convertZoteroCitations(
				source,
				resolver,
				this.settings.linkTarget
			);

			if (usingSelection) {
				editor.replaceSelection(output);
			} else {
				editor.setValue(output);
			}

			this.reportResult(converted, unresolved, resolver);
		} catch (e) {
			new Notice("Zotero → Pandoc: " + (e as Error).message, 8000);
		}
	}

	private async runOnWholeFile(editor: Editor) {
		try {
			const resolver = this.buildResolver();
			const original = editor.getValue();
			const { output, converted, unresolved } = await convertZoteroCitations(
				original,
				resolver,
				this.settings.linkTarget
			);

			if (output !== original) {
				const cursor = editor.getCursor();
				editor.setValue(output);
				editor.setCursor(cursor);
			}

			this.reportResult(converted, unresolved, resolver);
		} catch (e) {
			new Notice("Zotero → Pandoc: " + (e as Error).message, 8000);
		}
	}

	private runStripLinks(editor: Editor) {
		const original = editor.getValue();
		const { output, stripped } = stripAnnotationLinks(original);

		if (stripped === 0) {
			new Notice("No annotation links found to remove.");
			return;
		}

		const cursor = editor.getCursor();
		editor.setValue(output);
		editor.setCursor(cursor);

		new Notice(
			`Removed the annotation link from ${stripped} citation${stripped === 1 ? "" : "s"}.`,
			6000
		);
	}

	private reportResult(converted: number, unresolved: number, resolver: CitekeyResolver) {
		if (converted === 0 && unresolved === 0) {
			new Notice("No Zotero annotation links found.");
			return;
		}

		let msg = `Converted ${converted} citation${converted === 1 ? "" : "s"}.`;
		if (unresolved > 0) {
			msg += ` ${unresolved} left unchanged (citekey not found).`;
		}
		if (resolver instanceof BibFileResolver && this.settings.warnOnUnresolved) {
			if (resolver.ambiguous.length > 0) {
				msg += ` ${resolver.ambiguous.length} matched more than one bib entry - double check those.`;
			}
		}
		new Notice(msg, 6000);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<ZoteroAnnotationSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* ------------------------------------------------------------------ */
/*  Settings tab                                                      */
/* ------------------------------------------------------------------ */

class ZoteroAnnotationSettingTab extends PluginSettingTab {
	plugin: ZoteroAnnotationCitationsPlugin;

	constructor(app: App, plugin: ZoteroAnnotationCitationsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Declarative mirror of display() below, used by Obsidian 1.13.0+ to
	 * index these settings in the in-app settings search and to render the
	 * tab without the imperative rebuild-on-every-change dance. display()
	 * is kept as a fallback for the Obsidian versions this plugin still
	 * supports (down to minAppVersion) that predate this API - see its
	 * @deprecated note.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;

		return [
			{
				type: "group",
				items: [
					{
						name: "Convert automatically",
						desc: "Convert Zotero citations the moment you paste or drag them in, instead of running a command afterwards. Anything that isn't a Zotero citation is left completely alone. The two commands below still work for converting text already in a note.",
						control: {
							type: "toggle",
							key: "autoConvert",
							defaultValue: DEFAULT_SETTINGS.autoConvert,
						},
					},
					{
						name: "Citekey source",
						desc: "Better BibTeX (live) queries Zotero directly and is exact. A .bib file works offline but matches citekeys by author surname + year, so it can occasionally be ambiguous.",
						control: {
							type: "dropdown",
							key: "source",
							defaultValue: DEFAULT_SETTINGS.source,
							options: {
								betterbibtex: "Better BibTeX (live Zotero)",
								bibfile: "Local .bib file",
							},
						},
					},
					{
						name: "Better BibTeX port",
						desc: "The local port Better BibTeX's JSON-RPC API listens on (Zotero must be running). Default is 23119.",
						visible: () => settings.source === "betterbibtex",
						control: {
							type: "number",
							key: "bbtPort",
							defaultValue: DEFAULT_SETTINGS.bbtPort,
							min: 1,
							max: 65535,
							step: 1,
						},
					},
					{
						name: ".bib file path",
						desc:
							"Absolute path to your Better BibTeX-exported .bib file, e.g. " +
							'"/Users/you/Zotero/library.bib" or "C:\\Users\\you\\Zotero\\library.bib".',
						visible: () => settings.source === "bibfile",
						control: {
							type: "text",
							key: "bibFilePath",
							defaultValue: DEFAULT_SETTINGS.bibFilePath,
							placeholder: "/Users/you/Zotero/library.bib",
						},
					},
					{
						name: "Link target",
						desc: '"PDF annotation" links straight to the highlighted annotation when one is present (falls back to the item otherwise). "Item only" always links to the Zotero item.',
						control: {
							type: "dropdown",
							key: "linkTarget",
							defaultValue: DEFAULT_SETTINGS.linkTarget,
							options: {
								pdf: "PDF annotation (recommended)",
								select: "Item only",
							},
						},
					},
				],
			},
			{
				type: "group",
				heading: "Usage",
				items: [
					{
						name: "Convert a dragged-in annotation",
						desc:
							"Drag an annotation from Zotero into a note as usual, then run “Convert Zotero annotation links to Pandoc citations” (selection or whole note) from the command palette. " +
							"([Author, 2020, p. 5](zotero://select/...)) ([pdf](zotero://open-pdf/...)) becomes [@author2020, p. 5](zotero://open-pdf/...) - Cmd/Ctrl-click still opens the exact highlight in Zotero, and Pandoc/CSL renders the citation normally.",
					},
					{
						name: "Export a note",
						desc:
							"When a note is ready to export, run “Remove annotation links from Pandoc citations” to strip the zotero:// link back out, turning [@author2020, p. 5](zotero://...) into a plain [@author2020, p. 5] citation.",
					},
				],
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Convert automatically")
			.setDesc(
				"Convert Zotero citations the moment you paste or drag them in, instead of running a command afterwards. Anything that isn't a Zotero citation is left completely alone. The two commands below still work for converting text already in a note."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoConvert).onChange(async (value) => {
					this.plugin.settings.autoConvert = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Citekey source")
			.setDesc(
				"Better BibTeX (live) queries Zotero directly and is exact. A .bib file works offline but matches citekeys by author surname + year, so it can occasionally be ambiguous."
			)
			.addDropdown((drop) =>
				drop
					.addOption("betterbibtex", "Better BibTeX (live Zotero)")
					.addOption("bibfile", "Local .bib file")
					.setValue(this.plugin.settings.source)
					.onChange(async (value: CitekeySource) => {
						this.plugin.settings.source = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.source === "betterbibtex") {
			new Setting(containerEl)
				.setName("Better BibTeX port")
				.setDesc(
					"The local port Better BibTeX's JSON-RPC API listens on (Zotero must be running). Default is 23119."
				)
				.addText((text) =>
					text
						.setValue(String(this.plugin.settings.bbtPort))
						.onChange(async (value) => {
							const port = parseInt(value, 10);
							if (!isNaN(port)) {
								this.plugin.settings.bbtPort = port;
								await this.plugin.saveSettings();
							}
						})
				);
		} else {
			new Setting(containerEl)
				.setName(".bib file path")
				.setDesc(
					"Absolute path to your Better BibTeX-exported .bib file, e.g. " +
						'"/Users/you/Zotero/library.bib" or "C:\\Users\\you\\Zotero\\library.bib".'
				)
				.addText((text) =>
					text
						.setPlaceholder("/Users/you/Zotero/library.bib")
						.setValue(this.plugin.settings.bibFilePath)
						.onChange(async (value) => {
							this.plugin.settings.bibFilePath = value.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Link target")
			.setDesc(
				'"PDF annotation" links straight to the highlighted annotation when one is present (falls back to the item otherwise). "Item only" always links to the Zotero item.'
			)
			.addDropdown((drop) =>
				drop
					.addOption("pdf", "PDF annotation (recommended)")
					.addOption("select", "Item only")
					.setValue(this.plugin.settings.linkTarget)
					.onChange(async (value: "pdf" | "select") => {
						this.plugin.settings.linkTarget = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Usage").setHeading();
		const p = containerEl.createEl("p");
		p.setText(
			"Drag an annotation from Zotero into a note as usual, then run “Convert Zotero annotation links to Pandoc citations” (selection or whole note) from the command palette. " +
				"([Author, 2020, p. 5](zotero://select/...)) ([pdf](zotero://open-pdf/...)) becomes [@author2020, p. 5](zotero://open-pdf/...) - Cmd/Ctrl-click still opens the exact highlight in Zotero, and Pandoc/CSL renders the citation normally."
		);

		const p2 = containerEl.createEl("p");
		p2.setText(
			"When a note is ready to export, run “Remove annotation links from Pandoc citations” to strip the zotero:// link back out, turning [@author2020, p. 5](zotero://...) into a plain [@author2020, p. 5] citation."
		);
	}
}
