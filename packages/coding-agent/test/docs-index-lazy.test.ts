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

const REPO_ROOT = path.join(import.meta.dir, "../../..");
const GENERATED_INDEX = "packages/coding-agent/src/internal-urls/docs-index.generated.ts";

/** `git ls-files --error-unmatch <path>`. Exit 0 means git tracks the path. */
function isTracked(relativePath: string): boolean {
	const result = Bun.spawnSync({
		cmd: ["git", "ls-files", "--error-unmatch", "--", relativePath],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return result.exitCode === 0;
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

	/**
	 * The two assertions above compare the worktree index to the worktree docs,
	 * which is the whole contract now that the index is generated rather than
	 * committed: the root `prepare` hook rebuilds it on every `bun install`, so
	 * the worktree copy is authoritative and a stale *committed* copy cannot
	 * exist to drift from it.
	 *
	 * Keeping it untracked is what makes that true. The generator emits one line
	 * per doc — each holding an entire document as a single JSON string — so two
	 * branches editing the same doc produce a whole-line conflict that git cannot
	 * three-way merge. Tracking it reintroduces a conflict on every rebase, and
	 * because `.gitignore` only governs untracked paths, the ignore rule goes
	 * inert the moment something forces it back into the index.
	 */
	it("keeps the generated index untracked so it cannot conflict on rebase", () => {
		expect(
			isTracked(GENERATED_INDEX),
			`${GENERATED_INDEX} is committed; it is generated and gitignored. Run: git rm --cached ${GENERATED_INDEX}`,
		).toBe(false);
	});
});
