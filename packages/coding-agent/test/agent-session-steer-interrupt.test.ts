import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

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
			interruptMode: "wait",
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
			interruptMode: "wait",
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

		// While abort cleanup owns the boundary, each steer must remain queued for
		// the one rearm continuation. Without that fence, the first steer starts an
		// independent continuation before the second steer is admitted.
		await session.steer("steer one");
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(mock.calls).toHaveLength(1);
		await session.steer("steer two");
		expect(session.getQueuedMessages().steering).toEqual(["steer one", "steer two"]);

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
});
