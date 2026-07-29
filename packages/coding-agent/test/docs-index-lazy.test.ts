import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { EMBEDDED_DOC_FILENAMES, EMBEDDED_DOCS } from "../src/internal-urls/docs-index.generated";

function runBunEval(script: string) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "-e", script],
		cwd: path.join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	expect(result.exitCode, stderr || stdout).toBe(0);
	return stdout;
}

const DOCS_DIR = path.join(import.meta.dir, "../../../docs");
const REGENERATE_HINT = "run: bun --cwd=packages/coding-agent run generate-docs-index";

// Mirrors how scripts/generate-docs-index.ts derives the corpus: a recursive .md
// scan of docs/, POSIX-separated and sorted. Deriving it here rather than pinning
// a list is what makes the parity assertions below a drift gate instead of a
// reminder to update two hand-maintained filenames.
async function scanDocsCorpus(): Promise<string[]> {
	const entries: string[] = [];
	for await (const relativePath of new Bun.Glob("**/*.md").scan(DOCS_DIR)) {
		entries.push(relativePath.split(path.sep).join("/"));
	}
	return entries.sort();
}

describe("internal-urls docs index loading", () => {
	it("does not load the generated docs corpus when importing the barrel", () => {
		const stdout = runBunEval(`
			const marker = Symbol.for("gjc.docs-index.generated.loaded");
			Reflect.deleteProperty(globalThis, marker);
			await import("@gajae-code/coding-agent/internal-urls");
			const loaded = Reflect.get(globalThis, marker) === true;
			console.log(JSON.stringify({ loaded }));
		`);
		const result = JSON.parse(stdout.trim()) as { loaded: boolean };

		expect(result.loaded).toBe(false);
	});

	it("loads the generated docs corpus when resolving gjc docs", () => {
		const stdout = runBunEval(`
			const { InternalUrlRouter } = await import("@gajae-code/coding-agent/internal-urls");
			const resource = await InternalUrlRouter.instance().resolve("gjc://");
			console.log(JSON.stringify({
				contentType: resource.contentType,
				contentLength: resource.content.length,
			}));
		`);
		const result = JSON.parse(stdout.trim()) as { contentType: string; contentLength: number };
		expect(result.contentType).toBe("text/markdown");
		expect(result.contentLength).toBeGreaterThan(0);
	});

	it("embeds exactly the docs corpus that exists on disk", async () => {
		const onDisk = await scanDocsCorpus();

		expect(
			[...EMBEDDED_DOC_FILENAMES],
			`docs corpus changed without regenerating the index; ${REGENERATE_HINT}`,
		).toEqual(onDisk);
		expect(
			Object.keys(EMBEDDED_DOCS).sort(),
			`embedded doc keys drifted from the corpus; ${REGENERATE_HINT}`,
		).toEqual(onDisk);
	});

	it("keeps every embedded doc byte-identical to its source", async () => {
		const onDisk = await scanDocsCorpus();
		const sources = await Promise.all(
			onDisk.map(async fileName => ({
				fileName,
				source: await Bun.file(path.join(DOCS_DIR, fileName)).text(),
			})),
		);
		const stale = sources
			.filter(({ fileName, source }) => EMBEDDED_DOCS[fileName] !== source)
			.map(({ fileName }) => fileName);

		expect(stale, `stale embedded docs index for ${stale.join(", ") || "(none)"}; ${REGENERATE_HINT}`).toEqual([]);
	});
});
