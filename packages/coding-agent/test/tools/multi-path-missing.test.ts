import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";

// Regression for tool reports #208 (find) and #209 (search): a multi-path call
// that includes an entry which does not exist on disk must not abort the whole
// lookup. The tool should skip the missing entry and return matches from the
// surviving entries, with a non-fatal "skipped missing paths" notice.

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

describe("multi-path tools tolerate missing entries", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-multi-path-missing-"));
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
		await Bun.write(path.join(tempDir, "src", "alpha.ts"), "shared-needle alpha\n");
		await Bun.write(path.join(tempDir, "src", "beta.ts"), "shared-needle beta\n");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("search returns matches from existing paths and reports the missing one", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "search");
		if (!tool) throw new Error("Missing search tool");

		const result = await tool.execute("search-multi-missing", {
			pattern: "shared-needle",
			paths: ["src/", "tests/"],
		});

		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[] } | undefined;

		expect(text).toContain("shared-needle alpha");
		expect(text).toContain("shared-needle beta");
		expect(text).toContain("Skipped missing paths: tests/");
		expect(details?.fileCount).toBe(2);
		expect(details?.missingPaths).toEqual(["tests/"]);
	});

	it("search errors only when every path is missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "search");
		if (!tool) throw new Error("Missing search tool");

		const promise = tool.execute("search-all-missing", {
			pattern: "shared-needle",
			paths: ["does-not-exist/", "also-missing/"],
		});

		await expect(promise).rejects.toThrow(/Path not found.*does-not-exist.*also-missing/s);
	});

	it("find returns matches from existing globs and reports the missing one", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "find");
		if (!tool) throw new Error("Missing find tool");

		const result = await tool.execute("find-multi-missing", {
			paths: ["src/**/*.ts", "tests/**/*.ts"],
		});

		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[] } | undefined;

		expect(text).toContain("src/alpha.ts");
		expect(text).toContain("src/beta.ts");
		expect(text).toContain("Skipped missing paths: tests/**/*.ts");
		expect(details?.fileCount).toBe(2);
		expect(details?.missingPaths).toEqual(["tests/**/*.ts"]);
	});

	it("find errors only when every glob's base directory is missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "find");
		if (!tool) throw new Error("Missing find tool");

		const promise = tool.execute("find-all-missing", {
			paths: ["nope/**/*.ts", "also-nope/**/*.ts"],
		});

		await expect(promise).rejects.toThrow(/Path not found.*nope.*also-nope/s);
	});
});
