import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockModelOptions } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { createSdkRunCapability } from "../src/session/sdk-run-capability-internal";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for condition");
}

/**
 * Steer-on-interrupt contract (deep-interview spec, AC-1/AC-4):
 *  - a user interrupt (Esc) with queued steering resumes by draining the
 *    steering queue instead of going idle;
 *  - any non-user (lifecycle/teardown) abort suppresses the resume.
 */
describe("AgentSession steer-on-interrupt", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-steer-interrupt-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function buildSession(responses: Array<{ content: string[] }>): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	function assistantCount(s: AgentSession): number {
		return s.agent.state.messages.filter(m => m.role === "assistant").length;
	}

	async function promptAndWaitForAssistant(s: AgentSession, text: string): Promise<void> {
		const assistantEnded = Promise.withResolvers<void>();
		const unsubscribe = s.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") assistantEnded.resolve();
		});
		try {
			await Promise.all([s.prompt(text), assistantEnded.promise]);
			await s.waitForIdle();
		} finally {
			unsubscribe();
		}
	}

	it("a steer after the turn ended is never parked in the agent queue", async () => {
		session = buildSession([{ content: ["first done"] }, { content: ["handled steering"] }]);

		await promptAndWaitForAssistant(session, "first task");
		expect(assistantCount(session)).toBe(1);

		// Enqueue-time admission: no live run, so the Agent refuses the steer
		// instead of orphaning it for whichever run polls next.
		expect(session.agent.steer(userMessage("also handle the steer"))).toEqual({ admitted: false, reason: "idle" });
		expect(session.agent.hasQueuedSteering()).toBe(false);

		await session.abort({ cause: "user_interrupt" });
		await session.waitForIdle();
		expect(assistantCount(session)).toBe(1);
	});

	it("rejects a steer bound to an ended SDK run instead of delivering it to a successor", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const successorStarted = Promise.withResolvers<void>();
		const releaseSuccessor = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { content: ["first completed"] };
				},
				async () => {
					successorStarted.resolve();
					await releaseSuccessor.promise;
					return { content: ["successor completed"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const endedToken = "command-first:turn-first";
		const successorToken = "command-successor:turn-successor";
		const sendBoundSteer = (text: string, expectedSdkRunToken: string) =>
			session!.sendUserMessage(text, { deliverAs: "steer", expectedSdkRunToken } as never);

		let first: Promise<void> | undefined;
		let successor: Promise<void> | undefined;
		try {
			first = session.sendUserMessage("first task", { sdkRunCapability: createSdkRunCapability(endedToken) });
			await firstStarted.promise;
			releaseFirst.resolve();
			await first;
			await session.waitForIdle();

			successor = session.sendUserMessage("successor task", {
				sdkRunCapability: createSdkRunCapability(successorToken),
			});
			await successorStarted.promise;
			await expect(sendBoundSteer("stale steer from first run", endedToken)).rejects.toMatchObject({
				code: "turn_not_active",
			});

			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			expect(
				mock.calls[1]!.context.messages.some(
					message =>
						message.role === "user" && JSON.stringify(message.content).includes("stale steer from first run"),
				),
			).toBe(false);
			releaseSuccessor.resolve();
			await successor;
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(2);
		} finally {
			releaseFirst.resolve();
			releaseSuccessor.resolve();
			await Promise.all([first?.catch(() => {}), successor?.catch(() => {})]);
		}
	});

	it("admits an SDK-bound steer when its expected run token is live", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { content: ["first completed"] };
				},
				{ content: ["handled live steer"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const liveToken = "command-live:turn-live";
		const sendBoundSteer = (text: string) =>
			session!.sendUserMessage(text, { deliverAs: "steer", expectedSdkRunToken: liveToken } as never);

		let running: Promise<void> | undefined;
		try {
			running = session.sendUserMessage("first task", { sdkRunCapability: createSdkRunCapability(liveToken) });
			await firstStarted.promise;
			await sendBoundSteer("steer this live run");
			expect(session.getQueuedMessages()).toEqual({ steering: ["steer this live run"], followUp: [] });
			releaseFirst.resolve();
			await running.catch(() => {});
			await session.waitForIdle();

			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			expect(
				session.agent.state.messages.some(
					message => message.role === "user" && JSON.stringify(message.content).includes("steer this live run"),
				),
			).toBe(true);
		} finally {
			releaseFirst.resolve();
			await running?.catch(() => {});
		}
	});

	it("delivers a steer queued while the agent is idle without a user interrupt", async () => {
		session = buildSession([{ content: ["first done"] }, { content: ["handled steering"] }]);

		await promptAndWaitForAssistant(session, "first task");
		expect(assistantCount(session)).toBe(1);

		// A steer lands while no live agent loop is running (the busy/unwind window
		// the interactive composer routes through). It must be delivered promptly
		// instead of stalling until the user presses Esc.
		await session.steer("also handle the steer");
		await session.waitForIdle();

		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(assistantCount(session)).toBe(2);
		expect(
			session.agent.state.messages.some(
				m => m.role === "user" && JSON.stringify(m.content).includes("also handle the steer"),
			),
		).toBe(true);
	});

	it("drains all wait-mode steering messages into one successor turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({
			responses: [{ content: ["first done"], delayMs: 60_000 }, { content: ["handled both steers"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			toolInterruptPolicy: "finish_tools",
			steeringMode: "all",
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const first = session.prompt("first task");
		await waitUntil(() => agent.state.isStreaming && mock.calls.length === 1);
		await session.prompt("steer one", { streamingBehavior: "steer" });
		await session.prompt("steer two", { streamingBehavior: "steer" });
		expect(session.getQueuedMessages().steering).toEqual(["steer one", "steer two"]);

		// The wait-mode turn must be interrupted after both steers are admitted.
		// The provider is still blocked when the real Esc/user-interrupt path claims
		// the abort, so the successor is exercised through settlement rearm rather
		// than the ordinary in-loop boundary.
		const aborting = session.abort({ cause: "user_interrupt" });
		await aborting;
		await first.catch(() => {});
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		const successorUserMessages = mock.calls[1]!.context.messages.filter(message => message.role === "user").map(
			message => JSON.stringify(message.content),
		);
		expect(successorUserMessages.slice(-2)).toEqual([
			JSON.stringify([{ type: "text", text: "steer one" }]),
			JSON.stringify([{ type: "text", text: "steer two" }]),
		]);
	});

	it("lets the abort rearm own steering admitted during unwind", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const abortHookStarted = Promise.withResolvers<void>();
		const releaseAbortHook = Promise.withResolvers<void>();
		const successorGate = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				{ content: ["first done"], delayMs: 60_000 },
				async () => {
					await successorGate.promise;
					return { content: ["handled both steers"] };
				},
				{ content: ["unexpected extra turn"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			toolInterruptPolicy: "finish_tools",
			steeringMode: "all",
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		vi.spyOn(session.goalRuntime, "onTaskAborted").mockImplementation(async () => {
			abortHookStarted.resolve();
			await releaseAbortHook.promise;
		});

		const first = session.prompt("first task");
		await waitUntil(() => agent.state.isStreaming && mock.calls.length === 1);
		const aborting = session.abort({ cause: "user_interrupt" });
		await abortHookStarted.promise;

		// While abort cleanup owns the boundary, enqueue-time admission rejects each
		// steer from the dying run and routes the cohort as follow-ups for the one
		// rearm continuation. Without that fence, the first message starts an
		// independent continuation before the second message is queued.
		await session.steer("steer one");
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(mock.calls).toHaveLength(1);
		await session.steer("steer two");
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["steer one", "steer two"] });

		successorGate.resolve();
		releaseAbortHook.resolve();
		await aborting;
		await first.catch(() => {});
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		const successorUserMessages = mock.calls[1]!.context.messages.filter(message => message.role === "user").map(
			message => JSON.stringify(message.content),
		);
		expect(successorUserMessages.slice(-2)).toEqual([
			JSON.stringify([{ type: "text", text: "steer one" }]),
			JSON.stringify([{ type: "text", text: "steer two" }]),
		]);
	});

	// Execution-drain path: the steer is queued while two shared tools run. Tool A
	// completing lets the tool-execution steering check consume the steer
	// (steeringMessagesFromExecution) and interrupt the remaining tools; tool B's
	// unwind is where the user interrupt lands, aborting the run's signal before
	// the loop reaches its execution-drain continue. That continue must requeue and
	// break on an aborted signal, or the steer opens a turn born aborted.
	it("delivers steering consumed mid-batch when a user abort lands while the interrupted sibling tool unwinds", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let releaseA: (() => void) | undefined;
		let releaseB: (() => void) | undefined;
		let agentRef: Agent | undefined;
		const bothStarted = { a: false, b: false };
		let resolveBothStarted: () => void;
		const bothStartedPromise = new Promise<void>(resolve => {
			resolveBothStarted = resolve;
		});
		const markStarted = (which: "a" | "b") => {
			bothStarted[which] = true;
			if (bothStarted.a && bothStarted.b) resolveBothStarted();
		};
		const makeTool = (name: string, which: "a" | "b") => ({
			name,
			description: `Blocking tool ${name}.`,
			parameters: { type: "object" as const, properties: {} },
			execute: async () => {
				markStarted(which);
				await new Promise<void>(resolve => {
					if (which === "a") releaseA = resolve;
					else releaseB = resolve;
				});
				if (which === "b") {
					// The user interrupt lands while the steer-interrupted sibling tool
					// unwinds — after the steering check consumed the steer, before the
					// loop reaches its execution-drain continue.
					agentRef?.abort();
				}
				return { content: [{ type: "text" as const, text: `${name} finished` }] };
			},
		});
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", name: "toola", arguments: {} },
						{ type: "toolCall", name: "toolb", arguments: {} },
					],
				},
				{ content: ["handled steering"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [makeTool("toola", "a") as never, makeTool("toolb", "b") as never],
				messages: [],
			},
			streamFn: mock.stream,
		});
		agentRef = agent;
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const running = session.prompt("run both tools");
		await bothStartedPromise;
		session.agent.steer(userMessage("stop and do this instead"));
		// A completes first: the steering check consumes the queued steer and
		// interrupts the batch. Only once the steer has left the queue does B's
		// unwind land the user interrupt, so the run reaches its execution-drain
		// continue with the steer consumed and the signal aborted.
		releaseA?.();
		while (session.agent.hasQueuedSteering()) await Bun.sleep(1);
		releaseB?.();
		await running.catch(() => {});
		await session.abort({ cause: "user_interrupt" });
		await session.waitForIdle();

		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(
			session.agent.state.messages.some(
				m => m.role === "user" && JSON.stringify(m.content).includes("stop and do this instead"),
			),
		).toBe(true);
		const stopReasons = session.agent.state.messages
			.filter(m => m.role === "assistant")
			.map(m => (m as { stopReason?: string }).stopReason);
		expect(stopReasons).toEqual(["toolUse", "stop"]);
	});

	// Sibling path to the in-flight-tool drain below: with the default immediate
	// interrupt mode, the tool-execution steering check consumes a steer queued
	// while the tool runs (steeringMessagesFromExecution) and unwinds the tool
	// itself. A user interrupt that lands during that unwind aborts the run's
	// signal AFTER the steer left the queue, so the post-turn drain never sees it.
	// The execution-drain continue must apply the same aborted-run guard — requeue
	// and break — or the steer is answered by a turn born aborted and the session
	// goes idle.
	it("delivers steering consumed by the tool-execution interrupt when a user abort lands during unwind", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let releaseTool: (() => void) | undefined;
		let agentRef: Agent | undefined;
		const toolStarted = Promise.withResolvers<void>();
		const blockingTool = {
			name: "blocks",
			description: "Blocks until released so the steering check consumes the queued steer.",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => {
				toolStarted.resolve();
				await new Promise<void>(resolve => {
					releaseTool = resolve;
				});
				// The user interrupt lands as the tool unwinds — after the steer was
				// queued, before the loop's steering drains run — so the abort is
				// fully landed when the tool-execution steering check consumes the
				// steer into steeringMessagesFromExecution.
				agentRef?.abort();
				return { content: [{ type: "text" as const, text: "tool finished" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "blocks", arguments: {} }] },
				{ content: ["handled steering"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [blockingTool as never], messages: [] },
			streamFn: mock.stream,
		});
		agentRef = agent;
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const running = session.prompt("run the blocking tool");
		await toolStarted.promise;
		session.agent.steer(userMessage("stop and do this instead"));
		releaseTool?.();
		// The aborted run requeues the consumed steer and ends; awaiting the
		// settled prompt guarantees the requeue landed. The session-level user
		// interrupt then runs the resume check that starts a fresh run for it.
		await running.catch(() => {});
		await session.abort({ cause: "user_interrupt" });
		await session.waitForIdle();

		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(
			session.agent.state.messages.some(
				m => m.role === "user" && JSON.stringify(m.content).includes("stop and do this instead"),
			),
		).toBe(true);
		const stopReasons = session.agent.state.messages
			.filter(m => m.role === "assistant")
			.map(m => (m as { stopReason?: string }).stopReason);
		expect(stopReasons).toEqual(["toolUse", "stop"]);
	});

	// A user interrupt that lands while a tool is executing aborts the run's signal
	// without ending the loop: the loop still unwinds the tool and reaches its
	// steering drain. Consuming the steer there opened a turn on the aborted
	// signal, which the provider rejects before the first token — so the steer was
	// delivered and answered by an instantly-aborted turn, and the session went
	// idle showing only "Operation aborted". Interrupting a tool must hand the
	// steer to a fresh run instead.
	it("delivers queued steering after interrupting an in-flight tool", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let releaseTool: (() => void) | undefined;
		const toolStarted = Promise.withResolvers<void>();
		const blockingTool = {
			name: "blocks",
			description: "Blocks until released so an interrupt can land mid-execution.",
			parameters: { type: "object" as const, properties: {} },
			execute: async () => {
				toolStarted.resolve();
				await new Promise<void>(resolve => {
					releaseTool = resolve;
				});
				return { content: [{ type: "text" as const, text: "tool finished" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "blocks", arguments: {} }] },
				{ content: ["handled steering"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [blockingTool as never], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const running = session.prompt("run the blocking tool");
		await toolStarted.promise;

		session.agent.steer(userMessage("stop and do this instead"));
		await session.abort({ cause: "user_interrupt" });
		releaseTool?.();
		await running.catch(() => {});
		await session.waitForIdle();

		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(
			session.agent.state.messages.some(
				m => m.role === "user" && JSON.stringify(m.content).includes("stop and do this instead"),
			),
		).toBe(true);
		// The steer produced a real turn instead of a turn that was born aborted.
		const stopReasons = session.agent.state.messages
			.filter(m => m.role === "assistant")
			.map(m => (m as { stopReason?: string }).stopReason);
		expect(stopReasons).toEqual(["toolUse", "stop"]);
	});

	it("routes an idle steer as the next turn instead of leaving it for an abort to resume", async () => {
		session = buildSession([{ content: ["first done"] }, { content: ["delivered later"] }]);

		await promptAndWaitForAssistant(session, "first task");
		expect(assistantCount(session)).toBe(1);

		// Idle: the session routes the non-admitted steer as a follow-up owned by
		// the next turn and auto-continues into it.
		await session.steer("queued steer");
		await session.waitForIdle();
		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(assistantCount(session)).toBe(2);
	});

	async function settle(s: AgentSession): Promise<void> {
		for (let i = 0; i < 5; i++) {
			await s.waitForIdle();
			await Bun.sleep(20);
		}
		await s.waitForIdle();
	}

	// The unwind window: agent_end fired (agent idle) while the session still
	// reports streaming. Every steer surface must behave the same here — none may
	// leave an orphan in the Agent queue.
	it("delivers a custom steer and a public steer identically during the post-prompt unwind", async () => {
		for (const surface of ["custom", "public"] as const) {
			const s = buildSession([{ content: ["p0"] }, { content: ["p1"] }]);
			session = s;
			let sessionStreamingAtAgentEnd: boolean | undefined;
			const unsubscribe = s.agent.subscribe(event => {
				if (event.type !== "agent_end" || sessionStreamingAtAgentEnd !== undefined) return;
				sessionStreamingAtAgentEnd = s.isStreaming;
				const send =
					surface === "custom"
						? s.sendCustomMessage(
								{ customType: "test-steer", content: "in-unwind", display: false, attribution: "agent" },
								{ deliverAs: "steer" },
							)
						: s.steer("in-unwind");
				void send.catch(() => {});
			});
			await promptAndWaitForAssistant(s, "p0");
			await settle(s);
			unsubscribe();
			expect(sessionStreamingAtAgentEnd, surface).toBe(true);
			expect(s.agent.hasQueuedSteering(), surface).toBe(false);
			expect(s.agent.hasQueuedMessages(), surface).toBe(false);
			expect(assistantCount(s), surface).toBe(2);
			await s.dispose();
			session = undefined;
		}
	});

	it("queues a steer-behavior prompt submitted during another prompt's preflight instead of refusing it", async () => {
		session = buildSession([{ content: ["first"] }, { content: ["second"] }]);
		const s = session;
		const run = s.prompt("p0");
		// No await: the agent is idle and p0 is still acquiring session admission.
		expect(s.agent.state.isStreaming).toBe(false);
		await s.prompt("steer-early", { streamingBehavior: "steer" });
		await run;
		await settle(s);
		expect(s.agent.hasQueuedMessages()).toBe(false);
		const userTexts = s.agent.state.messages.filter(m => m.role === "user").map(m => JSON.stringify(m.content));
		expect(userTexts.some(t => t.includes("steer-early"))).toBe(true);
		expect(assistantCount(s)).toBe(2);
	});

	function blockingHarness(responses: Array<{ content: unknown[] }>) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const started = Promise.withResolvers<void>();
		let release: (() => void) | undefined;
		const tool = {
			name: "blocks",
			description: "Blocks until released.",
			parameters: { type: "object" as const, properties: {} },
			execute: async (_args: unknown, signal?: AbortSignal) => {
				started.resolve();
				await new Promise<void>(resolve => {
					release = resolve;
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text" as const, text: "tool finished" }] };
			},
		};
		const mock = createMockModel({ responses: responses as never });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [tool as never], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const s = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		return { s, mock, started: started.promise, release: () => release?.() };
	}

	it("drops steering the run disowns on a non-user abort and fires its hook exactly once", async () => {
		const h = blockingHarness([
			{ content: [{ type: "toolCall", name: "blocks", arguments: {} }] },
			{ content: ["should not run"] },
		]);
		session = h.s;
		const running = h.s.prompt("run the blocking tool").catch(() => {});
		await h.started;
		const promotions: unknown[] = [];
		await h.s.sendUserMessage("steer for the dying turn", {
			deliverAs: "steer",
			onQueuedPromoted: promotion => {
				promotions.push(promotion);
			},
		});
		expect(h.s.getQueuedMessages().steering).toEqual(["steer for the dying turn"]);
		await h.s.abort({ cause: "internal" });
		h.release();
		await running;
		await settle(h.s);
		// The SDK correlation settles exactly once (in-run consumption at the
		// aborting tool boundary, or removal at disown), never twice and never
		// as a promotion to a fresh run.
		expect(promotions).toHaveLength(1);
		expect(promotions[0]).toMatchObject({ startsOwnRun: false });
		expect(h.s.agent.hasQueuedMessages()).toBe(false);
		expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(h.mock.calls).toHaveLength(1);
	});

	it("re-routes steering the run disowns on a user interrupt as the next turn", async () => {
		const h = blockingHarness([
			{ content: [{ type: "toolCall", name: "blocks", arguments: {} }] },
			{ content: ["handled steering"] },
		]);
		session = h.s;
		const running = h.s.prompt("run the blocking tool").catch(() => {});
		await h.started;
		await h.s.steer("stop and do this instead");
		await h.s.abort({ cause: "user_interrupt" });
		h.release();
		await running;
		await settle(h.s);
		expect(h.s.agent.hasQueuedMessages()).toBe(false);
		expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		const users = h.s.agent.state.messages.filter(m => m.role === "user").map(m => JSON.stringify(m.content));
		expect(users.some(t => t.includes("stop and do this instead"))).toBe(true);
		expect(assistantCount(h.s)).toBe(2);
	});

	describe("run-bound steers (expectedPromptHandle)", () => {
		function buildHeldSession(responses: MockModelOptions["responses"]) {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Anthropic test model to exist");
			const mock = createMockModel({ responses });
			const agent = new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				toolInterruptPolicy: "finish_tools",
				steeringMode: "all",
				streamFn: mock.stream,
			});
			const settings = Settings.isolated({ "compaction.enabled": false });
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
			return { mock, agent, s: session };
		}
		const sendSteer = (s: AgentSession, text: string, expectedPromptHandle?: string | null) =>
			s.sendUserMessage(text, { deliverAs: "steer", expectedPromptHandle } as never);
		const sawText = (
			calls: Array<{ context: { messages: Array<{ role: string; content: unknown }> } }>,
			text: string,
		) =>
			calls.some(call =>
				call.context.messages.some(
					message => message.role === "user" && JSON.stringify(message.content).includes(text),
				),
			);

		it("drops an unconsumed bound steer when its run is interrupted while unbound steers rearm", async () => {
			const h = buildHeldSession([
				{ content: ["A done"], delayMs: 60_000 },
				{ content: ["B handled"] },
				{ content: ["unexpected"] },
			]);
			const first = h.s.prompt("task A");
			await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
			const handleA = h.s.activePromptHandle;
			expect(handleA).toBeDefined();
			await sendSteer(h.s, "bound-steer-held-9f1", handleA);
			await sendSteer(h.s, "unbound-steer-kept-4c2");
			expect(h.s.getQueuedMessages().steering).toEqual(["bound-steer-held-9f1", "unbound-steer-kept-4c2"]);

			await h.s.abort({ cause: "user_interrupt" });
			await first.catch(() => {});
			await h.s.waitForIdle();

			expect(h.mock.calls).toHaveLength(2);
			expect(sawText(h.mock.calls.slice(1), "unbound-steer-kept-4c2")).toBe(true);
			expect(sawText(h.mock.calls, "bound-steer-held-9f1")).toBe(false);
			expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			expect(h.agent.hasQueuedMessages()).toBe(false);
		});

		it("rejects a bound steer whose run ended and successor started during the admission await", async () => {
			const releaseA = Promise.withResolvers<void>();
			const releaseSuccessor = Promise.withResolvers<void>();
			const releaseCommit = Promise.withResolvers<void>();
			const h = buildHeldSession([
				async () => {
					await releaseA.promise;
					return { content: ["A done"] };
				},
				async () => {
					await releaseSuccessor.promise;
					return { content: ["B done"] };
				},
			]);
			let first: Promise<void> | undefined;
			let second: Promise<void> | undefined;
			try {
				first = h.s.prompt("task A");
				await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
				const handleA = h.s.activePromptHandle;
				const commitEntered = Promise.withResolvers<void>();
				const stale = h.s.sendUserMessage("stale-bound-after-await-7d3", {
					deliverAs: "steer",
					expectedPromptHandle: handleA,
					onPreflightAcceptCommit: async () => {
						commitEntered.resolve();
						await releaseCommit.promise;
					},
				} as never);
				stale.catch(() => {});
				await commitEntered.promise;

				// A ends naturally while the admission barrier is held; B starts before release.
				releaseA.resolve();
				await first;
				await h.s.waitForIdle();
				second = h.s.prompt("task B");
				await waitUntil(() => h.mock.calls.length === 2);
				expect(h.s.activePromptHandle).toBeDefined();
				expect(h.s.activePromptHandle).not.toBe(handleA);
				releaseCommit.resolve();

				await expect(stale).rejects.toMatchObject({ code: "turn_not_active" });
				expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
				releaseSuccessor.resolve();
				await second;
				await h.s.waitForIdle();
				expect(sawText(h.mock.calls, "stale-bound-after-await-7d3")).toBe(false);
				expect(h.mock.calls).toHaveLength(2);
			} finally {
				releaseA.resolve();
				releaseCommit.resolve();
				releaseSuccessor.resolve();
				await Promise.all([first?.catch(() => {}), second?.catch(() => {})]);
			}
		});

		it("drops an unconsumed bound steer when its run completes naturally instead of promoting it", async () => {
			const releaseA = Promise.withResolvers<void>();
			const h = buildHeldSession([
				async () => {
					await releaseA.promise;
					return { content: ["A done"] };
				},
				{ content: ["B done"] },
			]);
			let first: Promise<void> | undefined;
			let second: Promise<void> | undefined;
			try {
				first = h.s.prompt("task A");
				await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
				const handleA = h.s.activePromptHandle;
				// The run may not dequeue steering, so the bound steer is still unconsumed at its end.
				h.agent.setSteeringAdmissionFence(() => true);
				await sendSteer(h.s, "bound-natural-end-6c5", handleA);
				expect(h.s.getQueuedMessages().steering).toEqual(["bound-natural-end-6c5"]);

				releaseA.resolve();
				await first;
				h.agent.setSteeringAdmissionFence(undefined);
				await h.s.waitForIdle();
				expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
				expect(h.agent.hasQueuedMessages()).toBe(false);

				second = h.s.prompt("task B");
				await second;
				await h.s.waitForIdle();
				expect(h.mock.calls).toHaveLength(2);
				expect(sawText(h.mock.calls, "bound-natural-end-6c5")).toBe(false);
				expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			} finally {
				h.agent.setSteeringAdmissionFence(undefined);
				releaseA.resolve();
				await Promise.all([first?.catch(() => {}), second?.catch(() => {})]);
			}
		});

		it("rejects a null target without demoting it and leaves unbound steers unchanged", async () => {
			const h = buildHeldSession([{ content: ["A done"], delayMs: 60_000 }, { content: ["B handled"] }]);
			const first = h.s.prompt("task A");
			await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);

			await expect(sendSteer(h.s, "null-target-steer-2a8", null)).rejects.toMatchObject({
				code: "turn_not_active",
			});
			expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

			await sendSteer(h.s, "plain-unbound-steer-5e6");
			expect(h.s.getQueuedMessages()).toEqual({ steering: ["plain-unbound-steer-5e6"], followUp: [] });
			await h.s.abort({ cause: "user_interrupt" });
			await first.catch(() => {});
			await h.s.waitForIdle();
			expect(sawText(h.mock.calls, "plain-unbound-steer-5e6")).toBe(true);
			expect(sawText(h.mock.calls, "null-target-steer-2a8")).toBe(false);
		});

		it("does not hold a bound steer for the replacement run on cancelAndSubmit", async () => {
			const h = buildHeldSession([
				{ content: ["A done"], delayMs: 60_000 },
				{ content: ["B handled"] },
				{ content: ["unexpected"] },
			]);
			const first = h.s.prompt("task A");
			await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
			const handleA = h.s.activePromptHandle;
			await sendSteer(h.s, "bound-steer-cas-3b7", handleA);
			await sendSteer(h.s, "unbound-steer-cas-8d4");

			expect(await h.s.cancelAndSubmit("replacement-prompt-1e9")).toEqual({ kind: "submitted" });
			await first.catch(() => {});
			await h.s.waitForIdle();

			expect(sawText(h.mock.calls.slice(1), "replacement-prompt-1e9")).toBe(true);
			expect(sawText(h.mock.calls.slice(1), "unbound-steer-cas-8d4")).toBe(true);
			expect(sawText(h.mock.calls, "bound-steer-cas-3b7")).toBe(false);
			expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			expect(h.agent.hasQueuedMessages()).toBe(false);
		});

		it("manual compaction of the live run discards its bound steers and keeps unbound ones", async () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Anthropic test model to exist");
			const toolStarted = Promise.withResolvers<void>();
			const releaseTool = Promise.withResolvers<void>();
			const blockingTool = {
				name: "blocks",
				description: "Blocks until aborted or released.",
				parameters: { type: "object" as const, properties: {} },
				execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
					toolStarted.resolve();
					const aborted = Promise.withResolvers<void>();
					if (signal?.aborted) aborted.resolve();
					else signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([releaseTool.promise, aborted.promise]);
					return { content: [{ type: "text" as const, text: "done" }] };
				},
			};
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", name: "blocks", arguments: {} }] },
					{ content: ["B handled"] },
					{ content: ["unexpected"] },
				],
			});
			const agent = new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model, systemPrompt: ["Test"], tools: [blockingTool as never], messages: [] },
				steeringMode: "all",
				streamFn: mock.stream,
			});
			const settings = Settings.isolated({ "compaction.enabled": false });
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage({ role: "user", content: "old context ".repeat(100), timestamp: 1 });
			sessionManager.appendMessage({ role: "user", content: "recent context", timestamp: 2 });
			const extensionRunner = {
				hasHandlers: vi.fn((eventType: string) => eventType === "session_before_compact"),
				hasToolResultMediation: vi.fn().mockReturnValue(false),
				emitBeforeAgentStart: vi.fn().mockImplementation(async () => ({ messages: [] })),
				emit: vi.fn().mockImplementation(async (event: unknown) => {
					const preparation = (event as { preparation?: { firstKeptEntryId: string; tokensBefore: number } })
						.preparation;
					if (!preparation) return undefined;
					return {
						compaction: {
							summary: "compacted summary",
							shortSummary: "compacted",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
							details: {},
						},
					};
				}),
			};
			session = new AgentSession({
				agent,
				sessionManager,
				settings,
				extensionRunner: extensionRunner as never,
				modelRegistry,
			});
			session.settings.override("compaction.keepRecentTokens", 1);
			const s = session;
			let first: Promise<void> | undefined;
			try {
				first = s.prompt("task A");
				await toolStarted.promise;
				const handleA = s.activePromptHandle;
				expect(handleA).toBeDefined();
				await sendSteer(s, "bound-steer-compact-5a1", handleA);
				await sendSteer(s, "unbound-steer-compact-7b2");
				expect(s.getQueuedMessages().steering).toEqual(["bound-steer-compact-5a1", "unbound-steer-compact-7b2"]);

				await s.compact();
				await first.catch(() => {});
				await s.waitForIdle();

				expect(sawText(mock.calls, "bound-steer-compact-5a1")).toBe(false);
				expect(sawText(mock.calls, "unbound-steer-compact-7b2")).toBe(true);
				expect(s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
				expect(agent.hasQueuedMessages()).toBe(false);
			} finally {
				releaseTool.resolve();
				await first?.catch(() => {});
			}
		});

		type Promotion = { startsOwnRun?: boolean; removed?: boolean };
		const sendFollowUp = (
			s: AgentSession,
			text: string,
			expectedPromptHandle?: string | null,
			onQueuedPromoted?: (promotion: Promotion) => void,
		) => s.sendUserMessage(text, { deliverAs: "followUp", expectedPromptHandle, onQueuedPromoted });
		const countRunStarts = (s: AgentSession) => {
			const starts: string[] = [];
			const unsubscribe = s.subscribe(event => {
				if (event.type === "agent_start") starts.push(s.activePromptHandle ?? "");
			});
			return { starts, unsubscribe };
		};

		it("delivers a bound follow-up inside its own run without starting another run", async () => {
			const releaseA = Promise.withResolvers<void>();
			const h = buildHeldSession([
				async () => {
					await releaseA.promise;
					return { content: ["A done"] };
				},
				{ content: ["follow-up handled"] },
				{ content: ["unexpected"] },
			]);
			const runs = countRunStarts(h.s);
			const promotions: Promotion[] = [];
			let first: Promise<void> | undefined;
			try {
				first = h.s.prompt("task A");
				await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
				const handleA = h.s.activePromptHandle;
				expect(handleA).toBeDefined();
				await sendFollowUp(h.s, "bound-follow-up-same-run-1a7", handleA, p => promotions.push(p));
				expect(h.s.getQueuedMessages().followUp).toEqual(["bound-follow-up-same-run-1a7"]);

				releaseA.resolve();
				await first;
				await h.s.waitForIdle();

				expect(h.mock.calls).toHaveLength(2);
				expect(sawText(h.mock.calls.slice(1), "bound-follow-up-same-run-1a7")).toBe(true);
				expect(promotions).toEqual([{ startsOwnRun: false }]);
				expect(runs.starts).toEqual([handleA!]);
				expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			} finally {
				runs.unsubscribe();
				releaseA.resolve();
				await first?.catch(() => {});
			}
		});

		it("rejects a follow-up bound to an ended run or to no run without queueing it", async () => {
			const releaseA = Promise.withResolvers<void>();
			const h = buildHeldSession([
				async () => {
					await releaseA.promise;
					return { content: ["A done"] };
				},
				{ content: ["unexpected"] },
			]);
			const first = h.s.prompt("task A");
			await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
			const handleA = h.s.activePromptHandle;
			releaseA.resolve();
			await first;
			await h.s.waitForIdle();

			await expect(sendFollowUp(h.s, "ended-run-follow-up-3c9", handleA)).rejects.toMatchObject({
				code: "turn_not_active",
			});
			await expect(sendFollowUp(h.s, "no-run-follow-up-8e2", null)).rejects.toMatchObject({
				code: "turn_not_active",
			});
			await h.s.waitForIdle();
			expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			expect(h.agent.hasQueuedMessages()).toBe(false);
			expect(h.mock.calls).toHaveLength(1);
		});

		it("rejects a bound follow-up whose run ended and successor started during the admission await", async () => {
			const releaseA = Promise.withResolvers<void>();
			const releaseSuccessor = Promise.withResolvers<void>();
			const releaseCommit = Promise.withResolvers<void>();
			const h = buildHeldSession([
				async () => {
					await releaseA.promise;
					return { content: ["A done"] };
				},
				async () => {
					await releaseSuccessor.promise;
					return { content: ["B done"] };
				},
				{ content: ["unexpected"] },
			]);
			let first: Promise<void> | undefined;
			let second: Promise<void> | undefined;
			try {
				first = h.s.prompt("task A");
				await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
				const handleA = h.s.activePromptHandle;
				const commitEntered = Promise.withResolvers<void>();
				const stale = h.s.sendUserMessage("stale-bound-follow-up-5b4", {
					deliverAs: "followUp",
					expectedPromptHandle: handleA,
					onPreflightAcceptCommit: async () => {
						commitEntered.resolve();
						await releaseCommit.promise;
					},
				});
				stale.catch(() => {});
				await commitEntered.promise;

				// A ends while the admission is held; B is live when it resumes.
				releaseA.resolve();
				await first;
				await h.s.waitForIdle();
				second = h.s.prompt("task B");
				await waitUntil(() => h.mock.calls.length === 2);
				expect(h.s.activePromptHandle).toBeDefined();
				expect(h.s.activePromptHandle).not.toBe(handleA);
				releaseCommit.resolve();

				await expect(stale).rejects.toMatchObject({ code: "turn_not_active" });
				expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
				releaseSuccessor.resolve();
				await second;
				await h.s.waitForIdle();
				expect(h.mock.calls).toHaveLength(2);
				expect(sawText(h.mock.calls, "stale-bound-follow-up-5b4")).toBe(false);
			} finally {
				releaseA.resolve();
				releaseCommit.resolve();
				releaseSuccessor.resolve();
				await Promise.all([first?.catch(() => {}), second?.catch(() => {})]);
			}
		});

		it("discards a bound follow-up its run ends without reading while an unbound one still reaches the next run", async () => {
			const releaseA = Promise.withResolvers<void>();
			const h = buildHeldSession([
				async () => {
					await releaseA.promise;
					return { content: ["A done"] };
				},
				{ content: ["next run"] },
				{ content: ["next run 2"] },
				{ content: ["next run 3"] },
			]);
			const runs = countRunStarts(h.s);
			const bound: Promotion[] = [];
			const unbound: Promotion[] = [];
			let first: Promise<void> | undefined;
			try {
				first = h.s.prompt("task A");
				await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
				const handleA = h.s.activePromptHandle;
				await sendFollowUp(h.s, "bound-unread-follow-up-7f3", handleA, p => bound.push(p));
				await sendFollowUp(h.s, "unbound-follow-up-kept-2d6", undefined, p => unbound.push(p));
				expect(h.s.getQueuedMessages().followUp).toEqual([
					"bound-unread-follow-up-7f3",
					"unbound-follow-up-kept-2d6",
				]);

				// The run pauses at its stop point, so it never reads its follow-up queue:
				// both follow-ups are still queued, and live, when its terminal is published.
				h.agent.setShouldPause(() => true);
				releaseA.resolve();
				await first;
				h.agent.setShouldPause(undefined);
				await h.s.waitForIdle();

				expect(bound).toEqual([{ startsOwnRun: true, removed: true }]);
				expect(h.s.getQueuedMessages().followUp).not.toContain("bound-unread-follow-up-7f3");
				await h.s.prompt("task B");
				await h.s.waitForIdle();

				expect(sawText(h.mock.calls, "bound-unread-follow-up-7f3")).toBe(false);
				expect(sawText(h.mock.calls.slice(1), "unbound-follow-up-kept-2d6")).toBe(true);
				expect(unbound).toHaveLength(1);
				expect(unbound[0]?.removed).toBeUndefined();
				expect(runs.starts[0]).toBe(handleA!);
				expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
			} finally {
				runs.unsubscribe();
				h.agent.setShouldPause(undefined);
				releaseA.resolve();
				await first?.catch(() => {});
			}
		});

		it("discards a bound follow-up on a user interrupt instead of carrying it to the next run", async () => {
			const h = buildHeldSession([
				{ content: ["A done"], delayMs: 60_000 },
				{ content: ["next run"] },
				{ content: ["next run 2"] },
			]);
			const bound: Promotion[] = [];
			const first = h.s.prompt("task A");
			await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
			const handleA = h.s.activePromptHandle;
			await sendFollowUp(h.s, "bound-interrupted-follow-up-4a1", handleA, p => bound.push(p));

			await h.s.abort({ cause: "user_interrupt" });
			await first.catch(() => {});
			await h.s.waitForIdle();
			await h.s.prompt("task B");
			await h.s.waitForIdle();

			expect(bound).toEqual([{ startsOwnRun: true, removed: true }]);
			expect(sawText(h.mock.calls, "bound-interrupted-follow-up-4a1")).toBe(false);
			expect(h.s.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		});

		it("does not hand a bound follow-up to the replacement run on cancelAndSubmit", async () => {
			const h = buildHeldSession([
				{ content: ["A done"], delayMs: 60_000 },
				{ content: ["replacement handled"] },
				{ content: ["unexpected"] },
			]);
			const bound: Promotion[] = [];
			const first = h.s.prompt("task A");
			await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
			const handleA = h.s.activePromptHandle;
			await sendFollowUp(h.s, "bound-follow-up-cas-6e8", handleA, p => bound.push(p));
			await sendFollowUp(h.s, "unbound-follow-up-cas-9b1");

			expect(await h.s.cancelAndSubmit("replacement-prompt-2f4")).toEqual({ kind: "submitted" });
			await first.catch(() => {});
			await h.s.waitForIdle();

			expect(sawText(h.mock.calls.slice(1), "replacement-prompt-2f4")).toBe(true);
			expect(sawText(h.mock.calls, "bound-follow-up-cas-6e8")).toBe(false);
			expect(bound).toEqual([{ startsOwnRun: true, removed: true }]);
			expect(h.s.getQueuedMessages().followUp).not.toContain("bound-follow-up-cas-6e8");
		});

		it("refuses to send a bound follow-up now instead of aborting its run or resubmitting its text", async () => {
			const releaseA = Promise.withResolvers<void>();
			const h = buildHeldSession([
				async () => {
					await releaseA.promise;
					return { content: ["A done"] };
				},
				{ content: ["bound handled in run A"] },
				{ content: ["unexpected"] },
			]);
			const runs = countRunStarts(h.s);
			const bound: Promotion[] = [];
			let first: Promise<void> | undefined;
			try {
				first = h.s.prompt("task A");
				await waitUntil(() => h.agent.state.isStreaming && h.mock.calls.length === 1);
				const handleA = h.s.activePromptHandle;
				await sendFollowUp(h.s, "bound-send-now-8c3", handleA, p => bound.push(p));
				const entry = h.s.getQueuedMessageEntries().find(e => e.text === "bound-send-now-8c3");
				expect(entry).toBeDefined();

				expect(await h.s.cancelAndSubmit(entry!.text, { queuedEntryId: entry!.id })).toEqual({
					kind: "refused",
					reason: "run_bound",
				});
				expect(h.agent.state.isStreaming).toBe(true);
				expect(h.s.activePromptHandle).toBe(handleA);
				expect(h.s.getQueuedMessages().followUp).toEqual(["bound-send-now-8c3"]);

				releaseA.resolve();
				await first;
				await h.s.waitForIdle();

				const seen = h.mock.calls.filter(call =>
					call.context.messages.some(
						message => message.role === "user" && JSON.stringify(message.content).includes("bound-send-now-8c3"),
					),
				);
				expect(seen).toHaveLength(1);
				expect(h.mock.calls).toHaveLength(2);
				expect(bound).toEqual([{ startsOwnRun: false }]);
				expect(runs.starts).toEqual([handleA!]);
			} finally {
				runs.unsubscribe();
				releaseA.resolve();
				await first?.catch(() => {});
			}
		});

		it("applies steer after pending explicit model selection completes, not before", async () => {
			const initialModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!initialModel) throw new Error("Expected bundled Anthropic test model to exist");

			const targetModel = {
				id: "target-model",
				name: "Target Model",
				api: "anthropic-messages" as const,
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				reasoning: true,
				thinking: { mode: "effort" as const, minLevel: Effort.Low, maxLevel: Effort.High },
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 2_048,
			};

			let releaseTool: (() => void) | undefined;
			const toolStarted = Promise.withResolvers<void>();
			const blockingTool = {
				name: "blocks",
				description: "Blocks until released, allowing model selection to be pending.",
				parameters: { type: "object" as const, properties: {} },
				execute: async () => {
					toolStarted.resolve();
					await new Promise<void>(resolve => {
						releaseTool = resolve;
					});
					return { content: [{ type: "text" as const, text: "tool finished" }] };
				},
			};

			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall" as const, name: "blocks", arguments: {} }] },
					{ content: ["steer handled with target model"] },
				],
			});

			const agent = new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model: initialModel, systemPrompt: ["Test"], tools: [blockingTool as never], messages: [] },
				streamFn: mock.stream,
			});

			const settings = Settings.isolated({ "compaction.enabled": false });
			settings.setModelRole("default", `${initialModel.provider}/${initialModel.id}`);
			session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

			// Start the initial turn with a blocking tool to keep the turn busy
			const initialPromise = session.prompt("run the blocking tool");
			await toolStarted.promise;

			// Start model selection to an explicit target model (this creates a selection fence)
			const selectionStarted = Promise.withResolvers<void>();
			const selectionCompleted = Promise.withResolvers<void>();
			const selectionPromise = (async () => {
				selectionStarted.resolve();
				await session.setDefaultModelSelection(targetModel, ThinkingLevel.Off);
				selectionCompleted.resolve();
			})();

			await selectionStarted.promise;
			Bun.sleep(10); // Give selection fence time to be created

			// Now send a steer via session.prompt while the turn is busy AND model selection is pending.
			// This tests through AgentSession.#promptInternal admission logic, verifying that the steer
			// waits behind the explicit model-selection fence but bypasses hot-reload fences.
			const steerPromise = session.prompt("respond with target model info", {
				streamingBehavior: "steer",
				steerQueuePolicy: "sequential",
			});

			// Release the blocking tool so the initial turn can complete
			releaseTool?.();

			// The steer should be queued and delivered after the model selection completes
			await initialPromise.catch(() => {});
			await selectionPromise;
			await selectionCompleted.promise;
			await steerPromise.catch(() => {});

			// Wait for the steer to be processed
			await session.waitForIdle();

			// Verify the steer was handled and the session used the target model
			expect(
				session.agent.state.messages.some(
					m => m.role === "user" && JSON.stringify(m.content).includes("respond with target model info"),
				),
			).toBe(true);

			// Verify the target model was selected (the selection fence ensured this)
			expect(session.model?.id).toBe("target-model");
		});
	});
});
