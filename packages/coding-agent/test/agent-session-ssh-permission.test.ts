/**
 * SSH uses the same ACP/SDK permission gate as bash.
 * Deny and an unconnected prompt refuse the remote command; allow still runs it.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
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
const remote = { host: "build", command: "uname -a" };

function makeFakeTool(name: string): AgentTool & { executeCalls: number } {
	const tool = {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: z.object({ command: z.string().optional(), host: z.string().optional() }),
		executeCalls: 0,
		async execute() {
			tool.executeCalls++;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function makeBridge(outcome: ClientBridgePermissionOutcome): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		async requestPermission() {
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

async function activeSsh(sess: AgentSession): Promise<AgentTool> {
	await sess.setActiveToolsByName(["ssh"]);
	const wrapped = sess.agent.state.tools.find(t => t.name === "ssh");
	expect(wrapped).toBeDefined();
	return wrapped!;
}

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-ssh-permission-test-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	await tempDir.remove();
});

it("ssh tool is rejected when the session permission mode is deny", async () => {
	const sshTool = makeFakeTool("ssh");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([sshTool], bridge, "deny");
	const wrapped = await activeSsh(session);
	await expect(
		wrapped.execute("call-ssh-deny", remote, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/rejected by session permission policy \(ssh\)/);
	expect(permissionSpy).not.toHaveBeenCalled();
	expect(sshTool.executeCalls).toBe(0);
});

it("ssh tool is rejected in prompt mode when no permission provider is connected", async () => {
	const sshTool = makeFakeTool("ssh");
	session = await createSession([sshTool], undefined, "prompt");
	const wrapped = await activeSsh(session);
	await expect(
		wrapped.execute("call-ssh-unconnected", remote, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/no permission provider is connected \(ssh\)/);
	expect(sshTool.executeCalls).toBe(0);
});

it("ssh tool takes the ACP permission path before executing", async () => {
	const sshTool = makeFakeTool("ssh");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([sshTool], bridge);
	const wrapped = await activeSsh(session);
	await wrapped.execute("call-ssh", remote, undefined, undefined as never, undefined as never);
	expect(requests.map(({ toolName, title, kind }) => ({ toolName, title, kind }))).toEqual([
		{ toolName: "ssh", title: "uname -a", kind: "execute" },
	]);
	expect(sshTool.executeCalls).toBe(1);
});

it("still allows the ssh tool when the session permission mode is allow", async () => {
	const sshTool = makeFakeTool("ssh");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([sshTool], bridge, "allow");
	const wrapped = await activeSsh(session);
	await wrapped.execute("call-ssh-allow", remote, undefined, undefined as never, undefined as never);
	expect(permissionSpy).not.toHaveBeenCalled();
	expect(sshTool.executeCalls).toBe(1);
});
