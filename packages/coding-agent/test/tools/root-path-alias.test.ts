import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolChoiceQueue } from "@gajae-code/coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";
import { resolveToCwd } from "@gajae-code/coding-agent/tools/path-utils";

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

describe("tool path root alias", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-root-alias-"));
		await Bun.write(path.join(tempDir, "search.txt"), "root-alias-needle\n");
		await Bun.write(
			path.join(tempDir, "sample.ts"),
			"const rootAliasSymbol = 1;\nlegacyWrap(rootAliasSymbol, anotherValue);\n",
		);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("resolves a bare slash to the session cwd", () => {
		expect(resolveToCwd("/", tempDir)).toBe(tempDir);
		expect(resolveToCwd("///", tempDir)).toBe(tempDir);
	});

	it("rejects local:/ (single-slash) as an internal URL", () => {
		expect(() => resolveToCwd("local:/PLAN.md", tempDir)).toThrow("internal scheme");
	});

	it("rejects local:// as an internal URL", () => {
		expect(() => resolveToCwd("local://PLAN.md", tempDir)).toThrow("internal scheme");
	});

	it("rejects @local:/ (at-prefix single-slash) as an internal URL", () => {
		expect(() => resolveToCwd("@local:/PLAN.md", tempDir)).toThrow("internal scheme");
	});

	it("rejects @local:// (at-prefix double-slash) as an internal URL", () => {
		expect(() => resolveToCwd("@local://PLAN.md", tempDir)).toThrow("internal scheme");
	});

	it("searches from cwd when path is slash", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "search");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing search tool");

		const result = await tool.execute("search-root-alias", {
			pattern: "root-alias-needle",
			paths: ["/"],
		});
		const details = result.details as { scopePath?: string } | undefined;

		expect(getText(result)).toContain("search.txt");
		expect(details?.scopePath).toBe(".");
	});

	it("reads cwd when path is slash", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-root-alias", {
			path: "/",
		});
		const text = getText(result);
		expect(text).toContain("search.txt");
		expect(text).toContain("sample.ts");
	});

	it("finds from cwd when pattern is slash", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "find");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing find tool");

		const result = await tool.execute("find-root-alias", {
			paths: ["/"],
		});
		const details = result.details as { scopePath?: string } | undefined;
		const text = getText(result);

		expect(details?.scopePath).toBe(".");
		expect(text).toContain("search.txt");
		expect(text).toContain("sample.ts");
	});

	it("ast_grep searches cwd when path is slash", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		const result = await tool.execute("ast-grep-root-alias", {
			pat: "rootAliasSymbol",
			paths: ["/**/*.ts"],
		});
		const details = result.details as { scopePath?: string } | undefined;

		expect(getText(result)).toContain("sample.ts");
		expect(details?.scopePath).toBe(".");
	});

	it("ast_edit rewrites within cwd when path is slash", async () => {
		const queue = new ToolChoiceQueue();
		const tools = await createTools(
			createTestSession(tempDir, {
				getToolChoiceQueue: () => queue,
				buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
			}),
		);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_edit tool");

		const preview = await tool.execute("ast-edit-root-alias", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["/**/*.ts"],
		});
		const details = preview.details as { scopePath?: string; totalReplacements?: number } | undefined;

		expect(getText(preview)).toContain("sample.ts");
		expect(details?.scopePath).toBe(".");
		expect(details?.totalReplacements).toBe(1);

		queue.nextToolChoice();
		const invoker = queue.peekInFlightInvoker()!;
		expect(invoker).toBeDefined();
		await invoker({ action: "apply", reason: "apply root alias rewrite" });

		expect(await Bun.file(path.join(tempDir, "sample.ts")).text()).toContain(
			"modernWrap(rootAliasSymbol, anotherValue)",
		);
	});
});
