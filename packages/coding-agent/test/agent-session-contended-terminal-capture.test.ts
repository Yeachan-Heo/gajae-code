import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ensureWorkflowSkillActivationState } from "@gajae-code/coding-agent/hooks/skill-state";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@gajae-code/utils";

describe("AgentSession contended terminal assistant capture (#4565 finding)", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let sessionManager: SessionManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	it("still schedules the deep-interview continuation when the terminal's admission is contended behind a gated spill", async () => {
		tempDir = TempDir.createSync("@gjc-contended-di-capture-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");

		// Gate the oversized tool result's spill so the terminal assistant's
		// admission predecessor stays in flight: the contended case the
		// synchronous fast path cannot shortcut.
		const spillGate = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: {
				model: { ...model, contextWindow: 200_000, maxTokens: 128_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		sessionManager = SessionManager.inMemory(tempDir.path());
		(sessionManager as unknown as { saveArtifact: typeof sessionManager.saveArtifact }).saveArtifact = async () => {
			await spillGate.promise;
			return { uri: "artifact://1", bytes: 4, sha256: "0".repeat(64) } as never;
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "tools.preAdmissionArtifactSpill": true }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		await ensureWorkflowSkillActivationState({
			cwd: tempDir.path(),
			skill: "deep-interview",
			sessionId: sessionManager.getSessionId(),
		});

		const continueSpy = vi.spyOn(agent, "continue").mockImplementation(async () => Promise.resolve()) as never;

		const mkAssistant = (
			text: string,
			timestamp: number,
			stopReason: AssistantMessage["stopReason"],
			withToolCall = false,
		): AssistantMessage => ({
			role: "assistant",
			content: withToolCall
				? [
						{ type: "text", text },
						{ type: "toolCall", id: `call-${timestamp}`, name: "read", arguments: { path: "/tmp/x" } },
					]
				: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp,
		});

		// Previous turn: a mid-loop toolUse assistant. If the agent_end read
		// resolves to THIS stale capture, hasToolCalls short-circuits the stop
		// handling and the terminal's deep-interview continuation is silently
		// skipped — exactly the #4565 double-process/skip failure mode.
		const midLoop = mkAssistant("mid-loop turn", 100, "toolUse", true);
		const gatedToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-100",
			toolName: "read",
			content: [{ type: "text", text: "z".repeat(40_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		const terminal = mkAssistant("interview round complete", 200, "stop");

		agent.emitExternalEvent({ type: "turn_start" });
		agent.emitExternalEvent({ type: "message_end", message: midLoop });
		await Bun.sleep(10);
		agent.emitExternalEvent({ type: "message_end", message: gatedToolResult });
		await Bun.sleep(10);
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		await Bun.sleep(25);

		// Terminal agent_end arrives while the terminal admission is parked.
		agent.emitExternalEvent({ type: "agent_end", messages: [terminal] });

		// The deep-interview stop check runs async durable state reads; allow
		// them, then release the gate and settle.
		await Bun.sleep(50);
		spillGate.resolve();
		await withTimeout(session.awaitSessionSettlement(), 5_000, "gated admission deadlocked");
		await session.waitForIdle();

		// The terminal stop must have reached the deep-interview stop gate and
		// scheduled its continuation. Stale capture -> hasToolCalls -> no call.
		expect(continueSpy).toHaveBeenCalled();
		const entries = sessionManager.getBranch();
		const reminderIndex = entries.findIndex(
			entry =>
				entry.type === "message" &&
				entry.message.role === "developer" &&
				JSON.stringify(entry.message.content).includes("stop gate: gjc_skill_deep_interview_"),
		);
		expect(reminderIndex).toBeGreaterThanOrEqual(0);
		// FIFO on reload: the continuation reminder must persist AFTER the
		// terminal assistant (and the gated tool result) it responds to.
		const terminalIndex = entries.findIndex(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				JSON.stringify((entry.message as { content?: unknown }).content).includes("interview round complete"),
		);
		expect(terminalIndex).toBeGreaterThanOrEqual(0);
		expect(reminderIndex).toBeGreaterThan(terminalIndex);
	});
});
