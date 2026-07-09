import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type StopReason, type ToolCall } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { MAX_EDIT_FILE_BYTES } from "@gajae-code/coding-agent/edit/read-file";
import { AgentSession, StreamingEditFileCache } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import * as z from "zod/v4";

function createAssistantMessage(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createToolCall(id: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name: "edit", arguments: args };
}

function buildEditTool(executed: { count: number }): AgentTool {
	return {
		name: "edit",
		label: "Edit",
		description: "",
		parameters: z.object({ path: z.string(), diff: z.string() }),
		async execute() {
			executed.count += 1;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

async function createSession(tempDir: string, streamFn: Agent["streamFn"], tool: AgentTool) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [tool] },
		streamFn,
	});
	const sessionManager = SessionManager.inMemory(tempDir);
	const settings = Settings.isolated({ "edit.streamingAbort": true });
	const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	return {
		agent,
		session: new AgentSession({ agent, sessionManager, settings, modelRegistry }),
		authStorage,
	};
}

function createStreamForDiff(filePath: string, diff: string): Agent["streamFn"] {
	let callIndex = 0;
	return () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			if (callIndex > 0) {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }], "stop"),
				});
				return;
			}

			const toolCall = createToolCall("call_edit_1", { path: filePath, diff });
			stream.push({ type: "start", partial: createAssistantMessage([], "stop") });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: createAssistantMessage([toolCall], "stop") });
			stream.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: diff,
				partial: createAssistantMessage([toolCall], "stop"),
			});
			stream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: createAssistantMessage([toolCall], "toolUse"),
			});
			stream.push({ type: "done", reason: "toolUse", message: createAssistantMessage([toolCall], "toolUse") });
			callIndex++;
		});
		return stream;
	};
}

describe("StreamingEditFileCache", () => {
	it("enforces the 16 entry cap with LRU eviction", () => {
		const cache = new StreamingEditFileCache();
		for (let i = 0; i < 16; i++) cache.set(`file-${i}`, `content-${i}`);
		expect(cache.get("file-0")).toBe("content-0");
		cache.set("file-16", "content-16");
		expect(cache.get("file-1")).toBeUndefined();
		expect(cache.get("file-0")).toBe("content-0");
		expect(cache.get("file-16")).toBe("content-16");
	});

	it("enforces the total byte cap", () => {
		const cache = new StreamingEditFileCache();
		const fourMiB = "x".repeat(4 * 1024 * 1024);
		for (let i = 0; i < 8; i++) cache.set(`file-${i}`, fourMiB);
		cache.set("file-8", fourMiB);
		expect(cache.get("file-0")).toBeUndefined();
		expect(cache.get("file-1")).toBe(fourMiB);
		expect(cache.get("file-8")).toBe(fourMiB);
	});

	it("skips files larger than 8 MiB without blocking the edit tool path", async () => {
		const tempDir = path.join(os.tmpdir(), `streaming-edit-cache-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const fileName = "large.txt";
		await Bun.write(path.join(tempDir, fileName), `${"a".repeat(MAX_EDIT_FILE_BYTES + 1)}\nkeep\n`);
		const executed = { count: 0 };
		const streamFn = createStreamForDiff(fileName, "@@\n-keep\n+kept\n");
		const { session, authStorage } = await createSession(tempDir, streamFn, buildEditTool(executed));
		try {
			await session.prompt("edit large file");
			expect(executed.count).toBe(1);
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});
});
