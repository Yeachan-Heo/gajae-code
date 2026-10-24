/**
 * Bisect uses the same ACP/SDK permission gate as eval.
 * Deny, an unconnected prompt, and a cancelled prompt refuse the shell predicate.
 * Allow mode still runs it, including a predicate with surrounding whitespace.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@gajae-code/coding-agent/session/client-bridge";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

let tempDir: TempDir;
let session: AgentSession | undefined;
const predicate = { good: "HEAD~1", bad: "HEAD", run: "echo step; exit 1" };
const spacedPredicate = { good: "HEAD~1", bad: "HEAD", run: "  echo step  " };

function makeFakeTool(name: string): AgentTool & { executeCalls: number } {
	const tool = {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: z.object({
			run: z.string().optional(),
			good: z.string().optional(),
			bad: z.string().optional(),
		}),
		executeCalls: 0,
		async execute() {
			tool.executeCalls++;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function makeBridge(outcome: ClientBridgePermissionOutcome, calls: string[]): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			calls.push(toolCall.toolName);
			return outcome;
		},
	};
}

async function createSession(
	tools: AgentTool[],
	bridge?: ClientBridge,
	permissionMode: "allow" | "prompt" | "deny" = "prompt",
): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body() } as never,
		toolRegistry: new Map(tools.map(t => [t.name, t])),
	});
	sess.setSdkPermissionMode(permissionMode);
	if (bridge) sess.setClientBridge(bridge);
	return sess;
}

async function activeBisect(sess: AgentSession): Promise<AgentTool> {
	await sess.setActiveToolsByName(["bisect"]);
	const wrapped = sess.agent.state.tools.find(t => t.name === "bisect");
	expect(wrapped).toBeDefined();
	return wrapped!;
}

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-bisect-permission-test-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	await tempDir.remove();
});

it("bisect tool is rejected when the session permission mode is deny", async () => {
	const bisectTool = makeFakeTool("bisect");
	const calls: string[] = [];
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" }, calls);
	session = await createSession([bisectTool], bridge, "deny");
	const wrapped = await activeBisect(session);
	await expect(
		wrapped.execute("call-bisect-deny", predicate, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/rejected by session permission policy \(bisect\)/);
	expect(calls).toEqual([]);
	expect(bisectTool.executeCalls).toBe(0);
});

it("bisect tool is rejected in prompt mode when no permission provider is connected", async () => {
	const bisectTool = makeFakeTool("bisect");
	session = await createSession([bisectTool], undefined, "prompt");
	const wrapped = await activeBisect(session);
	await expect(
		wrapped.execute("call-bisect-unconnected", predicate, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/no permission provider is connected \(bisect\)/);
	expect(bisectTool.executeCalls).toBe(0);
});

it("bisect tool is rejected in prompt mode when the permission request is cancelled", async () => {
	const bisectTool = makeFakeTool("bisect");
	const calls: string[] = [];
	const bridge = makeBridge({ outcome: "cancelled" }, calls);
	session = await createSession([bisectTool], bridge, "prompt");
	const wrapped = await activeBisect(session);
	await expect(
		wrapped.execute("call-bisect-cancel", predicate, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/Permission request cancelled/);
	expect(calls).toEqual(["bisect"]);
	expect(bisectTool.executeCalls).toBe(0);
});

it("bisect tool takes the ACP permission path before executing", async () => {
	const bisectTool = makeFakeTool("bisect");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([bisectTool], bridge);
	const wrapped = await activeBisect(session);
	await wrapped.execute("call-bisect", predicate, undefined, undefined as never, undefined as never);
	expect(requests.map(({ toolName, title, kind }) => ({ toolName, title, kind }))).toEqual([
		{ toolName: "bisect", title: "echo step; exit 1", kind: "execute" },
	]);
	expect(bisectTool.executeCalls).toBe(1);
});

it("still allows the bisect tool when the session permission mode is allow", async () => {
	const bisectTool = makeFakeTool("bisect");
	const calls: string[] = [];
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" }, calls);
	session = await createSession([bisectTool], bridge, "allow");
	const wrapped = await activeBisect(session);
	await wrapped.execute("call-bisect-allow", predicate, undefined, undefined as never, undefined as never);
	expect(calls).toEqual([]);
	expect(bisectTool.executeCalls).toBe(1);
});

it("still allows a bisect predicate with surrounding whitespace when the session permission mode is allow", async () => {
	const bisectTool = makeFakeTool("bisect");
	const calls: string[] = [];
	const bridge = makeBridge({ outcome: "cancelled" }, calls);
	session = await createSession([bisectTool], bridge, "allow");
	const wrapped = await activeBisect(session);
	await wrapped.execute("call-bisect-allow-space", spacedPredicate, undefined, undefined as never, undefined as never);
	expect(calls).toEqual([]);
	expect(bisectTool.executeCalls).toBe(1);
});
