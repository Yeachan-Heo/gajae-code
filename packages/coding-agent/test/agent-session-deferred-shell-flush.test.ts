/**
 * Regression coverage for the deferred `!`/`$` publication boundary (PR #4039).
 *
 * A shell block submitted while the agent is streaming is deferred so it cannot
 * split a tool_use/tool_result pair. The deferral must end when that turn ends:
 * `AgentSession.prompt()` resolving is the point where the block's output has to
 * own a place in agent state and in the session. Holding it until the *next*
 * prompt leaves the TUI showing output the transcript does not have, and leaves
 * `onPersisted` (the signal a transcript rebuild uses to decide whether the live
 * block or the session row renders the execution) unfired for the whole gap.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { PythonResult } from "@gajae-code/coding-agent/eval/py/executor";
import type { BashResult } from "@gajae-code/coding-agent/exec/bash-executor";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const model: Model = {
	id: "deferred-shell-model",
	name: "deferred-shell-model",
	provider: "mock",
	api: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
};

function shellResult(output: string): BashResult & PythonResult {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: output.length,
		outputLines: 1,
		outputBytes: output.length,
		displayOutputs: [],
		stdinRequested: false,
	};
}

interface Turn {
	/** Resolves once the model stream has opened and the session reports streaming. */
	readonly started: Promise<void>;
	/** Ends the model stream, letting the turn tear down. */
	finish(): void;
}

interface Harness {
	session: AgentSession;
	agent: Agent;
	sessionManager: SessionManager;
	/** Starts a turn and waits until the stream is open. */
	startTurn(text: string): Promise<{ prompt: Promise<void>; turn: Turn }>;
}

function createHarness(sessions: AgentSession[]): Harness {
	let pendingTurn: { started: PromiseWithResolvers<void>; finish: PromiseWithResolvers<void> } | undefined;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["system prompt"], messages: [], tools: [] },
		streamFn: () => {
			const turn = pendingTurn;
			const stream = new AssistantMessageEventStream();
			void (async () => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				turn?.started.resolve();
				await turn?.finish.promise;
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
			})();
			return stream;
		},
	});
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
	});
	sessions.push(session);

	return {
		session,
		agent,
		sessionManager,
		startTurn: async (text: string) => {
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			pendingTurn = { started, finish };
			const prompt = session.prompt(text);
			await started.promise;
			expect(session.isStreaming).toBe(true);
			return { prompt, turn: { started: started.promise, finish: () => finish.resolve() } };
		},
	};
}

function shellMessages(messages: readonly AgentMessage[], role: "bashExecution" | "pythonExecution"): AgentMessage[] {
	return messages.filter(message => message.role === role);
}

function persistedShellMessages(
	sessionManager: SessionManager,
	role: "bashExecution" | "pythonExecution",
): AgentMessage[] {
	return sessionManager
		.getEntries()
		.filter(entry => entry.type === "message")
		.map(entry => (entry as { message: AgentMessage }).message)
		.filter(message => message.role === role);
}

describe("deferred shell execution publication boundary", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("publishes a bash block that completed mid-stream when that same turn ends", async () => {
		const harness = createHarness(sessions);
		const { prompt, turn } = await harness.startTurn("hello");

		const persistedCalls: string[] = [];
		harness.session.recordBashResult("printf mid", shellResult("mid"), {
			onPersisted: () => persistedCalls.push("printf mid"),
		});

		// Still streaming: publishing here would split the in-flight turn's messages.
		expect(shellMessages(harness.agent.state.messages, "bashExecution")).toHaveLength(0);
		expect(persistedCalls).toEqual([]);

		turn.finish();
		await prompt;

		// The turn is over. The output the user already saw must now be transcript.
		expect(persistedCalls).toEqual(["printf mid"]);
		const inAgentState = shellMessages(harness.agent.state.messages, "bashExecution");
		expect(inAgentState).toHaveLength(1);
		expect(inAgentState[0]).toMatchObject({ command: "printf mid", output: "mid", exitCode: 0 });
		expect(persistedShellMessages(harness.sessionManager, "bashExecution")).toHaveLength(1);
		expect(harness.session.hasPendingBashMessages).toBe(false);
	});

	it("publishes a python block that completed mid-stream when that same turn ends", async () => {
		const harness = createHarness(sessions);
		const { prompt, turn } = await harness.startTurn("hello");

		const persistedCalls: string[] = [];
		harness.session.recordPythonResult("print('mid')", shellResult("mid"), {
			onPersisted: () => persistedCalls.push("print('mid')"),
		});

		expect(shellMessages(harness.agent.state.messages, "pythonExecution")).toHaveLength(0);
		expect(persistedCalls).toEqual([]);

		turn.finish();
		await prompt;

		expect(persistedCalls).toEqual(["print('mid')"]);
		const inAgentState = shellMessages(harness.agent.state.messages, "pythonExecution");
		expect(inAgentState).toHaveLength(1);
		expect(inAgentState[0]).toMatchObject({ code: "print('mid')", output: "mid", exitCode: 0 });
		expect(persistedShellMessages(harness.sessionManager, "pythonExecution")).toHaveLength(1);
		expect(harness.session.hasPendingPythonMessages).toBe(false);
	});

	it("does not republish a turn-end-published block on the following prompt", async () => {
		const harness = createHarness(sessions);
		const first = await harness.startTurn("hello");

		harness.session.recordBashResult("printf once", shellResult("once"), {});
		first.turn.finish();
		await first.prompt;
		expect(shellMessages(harness.agent.state.messages, "bashExecution")).toHaveLength(1);

		const second = await harness.startTurn("again");
		second.turn.finish();
		await second.prompt;

		expect(shellMessages(harness.agent.state.messages, "bashExecution")).toHaveLength(1);
		expect(persistedShellMessages(harness.sessionManager, "bashExecution")).toHaveLength(1);
	});

	it("publishes a block recorded after the turn already ended immediately", async () => {
		const harness = createHarness(sessions);
		const { prompt, turn } = await harness.startTurn("hello");
		turn.finish();
		await prompt;

		const persistedCalls: string[] = [];
		harness.session.recordBashResult("printf late", shellResult("late"), {
			onPersisted: () => persistedCalls.push("printf late"),
		});

		expect(persistedCalls).toEqual(["printf late"]);
		expect(shellMessages(harness.agent.state.messages, "bashExecution")).toHaveLength(1);
		expect(persistedShellMessages(harness.sessionManager, "bashExecution")).toHaveLength(1);
	});
});
