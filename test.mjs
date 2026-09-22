import { transformSync } from "esbuild";
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const src = readFileSync("./transform.ts", "utf8");
const { code } = transformSync(src, { loader: "ts", format: "cjs" });
writeFileSync("./transform.cjs", code);

const { convertZoteroCitations, stripAnnotationLinks, BibFileResolver, CLUSTER_RE } =
	require("./transform.cjs");

let failures = 0;
function assertEqual(actual, expected, label) {
	if (actual !== expected) {
		failures++;
		console.error(`FAIL: ${label}`);
		console.error("  expected:", JSON.stringify(expected));
		console.error("  actual:  ", JSON.stringify(actual));
	} else {
		console.log(`PASS: ${label}`);
	}
}

class FakeResolver {
	constructor(map) {
		this.map = map; // itemKey -> citekey
	}
	async prepare() {}
	resolve(item) {
		return this.map[item.itemKey] ?? null;
	}
}

async function run() {
	// 1. Single annotation, personal library
	{
		const input =
			"See ([Smith, 2020, p. 5](zotero://select/library/items/ABCD1234)) ([pdf](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678)) for details.";
		const resolver = new FakeResolver({ ABCD1234: "smith2020" });
		const { output, converted, unresolved } = await convertZoteroCitations(
			input,
			resolver,
			"pdf"
		);
		assertEqual(unresolved, 0, "single annotation: no unresolved");
		assertEqual(converted, 1, "single annotation: converted count");
		assertEqual(
			output,
			"See [@smith2020, p. 5](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678) for details.",
			"single annotation: full output"
		);
	}

	// 2. Multi-author display text (commas inside author list) shouldn't break year/page extraction
	{
		const input =
			"([Smith, Jones, and Lee, 2019, pp. 5-6](zotero://select/library/items/AAAAAAAA)) ([pdf](zotero://open-pdf/library/items/AAAAAAAA?page=3&annotation=BBBBBBBB))";
		const resolver = new FakeResolver({ AAAAAAAA: "smithJonesLee2019" });
		const { output } = await convertZoteroCitations(input, resolver, "pdf");
		assertEqual(
			output,
			"[@smithJonesLee2019, pp. 5-6](zotero://open-pdf/library/items/AAAAAAAA?page=3&annotation=BBBBBBBB)",
			"multi-author: page suffix survives comma-heavy author list"
		);
	}

	// 3. Group library link, no page/locator in the display text
	{
		const input =
			"([Doe, 2018](zotero://select/groups/998877/items/GRPKEY01)) ([pdf](zotero://open-pdf/groups/998877/items/GRPKEY01?page=1&annotation=GRPANN01))";
		const resolver = new FakeResolver({ GRPKEY01: "doe2018" });
		const { output } = await convertZoteroCitations(input, resolver, "pdf");
		assertEqual(
			output,
			"[@doe2018](zotero://open-pdf/groups/998877/items/GRPKEY01?page=1&annotation=GRPANN01)",
			"group library: preserves groups/ID path, no bogus page suffix"
		);
	}

	// 4. Two annotations dragged together (Zotero concatenates with "; ")
	{
		const input =
			"([Smith, 2020, p. 5](zotero://select/library/items/ABCD1234); [Jones, 2019, p. 10](zotero://select/library/items/EFGH5678)) ([pdf](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ0001)) ([pdf](zotero://open-pdf/library/items/EFGH5678?page=20&annotation=WXYZ0002))";
		const resolver = new FakeResolver({
			ABCD1234: "smith2020",
			EFGH5678: "jones2019",
		});
		const { output, converted } = await convertZoteroCitations(
			input,
			resolver,
			"pdf"
		);
		assertEqual(converted, 2, "combined drag: converts both items");
		assertEqual(
			output,
			"[@smith2020, p. 5](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ0001); [@jones2019, p. 10](zotero://open-pdf/library/items/EFGH5678?page=20&annotation=WXYZ0002)",
			"combined drag: joined with '; ', no wrapping parens"
		);
	}

	// 5. Unresolved citekey leaves that item's original select-link untouched
	{
		const input =
			"([Nobody, 2099, p. 1](zotero://select/library/items/ZZZZZZZZ)) ([pdf](zotero://open-pdf/library/items/ZZZZZZZZ?page=1&annotation=ANNOTZZZ))";
		const resolver = new FakeResolver({});
		const { output, converted, unresolved } = await convertZoteroCitations(
			input,
			resolver,
			"pdf"
		);
		assertEqual(converted, 0, "unresolved: nothing converted");
		assertEqual(unresolved, 1, "unresolved: flagged");
		assertEqual(
			output,
			"([Nobody, 2099, p. 1](zotero://select/library/items/ZZZZZZZZ))",
			"unresolved: original select link preserved verbatim"
		);
	}

	// 6. linkTarget = "select" ignores the pdf link even when one is present
	{
		const input =
			"([Smith, 2020, p. 5](zotero://select/library/items/ABCD1234)) ([pdf](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678))";
		const resolver = new FakeResolver({ ABCD1234: "smith2020" });
		const { output } = await convertZoteroCitations(input, resolver, "select");
		assertEqual(
			output,
			"[@smith2020, p. 5](zotero://select/library/items/ABCD1234)",
			"linkTarget=select: links to the item, not the annotation"
		);
	}

	// 7. .bib file resolver: matches purely by author surname + year
	{
		const bib = `
@article{smith2020,
  author = {Smith, John},
  title = {A Great Paper},
  year = {2020},
}

@book{jonesDoe2019,
  author = {Jones, Amy and Doe, Robert},
  date = {2019-05-01},
  title = {Another Book},
}
`;
		const resolver = new BibFileResolver(async () => bib);

		const input1 =
			"([Smith, 2020, p. 5](zotero://select/library/items/ABCD1234)) ([pdf](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678))";
		const r1 = await convertZoteroCitations(input1, resolver, "pdf");
		assertEqual(r1.converted, 1, "bib resolver: converts via single-author match");
		assertEqual(
			r1.output,
			"[@smith2020, p. 5](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678)",
			"bib resolver: correct citekey substituted"
		);

		const input2 =
			"([Jones & Doe, 2019, p. 2](zotero://select/library/items/EFGH0002)) ([pdf](zotero://open-pdf/library/items/EFGH0002?page=2&annotation=WXYZ0002))";
		const r2 = await convertZoteroCitations(input2, resolver, "pdf");
		assertEqual(r2.converted, 1, "bib resolver: matches on either co-author's surname");
		assertEqual(
			r2.output,
			"[@jonesDoe2019, p. 2](zotero://open-pdf/library/items/EFGH0002?page=2&annotation=WXYZ0002)",
			"bib resolver: correct citekey for two-author entry"
		);
	}

	// 7. Realistic case: the PDF attachment's item key is DIFFERENT from the
	// parent item's key (as real Zotero drag-and-drop always produces).
	// This is the case the itemKey-matching bug missed entirely.
	{
		const input =
			"([Smith, 2020, p. 5](zotero://select/library/items/PARENT01)) ([pdf](zotero://open-pdf/library/items/ATTACH99?page=12&annotation=ANNOT007))";
		const resolver = new FakeResolver({ PARENT01: "smith2020" });
		const { output, converted, unresolved } = await convertZoteroCitations(
			input,
			resolver,
			"pdf"
		);
		assertEqual(unresolved, 0, "distinct attachment key: no unresolved");
		assertEqual(converted, 1, "distinct attachment key: converted count");
		assertEqual(
			output,
			"[@smith2020, p. 5](zotero://open-pdf/library/items/ATTACH99?page=12&annotation=ANNOT007)",
			"distinct attachment key: links to the annotation, not the parent item"
		);
	}

	// 8. Same, but with two annotations dragged together, so positional
	// pairing must keep each select-ref matched to its own pdf-ref.
	{
		const input =
			"([Smith, 2020, p. 5](zotero://select/library/items/PARENT01); [Jones, 2019, p. 10](zotero://select/library/items/PARENT02)) ([pdf](zotero://open-pdf/library/items/ATTACH01?page=12&annotation=ANNOT001)) ([pdf](zotero://open-pdf/library/items/ATTACH02?page=20&annotation=ANNOT002))";
		const resolver = new FakeResolver({
			PARENT01: "smith2020",
			PARENT02: "jones2019",
		});
		const { output, converted, unresolved } = await convertZoteroCitations(
			input,
			resolver,
			"pdf"
		);
		assertEqual(unresolved, 0, "two distinct attachments: no unresolved");
		assertEqual(converted, 2, "two distinct attachments: converted count");
		assertEqual(
			output,
			"[@smith2020, p. 5](zotero://open-pdf/library/items/ATTACH01?page=12&annotation=ANNOT001); [@jones2019, p. 10](zotero://open-pdf/library/items/ATTACH02?page=20&annotation=ANNOT002)",
			"two distinct attachments: each citation links to its own annotation"
		);
	}

	// 9. Unresolved citekey keeps its own wrapping parens so the cluster
	// is still recognized by CLUSTER_RE on a future run (e.g. once the
	// citekey has been added to the bib file).
	{
		const input =
			"([Nobody, 2099, p. 1](zotero://select/library/items/ZZZZZZZZ)) ([pdf](zotero://open-pdf/library/items/ANNZZZZZ?page=1&annotation=ANNOTZZZ))";
		const resolver = new FakeResolver({});
		const { output, converted, unresolved } = await convertZoteroCitations(
			input,
			resolver,
			"pdf"
		);
		assertEqual(converted, 0, "unresolved (no parens change): nothing converted");
		assertEqual(unresolved, 1, "unresolved (no parens change): flagged");
		assertEqual(
			output,
			"([Nobody, 2099, p. 1](zotero://select/library/items/ZZZZZZZZ))",
			"unresolved (no parens change): still individually paren-wrapped"
		);

		// Confirm it's still recognized as a convertible cluster on a
		// second pass (e.g. after the citekey is added to the resolver).
		CLUSTER_RE.lastIndex = 0;
		assertEqual(
			CLUSTER_RE.test(output),
			true,
			"unresolved (no parens change): still re-matchable by CLUSTER_RE"
		);
	}

	// 10. stripAnnotationLinks: turns converted pandoc citations back into
	// plain [@key, locator] citations, ready for export.
	{
		const input =
			"See [@smith2020, p. 5](zotero://open-pdf/library/items/ABCD1234?page=12&annotation=WXYZ5678) and " +
			"[@jones2019, p. 10](zotero://open-pdf/library/items/EFGH5678?page=20&annotation=WXYZ0002); also " +
			"[@doe2018](zotero://select/groups/998877/items/GRPKEY01) for the item-only case.";
		const { output, stripped } = stripAnnotationLinks(input);
		assertEqual(stripped, 3, "stripAnnotationLinks: strips every citation link");
		assertEqual(
			output,
			"See [@smith2020, p. 5] and [@jones2019, p. 10]; also [@doe2018] for the item-only case.",
			"stripAnnotationLinks: leaves plain pandoc citations behind"
		);
	}

	// 11. stripAnnotationLinks: leaves ordinary, non-Zotero markdown links alone
	{
		const input = "Read the [full paper](https://example.com/paper.pdf) here.";
		const { output, stripped } = stripAnnotationLinks(input);
		assertEqual(stripped, 0, "stripAnnotationLinks: no zotero links present");
		assertEqual(
			output,
			input,
			"stripAnnotationLinks: unrelated markdown links are untouched"
		);
	}

	console.log(
		failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`
	);
	process.exit(failures === 0 ? 0 : 1);
}

run();
