import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";
import { resolveExplicitSearchPaths } from "@gajae-code/coding-agent/tools/path-utils";

const isWindows = process.platform === "win32";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe.skipIf(isWindows)("resolveExplicitSearchPaths cross-tree degeneracy", () => {
	it("returns per-path targets when commonBasePath collapses to filesystem root", async () => {
		// Two real top-level directories that exist on every Unix host. Their only
		// shared ancestor is `/`. A naive shared-base scan would walk the entire
		// filesystem; the resolver must surface explicit `targets` so callers can
		// fan out instead.
		const cwd = os.tmpdir();
		const resolved = await resolveExplicitSearchPaths(["/tmp", "/usr"], cwd);

		expect(resolved).toBeDefined();
		if (!resolved) throw new Error("expected resolveExplicitSearchPaths to resolve");
		expect(resolved.basePath).toBe(path.parse(resolved.basePath).root);
		expect(resolved.targets).toBeDefined();
		const targetBases = (resolved.targets ?? []).map(target => target.basePath).sort();
		expect(targetBases).toEqual(["/tmp", "/usr"]);
	});
});

describe.skipIf(isWindows)("search across unrelated filesystem trees", () => {
	let dirA: string;
	let dirB: string;
	let cwd: string;

	beforeEach(async () => {
		// Place fixtures in two unrelated top-level subtrees so their only shared
		// ancestor is the filesystem root. Without the multi-target fanout, the
		// search tool would scan from `/` and walk the entire filesystem.
		dirA = await fs.mkdtemp(path.join("/tmp", "pi-search-multi-A-"));
		dirB = await fs.mkdtemp(path.join("/var/tmp", "pi-search-multi-B-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-multi-cwd-"));
		await Bun.write(path.join(dirA, "alpha.txt"), "shared-needle alpha\n");
		await Bun.write(path.join(dirB, "beta.txt"), "shared-needle beta\n");
	});

	afterEach(async () => {
		await Promise.all([
			fs.rm(dirA, { recursive: true, force: true }),
			fs.rm(dirB, { recursive: true, force: true }),
			fs.rm(cwd, { recursive: true, force: true }),
		]);
	});

	it("returns matches from both trees without rooting the scan at /", async () => {
		const tools = await createTools(createTestSession(cwd));
		const tool = tools.find(entry => entry.name === "search");
		if (!tool) throw new Error("Missing search tool");

		const start = performance.now();
		const result = await tool.execute("search-cross-tree", {
			pattern: "shared-needle",
			paths: [dirA, dirB],
		});
		const durationMs = performance.now() - start;

		const text = getText(result);
		const details = result.details as { fileCount?: number; matchCount?: number } | undefined;

		expect(text).toContain("shared-needle alpha");
		expect(text).toContain("shared-needle beta");
		expect(details?.fileCount).toBe(2);
		expect(details?.matchCount).toBe(2);
		// Defense-in-depth: a regression that re-roots the scan at `/` typically
		// takes seconds. Two-fixture targeted scans complete in well under a
		// second on every supported platform.
		expect(durationMs).toBeLessThan(5000);
	});

	it("multi-path search with generous timeout completes without hanging (issue #7892)", async () => {
		const tools = await createTools(createTestSession(cwd));
		const tool = tools.find(entry => entry.name === "search");
		if (!tool) throw new Error("Missing search tool");

		const start = performance.now();
		const result = await tool.execute("search-timeout-test", {
			pattern: "shared-needle",
			paths: [dirA, dirB],
			timeout: 30, // 30 seconds — well above typical grep time
		});
		const durationMs = performance.now() - start;

		const text = getText(result);
		const details = result.details as { fileCount?: number; matchCount?: number } | undefined;

		// Verify both directories were searched and both matches were found
		expect(text).toContain("shared-needle alpha");
		expect(text).toContain("shared-needle beta");
		expect(details?.fileCount).toBe(2);
		expect(details?.matchCount).toBe(2);
		// Should not hang; complete reasonably quickly
		expect(durationMs).toBeLessThan(10000);
	});
});
