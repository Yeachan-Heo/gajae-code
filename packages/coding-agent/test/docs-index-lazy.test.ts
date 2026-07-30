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

/** `git diff --quiet HEAD -- <paths>`. Exit 0 means the worktree matches the commit. */
function matchesHead(...paths: string[]): boolean {
	const result = Bun.spawnSync({
		cmd: ["git", "diff", "--quiet", "HEAD", "--", ...paths],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	// 0 = no diff, 1 = diff. Anything else (no git, not a repo) is a real error.
	expect([0, 1], result.stderr.toString() || `git diff exited ${result.exitCode}`).toContain(result.exitCode);
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
	 * The two assertions above compare the worktree index to the worktree docs, and
	 * the root `prepare` hook regenerates the index on every `bun install` — which CI
	 * runs before any test. So a *committed* index that is stale gets silently repaired
	 * in the worktree and both assertions pass. The invariant they cannot see is
	 * `committed index == committed docs`.
	 *
	 * This closes that: if `docs/` matches HEAD but the index does not, the only thing
	 * that could have rewritten the index is the generator, which means the commit
	 * shipped a stale one. When `docs/` is itself dirty the developer is mid-edit and
	 * there is nothing to conclude, so the check yields rather than false-failing.
	 */
	it("commits an index that matches the committed docs", () => {
		if (!matchesHead("docs")) return;

		expect(
			matchesHead(GENERATED_INDEX),
			`committed docs index is stale relative to committed docs/; ${REGENERATE_HINT}`,
		).toBe(true);
	});
});
