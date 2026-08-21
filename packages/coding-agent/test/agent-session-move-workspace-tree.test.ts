import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createLazyService, type LazyService } from "@gajae-code/coding-agent/runtime/lazy-service";
import {
	createWorkspaceTreeService,
	type WorkspaceTreeRuntime,
} from "@gajae-code/coding-agent/runtime/workspace-tree-service";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => {
			if (!block || typeof block !== "object") return false;
			const candidate = block as { type?: string; text?: string };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map(block => block.text)
		.join("\n");
}

function isVolatileProjectContextMessage(message: AgentMessage): boolean {
	const text = getMessageText(message);
	return text.startsWith("<system-reminder>") && text.includes("current working directory");
}

describe("AgentSession workspace tree after /move", () => {
	let tempDir: TempDir;
	let cwdA: string;
	let cwdB: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage | undefined;
	let settings: Settings;
	const volatilePromptContexts: string[][] = [];

	/** Bare agent used by hook/failure-path sessions that never prompt the model. */
	function newAgent(): Agent {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		return new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				throw new Error("not expected to stream");
			},
		});
	}

	function testModelRegistry(): ModelRegistry {
		return new ModelRegistry(
			authStorage ??
				(() => {
					throw new Error("auth storage missing");
				})(),
			path.join(tempDir.path(), "models.yml"),
		);
	}

	function createSession(options?: { useWorkspaceTreeService?: boolean }): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const modelRegistry = new ModelRegistry(
			authStorage ??
				(() => {
					throw new Error("auth storage missing");
				})(),
			path.join(tempDir.path(), "models.yml"),
		);
		const mockTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				volatilePromptContexts.push(
					context.messages.filter(isVolatileProjectContextMessage).map(message => getMessageText(message)),
				);
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([[mockTool.name, mockTool]]),
			...(options?.useWorkspaceTreeService
				? { workspaceTreeService: createWorkspaceTreeService(settings, cwdA) }
				: {}),
		});
	}

	/** Fresh session (own agent) wired with the given move hook, for hook-semantics tests. */
	function createHookedSession(hooks: { onCwdMoved: () => void | Promise<void> }): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mockTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool], messages: [] },
			convertToLlm,
			streamFn: () => {
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		return new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(
				authStorage ??
					(() => {
						throw new Error("auth storage missing");
					})(),
				path.join(tempDir.path(), "models.yml"),
			),
			toolRegistry: new Map<string, AgentTool>([[mockTool.name, mockTool]]),
			onCwdMoved: hooks.onCwdMoved,
		});
	}
	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-move-tree-");
		cwdA = path.join(tempDir.path(), "cwd-a");
		cwdB = path.join(tempDir.path(), "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		await Bun.write(path.join(cwdA, "marker-a.txt"), "a");
		await Bun.write(path.join(cwdB, "marker-b.txt"), "b");
		volatilePromptContexts.length = 0;
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settings = Settings.isolated({ "compaction.enabled": false });
		sessionManager = SessionManager.inMemory(cwdA);
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("rescans the workspace tree from the new cwd after moveCwd", async () => {
		createSession();
		await session.prompt("first question?");
		expect(volatilePromptContexts).toHaveLength(1);
		const before = volatilePromptContexts[0]?.join("\n") ?? "";
		expect(before).toContain(cwdA);
		expect(before).toContain("marker-a.txt");

		await session.moveCwd(cwdB);

		await session.prompt("second question?");
		expect(volatilePromptContexts).toHaveLength(2);
		const after = volatilePromptContexts[1]?.join("\n") ?? "";
		expect(after).toContain(cwdB);
		expect(after).toContain("marker-b.txt");
		expect(after).not.toContain("marker-a.txt");
	});

	it("drops the launch-cwd workspace-tree service on moveCwd", async () => {
		createSession({ useWorkspaceTreeService: true });
		await session.prompt("first question?");
		const before = volatilePromptContexts[0]?.join("\n") ?? "";
		expect(before).toContain("marker-a.txt");

		await session.moveCwd(cwdB);

		await session.prompt("second question?");
		const after = volatilePromptContexts[1]?.join("\n") ?? "";
		expect(after).toContain(cwdB);
		expect(after).toContain("marker-b.txt");
		expect(after).not.toContain("marker-a.txt");
	});

	it("keeps describing the old root after a raw sessionManager moveTo (throttled tree stays stale)", async () => {
		createSession();
		await session.prompt("first question?");
		// Raw sessionManager.moveTo() without moveCwd(): within the volatile-tree
		// TTL the snapshot is not re-embedded, so nothing in the second request
		// describes cwdB's tree. Pins why every cwd mutation must route through
		// AgentSession.moveCwd().
		await sessionManager.moveTo(cwdB);
		await session.prompt("second question?");
		const after = volatilePromptContexts[1]?.join("\n") ?? "";
		expect(after).not.toContain("marker-b.txt");
	});

	it("rejects nonexistent and non-directory move targets without changing cwd", async () => {
		createSession();
		const missing = path.join(tempDir.path(), "does-not-exist");
		const file = path.join(tempDir.path(), "plain-file.txt");
		await Bun.write(file, "x");
		await expect(session.moveCwd(missing)).rejects.toThrow("Directory does not exist");
		await expect(session.moveCwd(file)).rejects.toThrow("Not a directory");
		expect(sessionManager.getCwd()).toBe(cwdA);
	});

	it("is a no-op when the target resolves to the current cwd", async () => {
		createSession();
		// Dispose the shared session so a second AgentSession (with the hook)
		// can own a fresh agent instance.
		await session.dispose();
		let cwdMovedCalls = 0;
		session = createHookedSession({
			onCwdMoved: () => {
				cwdMovedCalls++;
			},
		});
		await session.moveCwd(cwdA);
		expect(cwdMovedCalls).toBe(0);
		expect(sessionManager.getCwd()).toBe(cwdA);
	});

	it("re-roots project-scoped consumers through the onCwdMoved hook", async () => {
		createSession();
		await session.dispose();
		let movedTo: string | undefined;
		session = createHookedSession({
			onCwdMoved: async () => {
				movedTo = sessionManager.getCwd();
			},
		});
		await session.moveCwd(cwdB);
		expect(movedTo).toBe(cwdB);
		expect(sessionManager.getCwd()).toBe(cwdB);
	});

	it("completes the move when the workspace-tree service disposal rejects", async () => {
		createSession();
		await session.dispose();
		const failingDisposeService = createLazyService<never>({
			id: "workspace-tree-test-failing-dispose",
			enabled: () => true,
			initialize: async () => ({
				value: undefined as never,
				dispose: () => {
					throw new Error("dispose boom");
				},
			}),
		});
		await failingDisposeService.prewarm("test");
		session = new AgentSession({
			agent: newAgent(),
			sessionManager,
			settings,
			modelRegistry: testModelRegistry(),
			toolRegistry: new Map<string, AgentTool>(),
			workspaceTreeService: failingDisposeService as unknown as LazyService<WorkspaceTreeRuntime>,
		});
		await expect(session.moveCwd(cwdB)).resolves.toBeUndefined();
		expect(sessionManager.getCwd()).toBe(cwdB);
	});

	it("propagates moveTo failure while the cwd stays unchanged", async () => {
		createSession();
		await session.dispose();
		const failingMoveTo = sessionManager.moveTo.bind(sessionManager);
		sessionManager.moveTo = async () => {
			throw new Error("moveTo boom");
		};
		session = createHookedSession({
			onCwdMoved: () => {
				throw new Error("hook must not run when the move never committed");
			},
		});
		await expect(session.moveCwd(cwdB)).rejects.toThrow("moveTo boom");
		expect(sessionManager.getCwd()).toBe(cwdA);
		sessionManager.moveTo = failingMoveTo;
	});

	it("never rejects from a failing post-commit onCwdMoved hook", async () => {
		createSession();
		await session.dispose();
		session = createHookedSession({
			onCwdMoved: () => {
				throw new Error("hook boom");
			},
		});
		await expect(session.moveCwd(cwdB)).resolves.toBeUndefined();
		expect(sessionManager.getCwd()).toBe(cwdB);
	});
});
