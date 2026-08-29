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
		modelRegistry: { getApiKey: async () => "test-key", getAuthStorageOwner: () => ({}) } as never,
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
function bashCommands(messages: readonly AgentMessage[]): string[] {
	return messages
		.filter(
			(message): message is AgentMessage & { role: "bashExecution"; command: string } =>
				message.role === "bashExecution",
		)
		.map(message => message.command);
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
	it("reports partial publication and retries persistence without duplicating agent state", async () => {
		const harness = createHarness(sessions);
		const first = await harness.startTurn("hello");

		const persistedCalls: string[] = [];
		harness.session.recordBashResult("printf retry", shellResult("retry"), {
			onPersisted: () => persistedCalls.push("bash"),
		});
		harness.session.recordPythonResult("print('still flushes')", shellResult("python"), {
			onPersisted: () => persistedCalls.push("python"),
		});
		await harness.session.respondAsBackground({ from: "0-Main", message: "ping", awaitReply: false });

		const appendMessage = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let failBashOnce = true;
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation(message => {
			if (message.role === "bashExecution" && failBashOnce) {
				failBashOnce = false;
				throw new Error("transient bash persistence failure");
			}
			return appendMessage(message);
		});

		first.turn.finish();
		await expect(first.prompt).rejects.toThrow(
			'Failed to persist 1 of 1 deferred bash execution message; 0 persisted, failed messages remain pending for retry; persisted: []; pending: ["printf retry"]',
		);

		expect(shellMessages(harness.agent.state.messages, "bashExecution")).toHaveLength(1);
		expect(persistedShellMessages(harness.sessionManager, "bashExecution")).toHaveLength(0);
		expect(harness.session.hasPendingBashMessages).toBe(true);

		expect(shellMessages(harness.agent.state.messages, "pythonExecution")).toHaveLength(1);
		expect(persistedShellMessages(harness.sessionManager, "pythonExecution")).toHaveLength(1);
		expect(harness.session.hasPendingPythonMessages).toBe(false);
		expect(persistedCalls).toEqual(["python"]);
		expect(
			harness.agent.state.messages.filter(
				message => message.role === "custom" && String(message.customType).startsWith("irc:"),
			),
		).toHaveLength(1);

		const second = await harness.startTurn("again");
		second.turn.finish();
		await second.prompt;

		expect(shellMessages(harness.agent.state.messages, "bashExecution")).toHaveLength(1);
		expect(persistedShellMessages(harness.sessionManager, "bashExecution")).toHaveLength(1);
		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(persistedCalls).toEqual(["python", "bash"]);
	});

	it("retries failed bash blocks without reordering the persisted transcript", async () => {
		const harness = createHarness(sessions);
		const first = await harness.startTurn("hello");

		for (let index = 1; index <= 5; index++) {
			harness.session.recordBashResult(`cmd${index}`, shellResult(`out${index}`), {});
		}

		const appendMessage = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let failCmd3Once = true;
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation(message => {
			if (message.role === "bashExecution" && message.command === "cmd3" && failCmd3Once) {
				failCmd3Once = false;
				throw new Error("transient cmd3 persistence failure");
			}
			return appendMessage(message);
		});

		first.turn.finish();
		await expect(first.prompt).rejects.toThrow(
			'Failed to persist 3 of 5 deferred bash execution messages; 2 persisted, failed messages remain pending for retry; persisted: ["cmd1","cmd2"]; pending: ["cmd3","cmd4","cmd5"]',
		);

		expect(bashCommands(harness.agent.state.messages)).toEqual(["cmd1", "cmd2", "cmd3", "cmd4", "cmd5"]);
		expect(bashCommands(persistedShellMessages(harness.sessionManager, "bashExecution"))).toEqual(["cmd1", "cmd2"]);

		const second = await harness.startTurn("again");
		second.turn.finish();
		await second.prompt;

		expect(bashCommands(harness.agent.state.messages)).toEqual(["cmd1", "cmd2", "cmd3", "cmd4", "cmd5"]);
		expect(bashCommands(persistedShellMessages(harness.sessionManager, "bashExecution"))).toEqual([
			"cmd1",
			"cmd2",
			"cmd3",
			"cmd4",
			"cmd5",
		]);
	});

	it("preserves bash block order across multiple persistence failures", async () => {
		const harness = createHarness(sessions);
		const first = await harness.startTurn("hello");

		for (let index = 1; index <= 5; index++) {
			harness.session.recordBashResult(`cmd${index}`, shellResult(`out${index}`), {});
		}

		const appendMessage = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		const remainingFailures = new Set(["cmd2", "cmd4"]);
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation(message => {
			if (message.role === "bashExecution" && remainingFailures.delete(message.command)) {
				throw new Error(`transient ${message.command} persistence failure`);
			}
			return appendMessage(message);
		});

		first.turn.finish();
		await expect(first.prompt).rejects.toThrow(
			'Failed to persist 4 of 5 deferred bash execution messages; 1 persisted, failed messages remain pending for retry; persisted: ["cmd1"]; pending: ["cmd2","cmd3","cmd4","cmd5"]',
		);

		await expect(harness.session.prompt("again")).rejects.toThrow(
			'Failed to persist 2 of 4 deferred bash execution messages; 2 persisted, failed messages remain pending for retry; persisted: ["cmd2","cmd3"]; pending: ["cmd4","cmd5"]',
		);

		const third = await harness.startTurn("again");
		third.turn.finish();
		await third.prompt;

		expect(bashCommands(harness.agent.state.messages)).toEqual(["cmd1", "cmd2", "cmd3", "cmd4", "cmd5"]);
		expect(bashCommands(persistedShellMessages(harness.sessionManager, "bashExecution"))).toEqual([
			"cmd1",
			"cmd2",
			"cmd3",
			"cmd4",
			"cmd5",
		]);
	});

	it("publishes agent_end before a deferred persistence rejection settles", async () => {
		const harness = createHarness(sessions);
		const events: string[] = [];
		harness.session.subscribe(event => events.push(event.type));
		const first = await harness.startTurn("hello");
		harness.session.recordBashResult("cmd1", shellResult("out1"), {});

		const appendMessage = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation(message => {
			if (message.role === "bashExecution") throw new Error("transient persistence failure");
			return appendMessage(message);
		});

		first.turn.finish();
		await expect(first.prompt).rejects.toThrow(
			'Failed to persist 1 of 1 deferred bash execution message; 0 persisted, failed messages remain pending for retry; persisted: []; pending: ["cmd1"]',
		);

		expect(events.at(-1)).toBe("agent_end");
		expect(events.indexOf("turn_end")).toBeLessThan(events.indexOf("agent_end"));
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

	it("auto-delivers steering queued during post-prompt unwind for every terminal role", async () => {
		for (const role of ["assistant", "bashExecution", "pythonExecution"] as const) {
			const harness = createHarness(sessions);
			const steerQueued = Promise.withResolvers<void>();
			let queued = false;
			const queueSteer = () => {
				if (queued) return;
				queued = true;
				void harness.session.steer(`steer after ${role}`).then(steerQueued.resolve, steerQueued.reject);
			};
			const unsubscribe =
				role === "assistant"
					? harness.session.subscribe(event => {
							if (event.type === "agent_end") queueSteer();
						})
					: undefined;
			const first = await harness.startTurn("hello");
			if (role === "bashExecution") {
				harness.session.recordBashResult("printf unwind", shellResult("unwind"), { onPersisted: queueSteer });
			} else if (role === "pythonExecution") {
				harness.session.recordPythonResult("print('unwind')", shellResult("unwind"), { onPersisted: queueSteer });
			}

			first.turn.finish();
			await first.prompt;
			await steerQueued.promise;
			await harness.session.waitForIdle();
			unsubscribe?.();

			expect(harness.agent.hasQueuedSteering()).toBe(false);
			expect(harness.agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(2);
			expect(
				harness.agent.state.messages.some(
					message => message.role === "user" && JSON.stringify(message.content).includes(`steer after ${role}`),
				),
			).toBe(true);
		}
	});
});
