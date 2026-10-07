// A/B adapter for the HTML-to-Markdown entrypoint used by read/fetch previews.
import { htmlToMarkdown } from "@gajae-code/natives";
import { runAbSuite } from "./ab-adapter";

const ARTICLE_HTML = `<!doctype html><html><body><nav><a href="/home">Home</a></nav><main><h1>Benchmark article</h1>${Array.from(
	{ length: 16 },
	(_, index) =>
		`<section><h2>Section ${index + 1}</h2><p>This section contains <strong>formatted text</strong>, a <a href="/reference/${index}">reference link</a>, and a deterministic conversion workload.</p><ul><li>First item ${index}</li><li>Second item ${index + 1}</li></ul></section>`,
).join("")}</main><footer>Navigation and footer text are removed by read preview cleanup.</footer></body></html>`;

const TABLE_HTML = `<!doctype html><html><body><nav>Site navigation</nav><main><h1>Inventory</h1><table><thead><tr><th>File</th><th>Status</th><th>Lines</th></tr></thead><tbody>${Array.from(
	{ length: 24 },
	(_, index) => `<tr><td>src/module-${index}.ts</td><td>${index % 2 ? "unchanged" : "modified"}</td><td>${100 + index}</td></tr>`,
).join("")}</tbody></table></main><footer>End of report</footer></body></html>`;

async function convert(html: string): Promise<void> {
	const markdown = await htmlToMarkdown(html, { cleanContent: true });
	if (!markdown.trim()) throw new Error("HTML fixture produced no Markdown output");
}

await runAbSuite(
	"read-html",
	[
		{ id: "H01", run: async () => await convert(ARTICLE_HTML) },
		{ id: "H02", run: async () => await convert(TABLE_HTML) },
	],
	100,
);
