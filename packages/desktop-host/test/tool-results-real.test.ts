/**
 * Real SDK tool results through the desktop row projection and `tool.detail`. The projection reads
 * argument names, `details` shapes and, for two statuses, result text that the SDK does not type
 * for embedders; synthetic fixtures would keep passing if any of those changed. Only the model is
 * scripted: the tools, the agent loop and the results are the SDK's own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createAgentSession, createEmbeddedAgentSession } from "@gajae-code/coding-agent/sdk";
import { projectMessages } from "../src/message-projection";
import type { DesktopMessage } from "../src/protocol";
import { projectToolDetail, toolResultStatus } from "../src/tool-projection";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	content: [{ type: "toolCall" as const, id, name, arguments: args }],
});

/** Runs one scripted turn of real tool calls, stopping the last (a long command) while it runs. */
async function runTools() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desktop-real-tools-")));
	const agentDir = path.join(directory, "agent");
	const cwd = path.join(directory, "project");
	await Bun.write(
		path.join(agentDir, "model-presets", "control.json"),
		JSON.stringify({ version: 1, disabled: true }),
	);
	await Bun.write(path.join(agentDir, "config.yml"), "startup:\n  networkPrewarm: false\n");
	await Bun.write(path.join(cwd, "src", "app.ts"), "export const one = 1;\nexport const two = 2;\n");
	const api = `desktop-real-tools-${crypto.randomUUID()}`;
	const model = createMockModel({
		provider: "desktop-real-tools-fixture",
		responses: [
			call("read_1", "read", { path: "src/app.ts" }),
			call("edit_1", "edit", {
				path: "src/app.ts",
				edits: [{ old_text: "export const two = 2;", new_text: "export const two = 22;\nexport const three = 3;" }],
			}),
			call("edit_2", "edit", { path: "src/app.ts", edits: [{ old_text: "no such text", new_text: "x" }] }),
			call("write_1", "write", { path: "notes/plan.md", content: "one\ntwo\n" }),
			call("bash_1", "bash", { command: "echo hello" }),
			call("bash_2", "bash", { command: "echo out; exit 3" }),
			call("search_1", "search", { pattern: "const", paths: ["src"] }),
			call("find_1", "find", { paths: ["src/*.ts"] }),
			call("bash_3", "bash", { command: "sleep 30" }),
			{ content: ["done"] },
		],
	});
	Object.defineProperty(model, "api", { value: api });
	registerCustomApi(api, model.stream, api);
	const owner = await createEmbeddedAgentSession({
		cwd,
		agentDir,
		storage: { persist: false },
		model,
		systemPrompt: ["Test"],
		toolNames: ["read", "edit", "write", "bash", "search", "find"],
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMcpAutoload: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferModelProfileActivation: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		createSession: options => {
			options.settings?.set("compaction.enabled", false);
			options.settings?.set("retry.enabled", false);
			options.settings?.set("async.enabled", false);
			// The replace edit names its file in `path`; other edit modes are covered by fixtures.
			options.settings?.set("edit.mode", "replace");
			return createAgentSession(options);
		},
	});
	const session = owner.session;
	session.modelRegistry.authStorage.setRuntimeApiKey(model.provider, "fixture-only");
	cleanups.push(async () => {
		try {
			await session.dispose();
			await owner.releaseResources();
		} finally {
			unregisterCustomApis(api);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	const started = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "tool_execution_start" && event.toolCallId === "bash_3") started.resolve();
	});
	const turn = session.prompt("use the tools");
	await started.promise;
	await session.abort();
	await turn.catch(() => {});
	await session.awaitSessionSettlement();
	unsubscribe();
	return { session, cwd };
}

/** The first text block of a real result, which two statuses are read from. */
function resultText(message: unknown): string {
	const content = (message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content.find(block => block.type === "text")?.text ?? "";
}

describe("real SDK tool results", () => {
	test("project to the family, subject, stats and status of each call, and to their details", async () => {
		const { session, cwd } = await runTools();
		const results = new Map(
			session.messages
				.filter(message => message.role === "toolResult")
				.map(message => [(message as { toolCallId: string }).toolCallId, message]),
		);
		expect([...results.keys()]).toEqual([
			"read_1",
			"edit_1",
			"edit_2",
			"write_1",
			"bash_1",
			"bash_2",
			"search_1",
			"find_1",
			"bash_3",
		]);

		// Two statuses exist only as SDK result text; if this wording changes, update
		// `toolResultStatus` and `exitCode` in tool-projection.ts to match the SDK again.
		expect(resultText(results.get("bash_3"))).toStartWith("Tool execution was aborted");
		expect(resultText(results.get("bash_2"))).toEndWith("Command exited with code 3");
		expect(toolResultStatus(results.get("bash_3"))).toBe("cancelled");

		const rows = new Map(
			projectMessages(session.messages, text => text, 500_000, { sessionGeneration: 1 })
				.filter((message): message is DesktopMessage & { tool: NonNullable<DesktopMessage["tool"]> } =>
					Boolean(message.tool),
				)
				.map(message => [message.tool.callId, message.tool]),
		);
		const row = (id: string) => {
			const tool = rows.get(id);
			return tool && { family: tool.family, subject: tool.subject, stats: tool.stats, status: tool.status };
		};
		expect(row("read_1")).toEqual({ family: "read", subject: "src/app.ts", stats: undefined, status: "done" });
		expect(row("edit_1")).toEqual({
			family: "edit",
			subject: "src/app.ts",
			stats: { added: 2, removed: 1 },
			status: "done",
		});
		expect(row("edit_2")).toMatchObject({ family: "edit", subject: "src/app.ts", status: "failed" });
		expect(row("write_1")).toEqual({
			family: "write",
			subject: "notes/plan.md",
			stats: { added: 2 },
			status: "done",
		});
		expect(row("bash_1")).toEqual({ family: "shell", subject: "$ echo hello", stats: undefined, status: "done" });
		expect(row("bash_2")).toEqual({
			family: "shell",
			subject: "$ echo out; exit 3",
			stats: { exitCode: 3 },
			status: "failed",
		});
		expect(row("search_1")).toEqual({
			family: "search",
			subject: "const · src",
			stats: { matches: 3, files: 1 },
			status: "done",
		});
		expect(row("find_1")).toEqual({ family: "find", subject: "src/*.ts", stats: { files: 1 }, status: "done" });
		expect(row("bash_3")).toEqual({ family: "shell", subject: "$ sleep 30", stats: undefined, status: "cancelled" });
		expect([...rows.values()].every(tool => tool.detail)).toBe(true);

		const detail = (id: string) => projectToolDetail(session, undefined, id, text => text);
		expect(detail("edit_1").diff).toEqual([
			{
				path: path.join(cwd, "src", "app.ts"),
				diff: " 1|export const one = 1;\n-2|export const two = 2;\n+2|export const two = 22;\n+3|export const three = 3;",
				added: 2,
				removed: 1,
			},
		]);
		expect(detail("write_1").diff).toEqual([{ path: "notes/plan.md", diff: "+1|one\n+2|two", added: 2, removed: 0 }]);
		expect(detail("bash_1")).toEqual({ callId: "bash_1", command: "echo hello" });
		expect(detail("search_1").args).toBe(JSON.stringify({ pattern: "const", paths: ["src"] }, null, 2));
	}, 60_000);
});
