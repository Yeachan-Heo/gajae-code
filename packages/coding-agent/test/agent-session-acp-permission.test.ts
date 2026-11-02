/**
 * Tests for the ACP permission gate in AgentSession.
 *
 * Verifies that tools with a real ACP approval policy (bash/delete/move) are gated behind
 * `ClientBridge.requestPermission`, while regular file-editing tools keep the same no-approval
 * behavior they have in the TUI.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockModelOptions } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { EditTool } from "@gajae-code/coding-agent/edit";
import { ExtensionRuntime, loadExtensionFromFactory } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@gajae-code/coding-agent/session/client-bridge";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { callSessionTool } from "../src/eval/js/tool-bridge";
import { ExternalPermissionRuntime } from "../src/sdk/host/external-permissions";
import { EventBus } from "../src/utils/event-bus";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tempDir: TempDir;
let session: AgentSession | undefined;

/** Fake tool that records execute calls. */
function makeFakeTool(name: string): AgentTool & { executeCalls: number } {
	const tool = {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: z.object({ command: z.string().optional() }),
		executeCalls: 0,
		async execute() {
			tool.executeCalls++;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function makeToolSession(bridge: ClientBridge): ToolSession {
	return {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		getClientBridge: () => bridge,
	} as unknown as ToolSession;
}

function makeExecutionToolSession(agentSession: AgentSession): ToolSession {
	return {
		getToolByName: (name: string) => agentSession.getToolByName(name),
		getToolForExecution: (name: string) => agentSession.getToolForExecution(name),
	} as unknown as ToolSession;
}

/** Build a minimal ClientBridge whose requestPermission resolves to the given outcome. */
function makeBridge(outcome: ClientBridgePermissionOutcome): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			return outcome;
		},
	};
}

async function createSession(
	tools: AgentTool[],
	bridge?: ClientBridge,
	permissionMode: "allow" | "prompt" | "deny" = "prompt",
	extensionRunner?: ExtensionRunner,
): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});

	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body() } as never,
		toolRegistry: new Map(tools.map(t => [t.name, t])),
		extensionRunner,
	});

	// Session default is `allow`; ACP registers a prompt bridge alongside prompt mode (see acp-agent).
	sess.setSdkPermissionMode(permissionMode);
	if (bridge) sess.setClientBridge(bridge);
	return sess;
}

async function createSessionWithMockModel(
	tools: AgentTool[],
	bridge: ClientBridge,
	responses: NonNullable<MockModelOptions["responses"]>,
): Promise<AgentSession> {
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({ "compaction.enabled": false, "edit.mode": "apply_patch" });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock.model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: {
			getApiKey: () => "test-key",
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		toolRegistry: new Map(tools.map(t => [t.name, t])),
	});
	sess.setSdkPermissionMode("prompt");
	sess.setClientBridge(bridge);
	return sess;
}

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-acp-permission-test-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	await tempDir.remove();
});

// ---------------------------------------------------------------------------
// 1. Allow once: bridge called once, underlying execute called once
// ---------------------------------------------------------------------------

it("allow_once: calls bridge once and executes the underlying tool", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	// Get the wrapped tool from the agent's active set.
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("SDK polling rejection comments reach the tool result without executing", async () => {
	const bashTool = makeFakeTool("bash");
	session = await createSession([bashTool]);
	const channel = new ExternalPermissionRuntime("session");
	channel.configure({ enabled: true });
	session.setSdkPermissionProvider((call, options, signal) => channel.request(call, options, signal));
	await session.setActiveToolsByName(["bash"]);
	const tool = session.agent.state.tools.find(t => t.name === "bash")!;
	const execution = tool
		.execute("call", { command: "echo hi" }, undefined, undefined as never, undefined as never)
		.catch(error => error as Error);
	for (let attempt = 0; channel.list().requests.length === 0 && attempt < 100; attempt++) await Bun.sleep(1);
	const request = channel.list().requests[0]!;
	expect(request.toolCall.rawInput).toEqual({ command: "echo hi" });
	channel.respond({ sessionId: "session", id: request.id, optionId: "reject_once", comment: "Use read instead" });
	expect(((await execution) as Error).message).toBe("Tool call rejected by user (bash): Use read instead");
	expect(bashTool.executeCalls).toBe(0);
	channel.dispose();
});

it("permission providers conflict in either direction but filesystem bridges remain allowed", async () => {
	session = await createSession([makeFakeTool("bash")]);
	const provider = async (): Promise<ClientBridgePermissionOutcome> => ({ outcome: "cancelled" });
	session.setSdkPermissionProvider(provider);
	expect(() => session!.setClientBridge(makeBridge({ outcome: "cancelled" }))).toThrow("SDK permission provider");
	session.setClientBridge({ capabilities: { readTextFile: true } });
	session.setSdkPermissionProvider(undefined);
	session.setClientBridge(makeBridge({ outcome: "cancelled" }));
	expect(() => session!.setSdkPermissionProvider(provider)).toThrow("ACP permission provider");
});

it("retained tool wrappers use the current SDK permission provider", async () => {
	const bashTool = makeFakeTool("bash");
	session = await createSession([bashTool]);
	let oldCalls = 0;
	session.setSdkPermissionProvider(async () => {
		oldCalls++;
		return { outcome: "selected", optionId: "allow_once" };
	});
	await session.setActiveToolsByName(["bash"]);
	const retained = session.agent.state.tools.find(t => t.name === "bash")!;
	session.setSdkPermissionProvider(async () => ({ outcome: "selected", optionId: "reject_once" }));
	await expect(
		retained.execute("call", { command: "echo hi" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow("rejected by user");
	expect(oldCalls).toBe(0);
	expect(bashTool.executeCalls).toBe(0);
});

for (const providerKind of ["SDK", "ACP"] as const) {
	it(`${providerKind} approvals remain actionable after reasserting prompt mode`, async () => {
		const bashTool = makeFakeTool("bash");
		session = await createSession([bashTool]);
		const channel = new ExternalPermissionRuntime("session");
		channel.configure({ enabled: true });
		const provider = (
			call: ClientBridgePermissionToolCall,
			options: Parameters<ExternalPermissionRuntime["request"]>[1],
			signal?: AbortSignal,
		) => channel.request(call, options, signal);
		if (providerKind === "SDK") session.setSdkPermissionProvider(provider);
		else session.setClientBridge({ capabilities: { requestPermission: true }, requestPermission: provider });
		try {
			await session.setActiveToolsByName(["bash"]);
			const tool = session.agent.state.tools.find(t => t.name === "bash")!;
			const execution = tool.execute(
				"call",
				{ command: "echo hi" },
				undefined,
				undefined as never,
				undefined as never,
			);
			for (let attempt = 0; channel.list().requests.length === 0 && attempt < 100; attempt++) await Bun.sleep(1);
			const request = channel.list().requests[0]!;
			expect(request).toBeDefined();
			session.setSdkPermissionMode("prompt");
			expect(channel.list().requests.map(pending => pending.id)).toEqual([request.id]);
			channel.respond({ sessionId: "session", id: request.id, optionId: "allow_once" });
			await execution;
			expect(bashTool.executeCalls).toBe(1);
		} finally {
			channel.dispose();
		}
	});
}

for (const change of ["mode", "provider", "bridge", "resolved-then-deny"] as const) {
	it(`SDK pending approvals cancel on ${change} changes and cannot execute late`, async () => {
		const bashTool = makeFakeTool("bash");
		session = await createSession([bashTool]);
		const channel = new ExternalPermissionRuntime("session");
		channel.configure({ enabled: true });
		session.setSdkPermissionProvider((call, options, signal) => channel.request(call, options, signal));
		await session.setActiveToolsByName(["bash"]);
		const tool = session.agent.state.tools.find(t => t.name === "bash")!;
		const execution = tool
			.execute("call", { command: "echo hi" }, undefined, undefined as never, undefined as never)
			.catch(error => error as Error);
		for (let attempt = 0; channel.list().requests.length === 0 && attempt < 100; attempt++) await Bun.sleep(1);
		const request = channel.list().requests[0]!;
		if (change === "resolved-then-deny") {
			channel.respond({ sessionId: "session", id: request.id, optionId: "allow_always" });
			session.setSdkPermissionMode("deny");
		} else if (change === "mode") session.setSdkPermissionMode("deny");
		else if (change === "provider") session.setSdkPermissionProvider(undefined);
		else session.setClientBridge(undefined);
		expect(channel.list().requests).toEqual([]);
		expect(() => channel.respond({ sessionId: "session", id: request.id, optionId: "allow_once" })).toThrow();
		expect(((await execution) as Error).message).toBe("Permission request cancelled");
		expect(bashTool.executeCalls).toBe(0);
		channel.dispose();
	});
}

it("Function Hook transforms reach ACP permission and execution consistently", async () => {
	let executedArgs: unknown;
	const bashTool = makeFakeTool("bash");
	bashTool.execute = async (_id, args) => {
		executedArgs = args;
		bashTool.executeCalls++;
		return { content: [{ type: "text" as const, text: "ok" }] };
	};
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const runtime = new ExtensionRuntime();
	const manager = SessionManager.inMemory(tempDir.path());
	const extension = await loadExtensionFromFactory(
		api => {
			api.registerFunctionHook(
				"tool_call",
				async invocation => ({
					action: "continue",
					event: { ...invocation.payload, input: { command: "echo transformed" } },
				}),
				{ capabilities: ["tool.inspect", "tool.transform"], target: "bash" },
			);
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-transform",
	);
	const runner = new ExtensionRunner([extension], runtime, tempDir.path(), manager, {} as never);
	session = await createSession([bashTool], bridge, "prompt", runner);
	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await wrappedBash!.execute(
		"call-transform",
		{ command: "echo original" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests[0]?.rawInput).toEqual({ command: "echo transformed" });
	expect(requests[0]?.content).toEqual([{ type: "content", content: { type: "text", text: "$ echo transformed" } }]);
	expect(executedArgs).toEqual({ command: "echo transformed" });
});

it("delete and move tools request ACP permission before executing", async () => {
	const deleteTool = makeFakeTool("delete");
	const moveTool = makeFakeTool("move");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([deleteTool, moveTool], bridge);

	await session.setActiveToolsByName(["delete", "move"]);
	const wrappedDelete = session.agent.state.tools.find(t => t.name === "delete");
	const wrappedMove = session.agent.state.tools.find(t => t.name === "move");
	expect(wrappedDelete).toBeDefined();
	expect(wrappedMove).toBeDefined();

	await wrappedDelete!.execute(
		"call-delete",
		{ path: "/tmp/gone.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedMove!.execute(
		"call-move",
		{ oldPath: "/tmp/old.ts", newPath: "/tmp/new.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(2);
	expect(requests.map(({ toolName, title, locations }) => ({ toolName, title, locations }))).toEqual([
		{ toolName: "delete", title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
		{
			toolName: "move",
			title: "Move /tmp/old.ts to /tmp/new.ts",
			locations: [{ path: "/tmp/old.ts" }, { path: "/tmp/new.ts" }],
		},
	]);
	expect(deleteTool.executeCalls).toBe(1);
	expect(moveTool.executeCalls).toBe(1);
});

it("edit, write, and ast_edit do not request ACP permission", async () => {
	const editTool = makeFakeTool("edit");
	const writeTool = makeFakeTool("write");
	const astEditTool = makeFakeTool("ast_edit");
	const bridge = makeBridge({ outcome: "cancelled" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([editTool, writeTool, astEditTool], bridge);

	await session.setActiveToolsByName(["edit", "write", "ast_edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	const wrappedWrite = session.agent.state.tools.find(t => t.name === "write");
	const wrappedAstEdit = session.agent.state.tools.find(t => t.name === "ast_edit");
	expect(wrappedEdit).toBeDefined();
	expect(wrappedWrite).toBeDefined();
	expect(wrappedAstEdit).toBeDefined();

	await wrappedEdit!.execute("call-edit", { path: "/tmp/foo.ts" }, undefined, undefined as never, undefined as never);
	await wrappedWrite!.execute(
		"call-write",
		{ path: "/tmp/foo.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedAstEdit!.execute(
		"call-ast",
		{ paths: ["/tmp/foo.ts"] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(0);
	expect(editTool.executeCalls).toBe(1);
	expect(writeTool.executeCalls).toBe(1);
	expect(astEditTool.executeCalls).toBe(1);
});

it("edit delete and move operations request ACP permission before executing", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await wrappedEdit!.execute(
		"call-edit-delete",
		{ path: "/tmp/gone.ts", edits: [{ op: "delete" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedEdit!.execute(
		"call-edit-move",
		{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(2);
	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
		{ title: "Move /tmp/old.ts to /tmp/new.ts", locations: [{ path: "/tmp/old.ts" }, { path: "/tmp/new.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(2);
});

it("edit delete operations take precedence over stale rename metadata", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await wrappedEdit!.execute(
		"call-edit-delete-with-rename",
		{ path: "/tmp/gone.ts", edits: [{ op: "delete", rename: "/tmp/stale.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(1);
});

it("apply_patch delete operations take precedence over earlier moves", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await wrappedEdit!.execute(
		"call-apply-patch-delete-after-move",
		{
			input: [
				"*** Begin Patch",
				"*** Update File: /tmp/old.ts",
				"*** Move to: /tmp/new.ts",
				"@@",
				"-old",
				"+new",
				"*** Delete File: /tmp/gone.ts",
				"*** End Patch",
			].join("\n"),
		},
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(1);
});

it("apply_patch custom-wire delete requests ACP permission through agent dispatch", async () => {
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const editTool = new EditTool(makeToolSession(bridge));
	session = await createSessionWithMockModel([editTool as AgentTool], bridge, [
		{
			content: [
				{
					type: "toolCall",
					id: "call-custom-apply-patch",
					name: "apply_patch",
					arguments: {
						input: ["*** Begin Patch", "*** Delete File: /tmp/gone.ts", "*** End Patch"].join("\n"),
					},
				},
			],
		},
		{ content: ["done"] },
	]);

	await session.setActiveToolsByName(["edit"]);
	await session.prompt("delete with custom apply_patch");

	expect(requests.map(({ toolCallId, title, locations }) => ({ toolCallId, title, locations }))).toEqual([
		{
			toolCallId: "call-custom-apply-patch",
			title: "Delete /tmp/gone.ts",
			locations: [{ path: "/tmp/gone.ts" }],
		},
	]);
	expect(requests).toHaveLength(1);
});

it("patch-mode delete operations take precedence over earlier moves", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await wrappedEdit!.execute(
		"call-patch-delete-after-move",
		{
			path: "/tmp/old.ts",
			edits: [{ op: "update", rename: "/tmp/new.ts" }, { op: "delete" }],
		},
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/old.ts", locations: [{ path: "/tmp/old.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(1);
});

it("always-allowing edit moves does not bypass patch-mode calls that also delete", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_always", kind: "allow_always" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await wrappedEdit!.execute(
		"call-edit-move",
		{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedEdit!.execute(
		"call-patch-delete-after-move",
		{
			path: "/tmp/another-old.ts",
			edits: [{ op: "update", rename: "/tmp/another-new.ts" }, { op: "delete" }],
		},
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title }) => title)).toEqual([
		"Move /tmp/old.ts to /tmp/new.ts",
		"Delete /tmp/another-old.ts",
	]);
	expect(editTool.executeCalls).toBe(2);
});

it("permission requests report the gated tool call as pending", async () => {
	const bashTool = makeFakeTool("bash");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await wrappedBash!.execute("call-bash", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		toolCallId: "call-bash",
		toolName: "bash",
		status: "pending",
	});
	expect(bashTool.executeCalls).toBe(1);
});

it("bash permission requests include execute metadata and command content", async () => {
	const bashTool = makeFakeTool("bash");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await wrappedBash!.execute(
		"call-bash-rich",
		{ command: "git status --short" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		toolCallId: "call-bash-rich",
		toolName: "bash",
		title: "git status --short",
		kind: "execute",
		status: "pending",
		rawInput: { command: "git status --short" },
		content: [{ type: "content", content: { type: "text", text: "$ git status --short" } }],
	});
	expect(bashTool.executeCalls).toBe(1);
});

it("monitor permission requests include execute metadata and command content", async () => {
	const monitorTool = makeFakeTool("monitor");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([monitorTool], bridge);

	await session.setActiveToolsByName(["monitor"]);
	const wrappedMonitor = session.agent.state.tools.find(t => t.name === "monitor");
	expect(wrappedMonitor).toBeDefined();

	await wrappedMonitor!.execute(
		"call-monitor-rich",
		{ command: "tail -f /tmp/app.log", kind: "log", description: "app log" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		toolCallId: "call-monitor-rich",
		toolName: "monitor",
		title: "tail -f /tmp/app.log",
		kind: "execute",
		status: "pending",
		rawInput: { command: "tail -f /tmp/app.log", kind: "log", description: "app log" },
		content: [{ type: "content", content: { type: "text", text: "$ tail -f /tmp/app.log" } }],
	});
	expect(monitorTool.executeCalls).toBe(1);
});

it("monitor reject_once prevents shell monitor execution", async () => {
	const monitorTool = makeFakeTool("monitor");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([monitorTool], bridge);

	await session.setActiveToolsByName(["monitor"]);
	const wrappedMonitor = session.agent.state.tools.find(t => t.name === "monitor");
	expect(wrappedMonitor).toBeDefined();

	await expect(
		wrappedMonitor!.execute(
			"call-monitor-reject",
			{ command: "tail -f /tmp/app.log", kind: "log", description: "app log" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by user/);

	expect(monitorTool.executeCalls).toBe(0);
});

it("monitor allow_always caches shell execution permission", async () => {
	const monitorTool = makeFakeTool("monitor");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([monitorTool], bridge);

	await session.setActiveToolsByName(["monitor"]);
	const wrappedMonitor = session.agent.state.tools.find(t => t.name === "monitor");
	expect(wrappedMonitor).toBeDefined();

	await wrappedMonitor!.execute(
		"call-monitor-1",
		{ command: "tail -f /tmp/a.log", kind: "log", description: "a log" },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedMonitor!.execute(
		"call-monitor-2",
		{ command: "tail -f /tmp/b.log", kind: "log", description: "b log" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(monitorTool.executeCalls).toBe(2);
});

it("ordinary edit calls still bypass ACP permission after rejecting edit moves forever", async () => {
	const editTool = makeFakeTool("edit");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_always", kind: "reject_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await expect(
		wrappedEdit!.execute(
			"call-edit-move",
			{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by user/);
	await wrappedEdit!.execute(
		"call-edit-update",
		{ path: "/tmp/foo.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(editTool.executeCalls).toBe(1);
});

it("edit create operations with rename metadata do not request ACP move permission", async () => {
	const editTool = makeFakeTool("edit");
	const bridge = makeBridge({ outcome: "cancelled" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await wrappedEdit!.execute(
		"call-edit-create",
		{ path: "/tmp/new.ts", edits: [{ op: "create", rename: "/tmp/ignored.ts", diff: "export {};" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(0);
	expect(editTool.executeCalls).toBe(1);
});

it("always-allowing edit moves does not bypass later edit delete permission", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_always", kind: "allow_always" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await wrappedEdit!.execute(
		"call-edit-move",
		{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedEdit!.execute(
		"call-edit-delete",
		{ path: "/tmp/gone.ts", edits: [{ op: "delete" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title }) => title)).toEqual(["Move /tmp/old.ts to /tmp/new.ts", "Delete /tmp/gone.ts"]);
	expect(editTool.executeCalls).toBe(2);
});

it("setClientBridge wraps tools that were already active", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool]);

	session.setClientBridge(bridge);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("eval allow_once requests execution permission before running", async () => {
	const evalTool = makeFakeTool("eval");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, options, _signal) {
			requests.push(toolCall);
			expect(options.map(option => option.optionId)).toEqual([
				"allow_once",
				"allow_always",
				"reject_once",
				"reject_always",
			]);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([evalTool], bridge);
	await session.setActiveToolsByName(["eval"]);
	const wrappedEval = session.agent.state.tools.find(tool => tool.name === "eval");

	await wrappedEval!.execute(
		"call-eval-allow",
		{ cells: [{ language: "js", code: "1 + 1", title: "Calculate" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests).toEqual([
		expect.objectContaining({
			toolCallId: "call-eval-allow",
			toolName: "eval",
			title: "Calculate",
			kind: "execute",
			status: "pending",
		}),
	]);
	expect(evalTool.executeCalls).toBe(1);
});

it("eval reject_once does not execute", async () => {
	const evalTool = makeFakeTool("eval");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([evalTool], bridge);
	await session.setActiveToolsByName(["eval"]);
	const wrappedEval = session.agent.state.tools.find(tool => tool.name === "eval");

	await expect(
		wrappedEval!.execute(
			"call-eval-reject",
			{ cells: [{ language: "py", code: "print(1)" }] },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by user/);
	expect(evalTool.executeCalls).toBe(0);
});

it("eval allow_always is reused for later eval calls", async () => {
	const evalTool = makeFakeTool("eval");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([evalTool], bridge);
	await session.setActiveToolsByName(["eval"]);
	const wrappedEval = session.agent.state.tools.find(tool => tool.name === "eval");

	await wrappedEval!.execute(
		"call-eval-always-1",
		{ cells: [{ language: "js", code: "1" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedEval!.execute(
		"call-eval-always-2",
		{ cells: [{ language: "py", code: "2" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(evalTool.executeCalls).toBe(2);
});

it("eval cancelled and unknown permission outcomes fail closed", async () => {
	for (const outcome of [
		{ outcome: "cancelled" as const },
		{ outcome: "selected" as const, optionId: "allow_typo" },
	]) {
		const evalTool = makeFakeTool("eval");
		const bridge = makeBridge(outcome);
		session = await createSession([evalTool], bridge);
		await session.setActiveToolsByName(["eval"]);
		const wrappedEval = session.agent.state.tools.find(tool => tool.name === "eval");

		await expect(
			wrappedEval!.execute(
				"call-eval-fail-closed",
				{ cells: [{ language: "js", code: "1" }] },
				undefined,
				undefined as never,
				undefined as never,
			),
		).rejects.toThrow(outcome.outcome === "cancelled" ? /cancelled/ : /unknown option ID/);
		expect(evalTool.executeCalls).toBe(0);
		await session.dispose();
		session = undefined;
	}
});

it("nested eval tool calls use the prepared permission-wrapped dispatch", async () => {
	const bashTool = makeFakeTool("bash");
	let nestedSession: AgentSession | undefined;
	let evalExecuteCalls = 0;
	const evalTool = {
		...makeFakeTool("eval"),
		async execute() {
			evalExecuteCalls++;
			await callSessionTool(
				"bash",
				{ command: "echo nested" },
				{ session: makeExecutionToolSession(nestedSession!) },
			);
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	const requestedTools: string[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requestedTools.push(toolCall.toolName);
			if (toolCall.toolName === "eval") {
				return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
			}
			return { outcome: "selected", optionId: "reject_once", kind: "reject_once" };
		},
	};
	nestedSession = await createSession([evalTool, bashTool], bridge);
	session = nestedSession;
	await session.setActiveToolsByName(["eval"]);
	const wrappedEval = session.agent.state.tools.find(tool => tool.name === "eval");

	await expect(
		wrappedEval!.execute(
			"call-eval-nested",
			{ cells: [{ language: "js", code: "await tools.bash(...)" }] },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by user/);
	expect(requestedTools).toEqual(["eval", "bash"]);
	expect(evalExecuteCalls).toBe(1);
	expect(bashTool.executeCalls).toBe(0);
});

it("non-ACP eval and nested dispatch preserve execution without permission prompts", async () => {
	const evalTool = makeFakeTool("eval");
	const bashTool = makeFakeTool("bash");
	session = await createSession([evalTool, bashTool], undefined, "allow");
	await session.setActiveToolsByName(["eval"]);
	const wrappedEval = session.agent.state.tools.find(tool => tool.name === "eval");

	await wrappedEval!.execute(
		"call-eval-local",
		{ cells: [{ language: "js", code: "1" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await callSessionTool("bash", { command: "echo local" }, { session: makeExecutionToolSession(session) });

	expect(evalTool.executeCalls).toBe(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("aborting an open permission request rejects without executing the tool", async () => {
	const bashTool = makeFakeTool("bash");
	const pending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		requestPermission: async () => pending.promise,
	};
	session = await createSession([bashTool], bridge);
	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	const abortController = new AbortController();
	const execution = wrappedBash!.execute(
		"call-1",
		{ command: "echo hi" },
		abortController.signal,
		undefined as never,
		undefined as never,
	);
	abortController.abort();

	await expect(execution).rejects.toThrow(/Permission request cancelled/);
	expect(bashTool.executeCalls).toBe(0);
	pending.resolve({ outcome: "cancelled" });
});

// ---------------------------------------------------------------------------
// 2. Reject once: throws, underlying execute never called
// ---------------------------------------------------------------------------

it("reject_once: throws ToolError and never calls underlying execute", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await expect(
		wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/rejected by user/);

	expect(bashTool.executeCalls).toBe(0);
});

it("unknown selected permission option ID fails closed without executing", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_typo" });
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await expect(
		wrappedBash!.execute("call-unknown", { command: "echo hi" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/unknown option ID/);
	expect(bashTool.executeCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// 3. Always allow caches: bridge called exactly once across two executions
// ---------------------------------------------------------------------------

it("allow_always: caches decision and calls bridge only once for subsequent executes", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	// First call — bridge is consulted, decision cached.
	await wrappedBash!.execute("call-1", { command: "echo a" }, undefined, undefined as never, undefined as never);
	// Second call — must skip the bridge entirely.
	await wrappedBash!.execute("call-2", { command: "echo b" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(2);
});

// ---------------------------------------------------------------------------
// 4. Read tool not gated: bridge never called even when bridge is set
// ---------------------------------------------------------------------------

it("read tool: requestPermission is never called for non-gated tools", async () => {
	const readTool = makeFakeTool("read");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([readTool], bridge);

	await session.setActiveToolsByName(["read"]);
	const wrappedRead = session.agent.state.tools.find(t => t.name === "read");
	expect(wrappedRead).toBeDefined();

	await wrappedRead!.execute("call-1", {}, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(0);
	expect(readTool.executeCalls).toBe(1);
});

it("computer tool takes the ACP permission path before executing", async () => {
	const computerTool = makeFakeTool("computer");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([computerTool], bridge);

	await session.setActiveToolsByName(["computer"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "computer");
	expect(wrapped).toBeDefined();

	await wrapped!.execute("call-computer", { action: "screenshot" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(requests.map(({ toolName, title }) => ({ toolName, title }))).toEqual([
		{ toolName: "computer", title: "Computer screenshot" },
	]);
	expect(computerTool.executeCalls).toBe(1);
});

it("computer tool permission rejection prevents execution", async () => {
	const computerTool = makeFakeTool("computer");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([computerTool], bridge);

	await session.setActiveToolsByName(["computer"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "computer");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute(
			"call-computer-reject",
			{ action: "click", x: 1, y: 2 },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by user \(computer\)/);
	expect(computerTool.executeCalls).toBe(0);
});

it("computer tool is rejected when the session permission mode is deny", async () => {
	const computerTool = makeFakeTool("computer");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([computerTool], bridge, "deny");

	await session.setActiveToolsByName(["computer"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "computer");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute(
			"call-computer-deny",
			{ action: "type", text: "hello" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by session permission policy \(computer\)/);
	expect(permissionSpy).not.toHaveBeenCalled();
	expect(computerTool.executeCalls).toBe(0);
});

it("still allows a tool outside the permission set to run without an ACP prompt", async () => {
	const outsideTool = makeFakeTool("browser");
	const bridge = makeBridge({ outcome: "cancelled" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([outsideTool], bridge);

	await session.setActiveToolsByName(["browser"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "browser");
	expect(wrapped).toBeDefined();

	await wrapped!.execute("call-browser", { action: "screenshot" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(outsideTool.executeCalls).toBe(1);
});

it("still allows the computer tool when the session permission mode is allow", async () => {
	const computerTool = makeFakeTool("computer");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([computerTool], bridge, "allow");

	await session.setActiveToolsByName(["computer"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "computer");
	expect(wrapped).toBeDefined();

	await wrapped!.execute(
		"call-computer-allow",
		{ action: "screenshot" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(computerTool.executeCalls).toBe(1);
});

it("python tool takes the ACP permission path before executing", async () => {
	const pythonTool = makeFakeTool("python");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([pythonTool], bridge);

	await session.setActiveToolsByName(["python"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "python");
	expect(wrapped).toBeDefined();

	await wrapped!.execute(
		"call-python",
		{ action: "execute", code: "print(1)" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(requests.map(({ toolName, title, kind }) => ({ toolName, title, kind }))).toEqual([
		{ toolName: "python", title: "print(1)", kind: "execute" },
	]);
	expect(pythonTool.executeCalls).toBe(1);
});

it("python tool is rejected in prompt mode when no permission provider is connected", async () => {
	const pythonTool = makeFakeTool("python");
	session = await createSession([pythonTool], undefined, "prompt");

	await session.setActiveToolsByName(["python"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "python");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute(
			"call-python-unconnected",
			{ action: "execute", code: "import os" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/no permission provider is connected \(python\)/);
	expect(pythonTool.executeCalls).toBe(0);
});

it("python tool permission rejection prevents execution", async () => {
	const pythonTool = makeFakeTool("python");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([pythonTool], bridge);

	await session.setActiveToolsByName(["python"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "python");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute(
			"call-python-reject",
			{ action: "execute", code: "print(1)" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by user \(python\)/);
	expect(pythonTool.executeCalls).toBe(0);
});

it("python tool is rejected when the session permission mode is deny", async () => {
	const pythonTool = makeFakeTool("python");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([pythonTool], bridge, "deny");

	await session.setActiveToolsByName(["python"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "python");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute(
			"call-python-deny",
			{ action: "execute", code: "print(1)" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by session permission policy \(python\)/);
	expect(permissionSpy).not.toHaveBeenCalled();
	expect(pythonTool.executeCalls).toBe(0);
});

it("python tool uses the SDK permission provider when no ACP bridge is connected", async () => {
	const pythonTool = makeFakeTool("python");
	const requests: ClientBridgePermissionToolCall[] = [];
	session = await createSession([pythonTool], undefined, "prompt");
	session.setSdkPermissionProvider(async toolCall => {
		requests.push(toolCall);
		return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
	});

	await session.setActiveToolsByName(["python"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "python");
	expect(wrapped).toBeDefined();

	await wrapped!.execute(
		"call-python-sdk",
		{ action: "execute", code: "print(1)" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ toolName, title, kind }) => ({ toolName, title, kind }))).toEqual([
		{ toolName: "python", title: "print(1)", kind: "execute" },
	]);
	expect(pythonTool.executeCalls).toBe(1);
});

it("still allows a non-python tool to run in prompt mode without a permission call", async () => {
	const readTool = makeFakeTool("read");
	const bridge = makeBridge({ outcome: "cancelled" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([readTool], bridge, "prompt");

	await session.setActiveToolsByName(["read"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "read");
	expect(wrapped).toBeDefined();

	await wrapped!.execute("call-read-still-allowed", {}, undefined, undefined as never, undefined as never);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(readTool.executeCalls).toBe(1);
});

it("still allows the python tool when the session permission mode is allow", async () => {
	const pythonTool = makeFakeTool("python");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([pythonTool], bridge, "allow");

	await session.setActiveToolsByName(["python"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "python");
	expect(wrapped).toBeDefined();

	await wrapped!.execute(
		"call-python-allow",
		{ action: "execute", code: "print(1)" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(pythonTool.executeCalls).toBe(1);
});

it("recipe tool takes the ACP permission path before executing", async () => {
	const recipeTool = makeFakeTool("recipe");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([recipeTool], bridge);

	await session.setActiveToolsByName(["recipe"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "recipe");
	expect(wrapped).toBeDefined();

	await wrapped!.execute("call-recipe", { op: "build --release" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(requests.map(({ toolName, title, kind }) => ({ toolName, title, kind }))).toEqual([
		{ toolName: "recipe", title: "build --release", kind: "execute" },
	]);
	expect(recipeTool.executeCalls).toBe(1);
});

it("recipe tool permission rejection prevents execution", async () => {
	const recipeTool = makeFakeTool("recipe");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([recipeTool], bridge);

	await session.setActiveToolsByName(["recipe"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "recipe");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute("call-recipe-reject", { op: "test" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/rejected by user \(recipe\)/);
	expect(recipeTool.executeCalls).toBe(0);
});

it("recipe tool is rejected when the session permission mode is deny", async () => {
	const recipeTool = makeFakeTool("recipe");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([recipeTool], bridge, "deny");

	await session.setActiveToolsByName(["recipe"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "recipe");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute("call-recipe-deny", { op: "echo injected" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/rejected by session permission policy \(recipe\)/);
	expect(permissionSpy).not.toHaveBeenCalled();
	expect(recipeTool.executeCalls).toBe(0);
});

it("recipe tool is rejected in prompt mode when no permission provider is connected", async () => {
	const recipeTool = makeFakeTool("recipe");
	session = await createSession([recipeTool], undefined, "prompt");

	await session.setActiveToolsByName(["recipe"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "recipe");
	expect(wrapped).toBeDefined();

	await expect(
		wrapped!.execute("call-recipe-unconnected", { op: "build" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/no permission provider is connected \(recipe\)/);
	expect(recipeTool.executeCalls).toBe(0);
});

it("recipe tool uses the SDK permission provider when no ACP bridge is connected", async () => {
	const recipeTool = makeFakeTool("recipe");
	const requests: ClientBridgePermissionToolCall[] = [];
	session = await createSession([recipeTool], undefined, "prompt");
	session.setSdkPermissionProvider(async toolCall => {
		requests.push(toolCall);
		return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
	});

	await session.setActiveToolsByName(["recipe"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "recipe");
	expect(wrapped).toBeDefined();

	await wrapped!.execute("call-recipe-sdk", { op: "test" }, undefined, undefined as never, undefined as never);

	expect(requests.map(({ toolName, title, kind }) => ({ toolName, title, kind }))).toEqual([
		{ toolName: "recipe", title: "test", kind: "execute" },
	]);
	expect(recipeTool.executeCalls).toBe(1);
});

it("still allows a tool outside the permission set to run when the session permission mode is deny", async () => {
	const readTool = makeFakeTool("read");
	const bridge = makeBridge({ outcome: "cancelled" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([readTool], bridge, "deny");

	await session.setActiveToolsByName(["read"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "read");
	expect(wrapped).toBeDefined();

	await wrapped!.execute("call-read-deny-still-allowed", {}, undefined, undefined as never, undefined as never);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(readTool.executeCalls).toBe(1);
});

it("still allows the recipe tool when the session permission mode is allow", async () => {
	const recipeTool = makeFakeTool("recipe");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([recipeTool], bridge, "allow");

	await session.setActiveToolsByName(["recipe"]);
	const wrapped = session.agent.state.tools.find(t => t.name === "recipe");
	expect(wrapped).toBeDefined();

	await wrapped!.execute(
		"call-recipe-allow",
		{ op: "build --release" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(recipeTool.executeCalls).toBe(1);
});
