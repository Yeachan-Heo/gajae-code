import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolChoiceQueue } from "@gajae-code/coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";
import { WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE } from "../../src/skill-state/workflow-mutation-guard";
import { resolveAstEditPreviewWritePaths } from "../../src/tools/ast-edit-write-path";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("ast_edit apply .gjc realpath", () => {
	it("refuses a src symlink to .gjc and leaves the real file bytes unchanged", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-gjc-realpath-"));
		try {
			const workspace = path.join(root, "workspace");
			const cwd = path.join(root, "via");
			await fs.mkdir(workspace);
			await fs.symlink(workspace, cwd, "dir");
			const realFile = path.join(workspace, ".gjc", "agent-state.ts");
			await fs.mkdir(path.dirname(realFile), { recursive: true });
			const original = Buffer.from("legacyWrap(x, value)\n");
			await Bun.write(realFile, original);
			await fs.symlink(".gjc", path.join(cwd, "src"), "dir");

			const realPaths = await resolveAstEditPreviewWritePaths(cwd, ["src/agent-state.ts"]);
			expect(realPaths).toEqual(["src/agent-state.ts", path.resolve(cwd, ".gjc", "agent-state.ts")]);
			const missing = await resolveAstEditPreviewWritePaths(cwd, ["src/new-state.ts"]);
			expect(missing).toEqual(["src/new-state.ts", path.resolve(cwd, ".gjc", "new-state.ts")]);

			const queue = new ToolChoiceQueue();
			const tools = await createTools(
				createTestSession(cwd, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
				}),
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const preview = await tool!.execute("ast-edit-gjc-realpath", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["src/agent-state.ts"],
			});
			expect((preview.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);

			queue.nextToolChoice();
			const invoker = queue.peekInFlightInvoker();
			expect(invoker).toBeDefined();
			await expect(invoker!({ action: "apply", reason: "apply symlink alias of .gjc" })).rejects.toThrow(
				WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE,
			);

			expect(Buffer.compare(await fs.readFile(await fs.realpath(realFile)), original)).toBe(0);
			await expect(fs.access(path.join(workspace, ".gjc", "new-state.ts"))).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("refuses a direct .gjc preview when .gjc is a symlink to an in-workspace directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-gjc-link-"));
		try {
			const cwd = path.join(root, "workspace");
			const backing = path.join(cwd, "state");
			await fs.mkdir(backing, { recursive: true });
			await fs.symlink("state", path.join(cwd, ".gjc"), "dir");
			const realFile = path.join(backing, "agent-state.ts");
			const original = Buffer.from("legacyWrap(x, value)\n");
			await Bun.write(realFile, original);

			const realPaths = await resolveAstEditPreviewWritePaths(cwd, [".gjc/agent-state.ts"]);
			expect(realPaths).toEqual([".gjc/agent-state.ts", path.resolve(cwd, "state", "agent-state.ts")]);

			const queue = new ToolChoiceQueue();
			const tools = await createTools(
				createTestSession(cwd, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
				}),
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const preview = await tool!.execute("ast-edit-gjc-symlink-root", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [".gjc/agent-state.ts"],
			});
			expect((preview.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);

			queue.nextToolChoice();
			const invoker = queue.peekInFlightInvoker();
			expect(invoker).toBeDefined();
			await expect(invoker!({ action: "apply", reason: "apply through a symlinked .gjc" })).rejects.toThrow(
				WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE,
			);
			expect(Buffer.compare(await fs.readFile(realFile), original)).toBe(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("still allows an ordinary edit through a symlinked workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-gjc-allow-"));
		try {
			const workspace = path.join(root, "workspace");
			const cwd = path.join(root, "via");
			const source = path.join(workspace, "src", "app.ts");
			const protectedFile = path.join(workspace, ".gjc", "agent-state.ts");
			await fs.mkdir(path.dirname(source), { recursive: true });
			await fs.mkdir(path.dirname(protectedFile), { recursive: true });
			await fs.symlink(workspace, cwd, "dir");
			const original = Buffer.from("legacyWrap(x, value)\n");
			const protectedBytes = Buffer.from("legacyWrap(secret, value)\n");
			await Bun.write(source, original);
			await Bun.write(protectedFile, protectedBytes);

			const resolved = await resolveAstEditPreviewWritePaths(cwd, ["src/app.ts"]);
			expect(resolved).toEqual(["src/app.ts"]);

			const queue = new ToolChoiceQueue();
			const tools = await createTools(
				createTestSession(cwd, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
				}),
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const preview = await tool!.execute("ast-edit-gjc-ordinary", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["src/app.ts"],
			});
			expect((preview.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);

			queue.nextToolChoice();
			const invoker = queue.peekInFlightInvoker();
			expect(invoker).toBeDefined();
			await invoker!({ action: "apply", reason: "apply ordinary file through a symlinked workspace" });

			expect(await Bun.file(source).text()).toContain("modernWrap(x, value)");
			expect(Buffer.compare(await fs.readFile(protectedFile), protectedBytes)).toBe(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
