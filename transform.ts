/* ------------------------------------------------------------------ */
/*  Shared types                                                      */
/* ------------------------------------------------------------------ */

/** One Zotero item reference found inside a citation cluster. */
export interface SelectRef {
	raw: string; // the whole "[text](zotero://select/.../items/KEY)" match
	text: string; // the display text, e.g. "Smith, 2020, p. 5"
	libPath: string; // "library" or "groups/12345"
	itemKey: string;
}

/** One Zotero PDF/annotation link found inside a citation cluster. */
export interface PdfRef {
	raw: string;
	libPath: string;
	itemKey: string;
	page: string;
	annotation: string;
}

export interface ResolveItem {
	itemKey: string;
	libPath: string;
	displayText: string;
}

export interface CitekeyResolver {
	/** Look up everything needed for the whole batch in as few round trips as possible. */
	prepare(items: ResolveItem[]): Promise<void>;
	/** Return the resolved citekey for one item, or null if it couldn't be resolved. */
	resolve(item: ResolveItem): string | null;
}

/* ------------------------------------------------------------------ */
/*  Regexes for the Zotero drag-and-drop annotation format            */
/* ------------------------------------------------------------------ */

const KEY = "[A-Z0-9]{6,12}";
const LIB = "(?:library|groups\\/\\d+)";

// A single "[Smith, 2020, p. 5](zotero://select/library/items/ABCD1234)"
export const SELECT_LINK_RE = new RegExp(
	`\\[([^\\]]+)\\]\\(zotero://select/(${LIB})/items/(${KEY})\\)`,
	"g"
);

// A single "[pdf](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678)"
export const PDF_LINK_RE = new RegExp(
	`\\[pdf\\]\\(zotero://open-pdf/(${LIB})/items/(${KEY})\\?page=(\\d+)&annotation=(${KEY})\\)`,
	"g"
);

// The whole citation cluster Zotero produces when you drag one or more
// annotations: one parenthesised group of select-links (possibly several,
// separated by "; "), followed by zero or more "([pdf](...))" groups.
export const CLUSTER_RE = new RegExp(
	`\\(((?:\\[[^\\]]+\\]\\(zotero://select/${LIB}/items/${KEY}\\))(?:;\\s*\\[[^\\]]+\\]\\(zotero://select/${LIB}/items/${KEY}\\))*)\\)` +
		`((?:\\s*\\(\\[pdf\\]\\(zotero://open-pdf/${LIB}/items/${KEY}\\?page=\\d+&annotation=${KEY}\\)\\))*)`,
	"g"
);

const YEAR_AND_SUFFIX_RE = /(\d{4}[a-z]?)\s*,?\s*(.*)$/;

/* ------------------------------------------------------------------ */
/*  Parsing helpers                                                    */
/* ------------------------------------------------------------------ */

export function parseSelectRefs(clusterText: string): SelectRef[] {
	const refs: SelectRef[] = [];
	let m: RegExpExecArray | null;
	SELECT_LINK_RE.lastIndex = 0;
	while ((m = SELECT_LINK_RE.exec(clusterText)) !== null) {
		refs.push({
			raw: m[0],
			text: m[1],
			libPath: m[2],
			itemKey: m[3],
		});
	}
	return refs;
}

export function parsePdfRefs(clusterText: string): PdfRef[] {
	const refs: PdfRef[] = [];
	let m: RegExpExecArray | null;
	PDF_LINK_RE.lastIndex = 0;
	while ((m = PDF_LINK_RE.exec(clusterText)) !== null) {
		refs.push({
			raw: m[0],
			libPath: m[1],
			itemKey: m[2],
			page: m[3],
			annotation: m[4],
		});
	}
	return refs;
}

/** Split "Smith, 2020, p. 5" into the page/locator suffix ("p. 5"), dropping author+year. */
export function extractSuffix(displayText: string): string {
	const m = YEAR_AND_SUFFIX_RE.exec(displayText);
	if (!m) return "";
	return m[2].trim();
}

export function extractYear(displayText: string): string | null {
	const m = /(\d{4})/.exec(displayText);
	return m ? m[1] : null;
}

/** Everything before the year - the author portion Zotero rendered. */
export function extractAuthorPortion(displayText: string): string {
	const idx = displayText.search(/\d{4}/);
	if (idx === -1) return displayText;
	return displayText.slice(0, idx).replace(/[,\s]+$/, "");
}

/* ------------------------------------------------------------------ */
/*  Resolver: a local .bib file (matched by author surname + year)    */
/* ------------------------------------------------------------------ */

export interface BibEntry {
	citekey: string;
	year: string | null;
	surnames: string[]; // lowercase family names of every author/editor
}

function splitTopLevel(text: string, sep: string): string[] {
	// Splits on `sep` but not inside {..} braces - used for bib field lists.
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") depth++;
		if (ch === "}") depth--;
		if (depth === 0 && text.slice(i, i + sep.length) === sep) {
			parts.push(current);
			current = "";
			i += sep.length - 1;
		} else {
			current += ch;
		}
	}
	parts.push(current);
	return parts;
}

export function parseBibFile(source: string): BibEntry[] {
	const entries: BibEntry[] = [];
	let i = 0;
	while (i < source.length) {
		const at = source.indexOf("@", i);
		if (at === -1) break;
		const braceOpen = source.indexOf("{", at);
		if (braceOpen === -1) break;
		// walk to the matching closing brace
		let depth = 1;
		let j = braceOpen + 1;
		while (j < source.length && depth > 0) {
			if (source[j] === "{") depth++;
			else if (source[j] === "}") depth--;
			j++;
		}
		const body = source.slice(braceOpen + 1, j - 1);
		i = j;

		const commaIdx = body.indexOf(",");
		if (commaIdx === -1) continue;
		const citekey = body.slice(0, commaIdx).trim();
		const fieldsText = body.slice(commaIdx + 1);

		let year: string | null = null;
		let surnames: string[] = [];

		for (const rawField of splitTopLevel(fieldsText, ",")) {
			const eq = rawField.indexOf("=");
			if (eq === -1) continue;
			const name = rawField.slice(0, eq).trim().toLowerCase();
			let value = rawField.slice(eq + 1).trim();
			value = value.replace(/^[{"]|[}"]$/g, "").trim();

			if (name === "year") {
				const m = /(\d{4})/.exec(value);
				if (m) year = m[1];
			} else if (name === "date" && !year) {
				const m = /(\d{4})/.exec(value);
				if (m) year = m[1];
			} else if (name === "author" || (name === "editor" && surnames.length === 0)) {
				surnames = value
					.split(/\s+and\s+/i)
					.map((person) => {
						const p = person.trim();
						if (p.includes(",")) return p.split(",")[0].trim();
						const words = p.split(/\s+/);
						return words[words.length - 1];
					})
					.map((s) => s.toLowerCase())
					.filter(Boolean);
			}
		}

		if (citekey) entries.push({ citekey, year, surnames });
	}
	return entries;
}

export class BibFileResolver implements CitekeyResolver {
	private entries: BibEntry[] = [];
	private cache = new Map<string, string | null>();
	public ambiguous: string[] = [];
	public notFound: string[] = [];

	constructor(private readFile: () => Promise<string>) {}

	async prepare(items: ResolveItem[]): Promise<void> {
		if (this.entries.length === 0) {
			const text = await this.readFile();
			this.entries = parseBibFile(text);
		}
		for (const item of items) {
			const key = item.itemKey; // used only as a cache key here
			if (this.cache.has(key)) continue;
			this.cache.set(key, this.match(item.displayText));
		}
	}

	private match(displayText: string): string | null {
		const year = extractYear(displayText);
		const authorPortion = extractAuthorPortion(displayText).toLowerCase();
		if (!year) return null;

		const candidates = this.entries.filter(
			(e) =>
				e.year === year &&
				e.surnames.some((sn) => sn.length > 1 && authorPortion.includes(sn))
		);

		if (candidates.length === 1) return candidates[0].citekey;
		if (candidates.length === 0) {
			this.notFound.push(`${authorPortion}, ${year}`);
			return null;
		}
		this.ambiguous.push(`${authorPortion}, ${year}`);
		return candidates[0].citekey; // best effort - still flagged as ambiguous
	}

	resolve(item: ResolveItem): string | null {
		return this.cache.get(item.itemKey) ?? null;
	}
}

/* ------------------------------------------------------------------ */
/*  Stripping annotation links back out (for export)                  */
/* ------------------------------------------------------------------ */

// Matches a pandoc citation this plugin produced, still carrying its
// zotero:// link: "[@key, p. 5](zotero://open-pdf/.../items/KEY?page=..&annotation=..)"
// or the item-only form "[@key](zotero://select/.../items/KEY)".
export const CITATION_LINK_RE = new RegExp(
	`\\[(@[^\\]]+)\\]\\(zotero://(?:open-pdf|select)/${LIB}/items/${KEY}` +
		`(?:\\?page=\\d+&annotation=${KEY})?\\)`,
	"g"
);

export interface StripLinksResult {
	output: string;
	stripped: number;
}

/**
 * Turns "[@key, p. 5](zotero://...)" into a plain "[@key, p. 5]" pandoc
 * citation, removing the zotero:// link. Meant to be run once a document
 * is ready for export, when the annotation links are no longer needed.
 */
export function stripAnnotationLinks(text: string): StripLinksResult {
	let stripped = 0;
	const output = text.replace(CITATION_LINK_RE, (_whole, citeText) => {
		stripped++;
		return `[${citeText}]`;
	});
	return { output, stripped };
}

/* ------------------------------------------------------------------ */
/*  The actual text transformation                                    */
/* ------------------------------------------------------------------ */

export interface ConvertResult {
	output: string;
	converted: number;
	unresolved: number;
}

export async function convertZoteroCitations(
	text: string,
	resolver: CitekeyResolver,
	linkTarget: "pdf" | "select"
): Promise<ConvertResult> {
	// First pass: collect every item that needs a citekey lookup.
	const toResolve: ResolveItem[] = [];
	CLUSTER_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CLUSTER_RE.exec(text)) !== null) {
		const selectRefs = parseSelectRefs(m[1]);
		for (const ref of selectRefs) {
			toResolve.push({
				itemKey: ref.itemKey,
				libPath: ref.libPath,
				displayText: ref.text,
			});
		}
	}

	if (toResolve.length === 0) {
		return { output: text, converted: 0, unresolved: 0 };
	}

	await resolver.prepare(toResolve);

	let converted = 0;
	let unresolved = 0;

	const output = text.replace(
		CLUSTER_RE,
		(_whole: string, selectPart: string, pdfPart: string) => {
			const selectRefs = parseSelectRefs(selectPart);
			const pdfRefs = parsePdfRefs(pdfPart);
		// NOTE: pdf refs can't be matched to select refs by item key - the
		// open-pdf link's item key is the PDF *attachment*, a different item
		// from the parent that the select link points at. Zotero always
		// emits the select-links and the pdf-links in the same order within
		// a cluster, so we pair them positionally instead.

		const parts: string[] = [];
		for (let i = 0; i < selectRefs.length; i++) {
			const ref = selectRefs[i];
			const citekey = resolver.resolve({
				itemKey: ref.itemKey,
				libPath: ref.libPath,
				displayText: ref.text,
			});

			if (!citekey) {
				unresolved++;
				// Leave this one exactly as Zotero produced it, but keep it
				// individually paren-wrapped - CLUSTER_RE requires that
				// wrapping to recognize it as a convertible cluster, so a
				// future run (e.g. after the citekey is added to the bib
				// file) can still pick it up.
				parts.push(`(${ref.raw})`);
				continue;
			}

			const suffix = extractSuffix(ref.text);
			const citeText = suffix ? `@${citekey}, ${suffix}` : `@${citekey}`;
			const pdf = pdfRefs[i];

			let url: string;
			if (pdf && linkTarget === "pdf") {
				url = `zotero://open-pdf/${pdf.libPath}/items/${pdf.itemKey}?page=${pdf.page}&annotation=${pdf.annotation}`;
			} else {
				url = `zotero://select/${ref.libPath}/items/${ref.itemKey}`;
			}

			parts.push(`[${citeText}](${url})`);
			converted++;
		}

			return parts.join("; ");
		}
	);

	return { output, converted, unresolved };
}
