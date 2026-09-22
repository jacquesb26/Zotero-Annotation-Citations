# Zotero Annotation Citations

An Obsidian plugin that converts an annotation pasted from Zotero to a Pandoc citation while maintaining the link to the annotation in Zotero. Zotero links can be bulk removed when the document is ready to be shared, leaving only the Pandoc citations.

You get the deep link functionality of Zotero annotations so you can refer back to sources while researching/writing, but with Pandoc formatted citations for when the document is ready to publish. 

**Before** (what Zotero's drag-and-drop gives you):

```
([Smith, 2020, p. 5](zotero://select/library/items/ABCD1234)) ([pdf](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678))
```

Rendered in Obsidian:

> (Smith, 2020, p. 5) (pdf)

**After** (what this plugin turns it into):

```
[@smith2020, p. 5](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678)
```

Rendered in Obsidian:

> @smith2020, p. 5

The result is the Pandoc citation with the BetterBibTex citation key, linked 
straight to the highlighted annotation in Zotero. `@smith2020` is a real Pandoc
citation, so Pandoc renders it normally in exported documents once the
link has been removed (see [Usage](#usage) below).


## Rationale
Using Zotero Quick Copy + the Better BibTeX plugin (Settings > "Quick Copy") you can copy + paste Pandoc style citations for library **items**. Using the excellent [jpeacock29/zotero-cite-links](https://github.com/jpeacock29/zotero-cite-links) Obsidian plugin you can click these Pandoc citations and be linked to the item in Zotero. 

However, this only works for library items, not **highlights and other annotations**. This plugin addresses that gap. It starts from what Zotero actually hands you on drag-and-drop (or pasted) annotation and converts it to Pandoc citation style, without losing the annotation-level link. 

## How it works

Turning `ITEMKEY` into `@citekey` needs a citekey source. Two are supported:

1. **Better BibTeX (live Zotero)** — the plugin talks to Zotero over
   Better BibTeX's local JSON-RPC API (`item.citationkey`) and gets an exact
   answer. Requires Zotero to be running with the
   [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin
   installed. This is the default and the recommended mode.
2. **A local `.bib` file** — works offline / without Zotero running. The
   plugin parses the `.bib` file itself and matches each citation by author
   surname + year (the only information Zotero's drag-and-drop text gives
   you). This is a best-effort match: if two entries share an author surname
   and year, you'll get a Notice telling you to double-check.

## Usage

By default, conversion happens automatically: drag an annotation from
Zotero into Obsidian (or paste a copied annotation) and it's rewritten the
moment it lands, with no extra step. Anything that isn't a Zotero citation
— images, other links, plain text — is left completely untouched; the
plugin only intercepts input that actually matches Zotero's citation
format.

If you turn "Convert automatically" off in settings, or you have older
Zotero links already sitting in a note, these commands are also available
from the command palette:

- **Convert Zotero annotation links to Pandoc citations (selection)** —
  converts only the current selection (or the whole note if nothing is
  selected).
- **Convert Zotero annotation links to Pandoc citations (whole note)** —
  converts every match in the active file.
- **Remove annotation links from Pandoc citations (whole note, for
  export)** — once a note is ready to export and you no longer need the
  click-through-to-annotation links, this strips the `zotero://` link back
  out of every citation, turning `[@smith2020, p. 5](zotero://...)` into a
  plain `[@smith2020, p. 5]` — a normal Pandoc citation with nothing
  Zotero-specific left in it.

Either way, a Notice reports how many citations were converted (or how many
links were removed) and flags any that couldn't be resolved (left untouched
so you don't lose data).

Both your personal library and group libraries are handled — `groups/<id>`
paths are preserved in the resulting link. Multiple annotations dragged in
together (`([A, 2020, p.1](...); [B, 2019, p.2](...)) ([pdf](...)) ([pdf](...))`)
are all converted in one pass.

## Settings

- **Citekey source** — Better BibTeX vs. local `.bib` file.
- **Better BibTeX port** — defaults to `23119`.
- **.bib file path** — absolute path to your exported `.bib` file (e.g.
  `/Users/you/Zotero/library.bib`)
- **Link target** — link to the PDF annotation (default) or just the Zotero
  item.

## Installing

This isn't on the community plugin store. To install manually:

1. Copy `main.js`, `manifest.json`, and (if present) `styles.css` into
   `<your vault>/.obsidian/plugins/zotero-annotation-to-pandoc/`.
2. Reload Obsidian (or use the "Reload app without saving" command) and
   enable the plugin under Settings → Community plugins.

## Building from source

```bash
npm install
npm run build
```

`main.js` is produced by esbuild from `main.ts` and `transform.ts`.
`transform.ts` holds all the parsing/matching logic and has no dependency
on Obsidian, so it can be tested standalone — see `test.mjs`
(`node test.mjs`) for a set of regression checks covering multi-author
citations, group libraries, multi-annotation drags, and both citekey
sources.

## Troubleshooting

**"Could not reach Zotero / Better BibTeX" even though Zotero is running.**

- Confirm Better BibTeX is actually installed and enabled (Zotero → Tools
  → Add-ons), not just Zotero itself.
- Confirm the port matches — Better BibTeX's preferences (Advanced) let you
  change it from the default `23119`.
- Check for something else on your machine intercepting `127.0.0.1:23119`
  (a firewall, another app, a VPN with local-traffic inspection).
- If it's still broken, switch to the `.bib` file mode as a workaround.

## Known limitations

- Desktop only (it talks to a local port for Better BibTeX and reads files
  directly).
- The `.bib` file mode matches by author surname + year only, since that's
  all the information present in Zotero's drag-and-drop text. If your
  library has two same-year items by authors with the same surname, use the
  Better BibTeX mode instead for an exact match.

## Disclosures

- **Network use.** In "Better BibTeX (live Zotero)" mode, the plugin sends
  local HTTP requests to `http://127.0.0.1:<port>` (default `23119`) — the
  port Zotero's Better BibTeX add-on listens on — to ask it for the citekey
  of an item via its JSON-RPC API. No data leaves your machine; this never
  talks to anything outside `127.0.0.1`.
- **Accessing files outside the vault.** In "Local .bib file" mode, the
  plugin reads the `.bib` file at the absolute path you give it in
  settings, which is typically outside your vault (e.g. wherever Zotero/
  Better BibTeX exports your library to). This is needed so the plugin can
  look up citekeys without Zotero running. Desktop only, since it relies on
  Node's filesystem API.

## License

[MIT](LICENSE)
