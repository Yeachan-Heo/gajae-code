/**
 * Task children must keep the parent ACP/SDK approval policy.
 * Deny still rejects the child tool. Allow still runs it without a prompt.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import type { CreateAgentSessionResult } from "../src/sdk";
import * as sdkModule from "../src/sdk";
import { ExternalPermissionRuntime } from "../src/sdk/host/external-permissions";
import { AgentSession, type AgentSessionEvent, type PromptOptions } from "../src/session/agent-session";
import type { ClientBridge, ClientBridgePermissionOutcome } from "../src/session/client-bridge";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { TaskTool } from "../src/task";
import type { TaskParams } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { EventBus } from "../src/utils/event-bus";

const roots: string[] = [];
const gates: AgentSession[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	AsyncJobManager.resetForTests();
	const sessions = gates.splice(0);
	await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function makeBashTool(): AgentTool & { executeCalls: number } {
	const tool = {
		name: "bash",
		label: "bash",
		description: "Fake bash",
		parameters: z.object({ command: z.string().optional() }),
		executeCalls: 0,
		async execute() {
			tool.executeCalls += 1;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

async function createGateSession(root: string, bashTool: AgentTool): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [bashTool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(root),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		toolRegistry: new Map([[bashTool.name, bashTool]]),
	});
	gates.push(session);
	return session;
}

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createChildSession(
	gate: AgentSession,
	onBridge: (bridge: ClientBridge) => void,
	onToolError: (error: unknown) => void,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		agent: { state: { systemPrompt: ["child"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["bash", "yield"],
		setActiveToolsByName: async () => {},
		setConfiguredModelChain: () => {},
		seedDefaultFallbackResolution: () => {},
		setSdkPermissionMode: (mode: "prompt" | "allow" | "deny") => {
			gate.setSdkPermissionMode(mode);
		},
		setSdkPermissionProvider: (provider: ClientBridge["requestPermission"]) => {
			gate.setSdkPermissionProvider(provider);
		},
		setClientBridge: (bridge: ClientBridge) => {
			onBridge(bridge);
			gate.setClientBridge(bridge);
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			const tool = gate.getToolForExecution("bash");
			if (!tool) throw new Error("child bash tool missing");
			try {
				await tool.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);
			} catch (error) {
				onToolError(error);
			}
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		get messages() {
			return state.messages;
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createParentSession(
	root: string,
	mode: "prompt" | "allow" | "deny",
	bridge: ClientBridge,
	parent?: AgentSession,
): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionId: () => "parent-session",
		getSessionSpawns: () => "*",
		getSdkPermissionMode: () => mode,
		getSdkPermissionProvider: () => parent?.getSdkPermissionProvider(),
		getClientBridge: () => bridge,
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		},
	} as unknown as ToolSession;
}

async function executeDetached(tool: TaskTool, params: TaskParams): Promise<string> {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	try {
		const result = await tool.execute("tool-call", params);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		if (!result.details?.async?.jobId) throw new Error(`task was not scheduled: ${text}`);
		await manager.waitForAll();
		return text;
	} finally {
		await manager.dispose({ timeoutMs: 100 });
	}
}

async function runDelegated(
	mode: "prompt" | "allow" | "deny",
	outcome: ClientBridgePermissionOutcome,
	withPermission = true,
	external?: (
		runtime: ExternalPermissionRuntime,
		parent: AgentSession,
		bash: AgentTool & { executeCalls: number },
	) => void,
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-approval-"));
	roots.push(root);
	const bash = makeBashTool();
	const gate = await createGateSession(root, bash);
	const parent = await createGateSession(root, makeBashTool());
	const runtime = new ExternalPermissionRuntime("parent-session");
	if (external) {
		runtime.configure({ enabled: true });
		parent.setSdkPermissionMode(mode);
		parent.setSdkPermissionProvider((toolCall, options, signal) => {
			const response = runtime.request(toolCall, options, signal);
			external(runtime, parent, bash);
			return response;
		});
	}
	let permissionCalls = 0;
	let installed: ClientBridge | undefined;
	let toolError: unknown;
	const parentBridge: ClientBridge = {
		capabilities: {
			...(withPermission ? { requestPermission: true } : {}),
			terminal: true,
			readTextFile: true,
			writeTextFile: true,
		},
		deferAgentInitiatedTurns: true,
		async requestPermission() {
			permissionCalls += 1;
			return outcome;
		},
		async createTerminal() {
			throw new Error("terminal must not be inherited");
		},
	};
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
		return {
			session: createChildSession(
				gate,
				bridge => {
					installed = bridge;
				},
				error => {
					toolError = error;
				},
			),
			extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	const tool = await TaskTool.create(createParentSession(root, mode, parentBridge, parent));
	await executeDetached(tool, {
		agent: "executor",
		tasks: [{ id: "Child", description: "approval", assignment: "Run the command." }],
	});
	return { bash, permissionCalls, installed, toolError, gate };
}

describe("task subagent approval inheritance", () => {
	test.each(["allow_once", "reject_once"] as const)("external queue routes child approval: %s", async optionId => {
		const { bash, installed, toolError } = await runDelegated(
			"prompt",
			{ outcome: "cancelled" },
			false,
			(runtime, _parent, childBash) => {
				const requests = runtime.list().requests;
				expect(requests).toHaveLength(1);
				expect(requests[0]!.sessionId).toBe("parent-session");
				expect(requests[0]!.toolCall.rawInput).toMatchObject({ command: "echo hi" });
				expect(childBash.executeCalls).toBe(0);
				runtime.respond({ sessionId: "parent-session", id: requests[0]!.id, optionId });
				expect(runtime.list().requests).toHaveLength(0);
			},
		);
		expect(installed).toBeUndefined();
		expect(bash.executeCalls).toBe(optionId === "allow_once" ? 1 : 0);
		if (optionId === "allow_once") expect(toolError).toBeUndefined();
		else expect(toolError).toBeInstanceOf(Error);
	});

	test.each(["mode", "provider"] as const)("parent %s change cancels pending child approval", async change => {
		const { bash, toolError } = await runDelegated("prompt", { outcome: "cancelled" }, false, (runtime, parent) => {
			const request = runtime.list().requests[0]!;
			if (change === "mode") parent.setSdkPermissionMode("deny");
			else parent.setSdkPermissionProvider(undefined);
			expect(runtime.list().requests).toHaveLength(0);
			expect(() =>
				runtime.respond({ sessionId: "parent-session", id: request.id, optionId: "allow_once" }),
			).toThrow();
		});
		expect(bash.executeCalls).toBe(0);
		expect(toolError).toBeInstanceOf(Error);
	});

	test("deny on the parent still rejects the child bash call", async () => {
		const { bash, permissionCalls, installed, toolError, gate } = await runDelegated("deny", {
			outcome: "selected",
			optionId: "allow_once",
			kind: "allow_once",
		});

		expect(gate.sdkPermissionMode).toBe("deny");
		expect(bash.executeCalls).toBe(0);
		expect(permissionCalls).toBe(0);
		expect(toolError).toBeInstanceOf(Error);
		expect((toolError as Error).message).toContain("rejected by session permission policy (bash)");
		expect(installed?.capabilities.requestPermission).toBe(true);
		expect(installed?.capabilities.terminal).toBeUndefined();
		expect(installed?.deferAgentInitiatedTurns).toBeUndefined();
		expect(installed?.createTerminal).toBeUndefined();
	});

	test("allow on the parent still runs the child bash call without a prompt", async () => {
		const { bash, permissionCalls, installed, toolError } = await runDelegated("allow", {
			outcome: "selected",
			optionId: "reject_once",
			kind: "reject_once",
		});

		expect(toolError).toBeUndefined();
		expect(bash.executeCalls).toBe(1);
		expect(permissionCalls).toBe(0);
		expect(installed?.capabilities.terminal).toBeUndefined();
		expect(installed?.createTerminal).toBeUndefined();
	});

	test("prompt on the parent still asks before the child bash call runs", async () => {
		const { bash, permissionCalls, toolError } = await runDelegated("prompt", {
			outcome: "selected",
			optionId: "allow_once",
			kind: "allow_once",
		});

		expect(toolError).toBeUndefined();
		expect(permissionCalls).toBe(1);
		expect(bash.executeCalls).toBe(1);
	});

	test("prompt without a permission callback still rejects the child", async () => {
		const { bash, permissionCalls, installed, toolError, gate } = await runDelegated(
			"prompt",
			{ outcome: "selected", optionId: "allow_once", kind: "allow_once" },
			false,
		);

		expect(gate.sdkPermissionMode).toBe("prompt");
		expect(installed).toBeUndefined();
		expect(bash.executeCalls).toBe(0);
		expect(permissionCalls).toBe(0);
		expect(toolError).toBeInstanceOf(Error);
		expect((toolError as Error).message).toContain("no permission provider is connected (bash)");
	});
});
