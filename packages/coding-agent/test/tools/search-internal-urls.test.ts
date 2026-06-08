import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler } from "@gajae-code/coding-agent/internal-urls";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { FindTool } from "@gajae-code/coding-agent/tools/find";
import { SearchTool } from "@gajae-code/coding-agent/tools/search";
import { AgentRegistry } from "../../src/registry/agent-registry";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("SearchTool internal URL resolution", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir);

		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();

		// Register a synthetic main session so artifact:// can derive
		// `artifactsDir` from its sessionFile (sessionFile.slice(0,-6)).
		AgentRegistry.global().register({
			id: "test-main",
			displayName: "test",
			kind: "main",
			session: null,
			sessionFile: `${artifactsDir}.jsonl`,
		});
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
			...overrides,
		};
	}

	it("resolves artifact:// URL to backing file and greps it", async () => {
		const content = "line one\nfound the needle here\nline three\n";
		await Bun.write(path.join(artifactsDir, "5.bash.log"), content);

		const session = createSession();
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["artifact://5"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
	});

	it("greps artifact:// with regex pattern", async () => {
		const content = "ERROR: connection refused\nWARN: timeout\nERROR: disk full\nINFO: ok\n";
		await Bun.write(path.join(artifactsDir, "3.python.log"), content);

		const session = createSession();
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "ERROR.*",
			paths: ["artifact://3"],
		});

		const text = getResultText(result);
		expect(text).toContain("connection refused");
		expect(text).toContain("disk full");
		expect(text).not.toContain("timeout");
		expect(text).not.toContain("INFO");
	});

	it("throws when internal URL has no sourcePath", async () => {
		const session = createSession();
		const tool = new SearchTool(session);

		expect(tool.execute("test-call", { pattern: "foo", paths: ["artifact://999"] })).rejects.toThrow(
			"artifact://999 not found",
		);
	});

	it("falls back to normal path resolution when no internalRouter", async () => {
		await Bun.write(path.join(tmpDir, "test.txt"), "hello world\n");

		const session = createSession();
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "hello",
			paths: ["test.txt"],
		});

		const text = getResultText(result);
		expect(text).toContain("hello");
	});

	it("falls back to normal resolution for non-internal URLs", async () => {
		await Bun.write(path.join(tmpDir, "data.log"), "some data here\n");

		const session = createSession();
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "data",
			paths: ["data.log"],
		});

		const text = getResultText(result);
		expect(text).toContain("data");
	});

	it("suppresses hashline anchors when searching immutable artifact:// sources", async () => {
		const content = "alpha line\nbeta needle line\ngamma line\n";
		await Bun.write(path.join(artifactsDir, "9.bash.log"), content);

		const session = createSession({ hasEditTool: true });
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["artifact://9"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// No hashline anchors (LINE+ID|content) for immutable sources
		expect(text).not.toMatch(/^\*?\s*\d+[a-z]{2}\|/m);
	});

	it("resolves local:// URLs before file-name lookup", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "PLAN.md"), "# Plan\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession();
		const tool = new FindTool(session);

		const result = await tool.execute("test-call", {
			paths: ["local://PLAN.md"],
		});

		const text = getResultText(result);
		expect(text).toContain("PLAN.md");
	});

	it("keeps hashline anchors when searching mutable local:// sources", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "plan.md"), "alpha line\nbeta needle line\ngamma line\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession({ hasEditTool: true });
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["local://plan.md"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// Hashline anchor (LINE+ID|content) is kept for mutable local:// sources
		expect(text).toMatch(/^\*?\s*\d+[a-z]{2}\|/m);
	});

	it("keeps hashlines on mutable files when mixed with immutable artifact:// inputs", async () => {
		const content = "alpha line\nbeta needle line\ngamma line\n";
		await Bun.write(path.join(artifactsDir, "11.bash.log"), content);
		await Bun.write(path.join(tmpDir, "mixed.txt"), "mixed needle line\n");

		const session = createSession({ hasEditTool: true });
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["artifact://11", "mixed.txt"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// Mutable mixed.txt keeps hashlines somewhere in the output
		expect(text).toMatch(/^\*?\s*\d+[a-z]{2}\|.*mixed needle/m);
	});

	it("throws on nonexistent artifact ID", async () => {
		const session = createSession();
		const tool = new SearchTool(session);

		expect(tool.execute("test-call", { pattern: "foo", paths: ["artifact://999"] })).rejects.toThrow(
			"artifact://999 not found",
		);
	});
});
