import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

/**
 * Resilient-retry contract (deep-interview spec):
 *  - transient + unknown/no-code errors retry forever (past retry.maxRetries),
 *    capped at retry.maxDelayMs (ceiling, not give-up);
 *  - clearly-terminal coded errors (auth/400/not-found) surface immediately;
 *  - retry.enabled=false surfaces immediately;
 *  - first Esc (retryNow) skips the backoff; abortRetry cancels.
 */
describe("AgentSession resilient retry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-resilient-retry-");
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
		vi.restoreAllMocks();
	});

	function buildSession(options: {
		responses: Array<{ throw: string } | { content: string[] }>;
		settingsOverrides?: Record<string, unknown>;
		requestedModels?: string[];
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: options.responses });
		const requestedModels = options.requestedModels ?? [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, opts) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": 1,
			...options.settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	function buildStatusErrorSession(options: {
		errorMessage: string;
		errorStatus: number;
		recoveredContent?: string;
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let calls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, opts) => {
				calls++;
				if (calls > 1 && options.recoveredContent) {
					return createMockModel({ responses: [{ content: [options.recoveredContent] }] }).stream(
						requestedModel,
						context,
						opts,
					);
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: options.errorMessage,
						errorStatus: options.errorStatus,
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	// Builds a session pinned to an explicit model (e.g. ollama-cloud) so
	// provider-scoped retry behavior can be exercised. The mock streams as
	// itself, so the active model's API — not the errored message's API — is
	// what the classifier reads.
	function buildModelSession(options: {
		model: Model;
		responses: Array<{ throw: string } | { content: string[] }>;
		settingsOverrides?: Record<string, unknown>;
		requestedModels?: string[];
	}): AgentSession {
		const { model } = options;
		authStorage.setRuntimeApiKey(model.provider, `${model.provider}-test-key`);
		const mock = createMockModel({ responses: options.responses });
		const requestedModels = options.requestedModels ?? [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, opts) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, opts);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": 1,
			...options.settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}
	function track(s: AgentSession) {
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		s.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});
		return { retryStartEvents, retryEndEvents };
	}

	it("retries transient errors past retry.maxRetries (unbounded)", async () => {
		const requestedModels: string[] = [];
		session = buildSession({
			responses: [
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "503 service unavailable: overloaded_error" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger transient errors beyond maxRetries");
		await session.waitForIdle();

		// maxRetries is 1, but transient retries are unbounded: 3 retries occur.
		expect(retryStartEvents.length).toBe(3);
		expect(retryStartEvents.every(e => e.unbounded === true)).toBe(true);
		expect(requestedModels).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
		expect(waitSpy).toHaveBeenCalled();
	});

	it("retries unknown / no-code errors", async () => {
		session = buildSession({
			responses: [{ throw: "weird unclassified glitch zzz" }, { content: ["recovered"] }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger unknown error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].unbounded).toBe(true);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("surfaces terminal coded errors without retrying", async () => {
		session = buildSession({
			responses: [{ throw: "401 unauthorized: invalid api key" }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger terminal error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("401");
	});

	it("surfaces provider safety refusals without retrying", async () => {
		// Anthropic stop_reason "refusal"/"sensitive" maps to stopReason "error"
		// with an engine-generated label (packages/ai anthropic.ts). Refusals are
		// deterministic for the submitted context, so every retry re-sends the
		// full conversation and deterministically refuses again (#1655).
		const refusals = [
			"Refusal (cyber): This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.",
			"Refusal (no details provided)",
			"Content flagged by safety filters",
		];
		for (const refusal of refusals) {
			session = buildSession({ responses: [{ throw: refusal }] });
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("trigger provider refusal");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			const last = lastAssistant(session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(refusal);
			await session.dispose();
			session = undefined;
		}
	});

	it("still retries errors that merely mention a refusal mid-sentence", async () => {
		// Guard the anchored match: transient copy that contains the word
		// "refusal" in passing must not be terminalized.
		session = buildSession({
			responses: [{ throw: "connection error after upstream refusal handshake" }, { content: ["recovered"] }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("mid-sentence refusal mention");
		await session.waitForIdle();

		expect(retryStartEvents.length).toBeGreaterThanOrEqual(1);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("surfaces deliberate request aborts without retrying", async () => {
		session = buildSession({ responses: [{ throw: "Request was aborted." }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("deliberate abort");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retries network-abort style errors (not deliberate request aborts)", async () => {
		// "connection aborted" is a transient network hiccup, not a deliberate
		// abort: it must retry rather than be misclassified as terminal.
		session = buildSession({
			responses: [{ throw: "socket connection aborted" }, { content: ["recovered"] }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("network abort");
		await session.waitForIdle();

		expect(retryStartEvents.length).toBeGreaterThanOrEqual(1);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("does not retry when retry.enabled is false", async () => {
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }],
			settingsOverrides: { "retry.enabled": false },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger transient with retry disabled");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retryNow skips the backoff and re-attempts immediately", async () => {
		// Huge backoff: the retry only completes within the test timeout if
		// retryNow() short-circuits the wait.
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }, { content: ["recovered now"] }],
			settingsOverrides: { "retry.baseDelayMs": 600_000, "retry.maxDelayMs": 600_000 },
		});
		const { retryStartEvents, retryEndEvents } = track(session);
		let resolveStarted!: () => void;
		const started = new Promise<void>(r => {
			resolveStarted = r;
		});
		let resolveEnded!: () => void;
		const ended = new Promise<void>(r => {
			resolveEnded = r;
		});
		session.subscribe(event => {
			if (event.type === "auto_retry_start") resolveStarted();
			if (event.type === "auto_retry_end") resolveEnded();
		});

		const prompt = session.prompt("trigger retry then retry-now").catch(() => {});
		await started;
		// Let the backoff wait be entered and the abort controller be assigned.
		await Bun.sleep(50);
		session.retryNow();
		await ended;
		await prompt;
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("abortRetry cancels the retry and surfaces the error", async () => {
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }, { content: ["should not reach"] }],
			settingsOverrides: { "retry.baseDelayMs": 600_000, "retry.maxDelayMs": 600_000 },
		});
		const { retryEndEvents } = track(session);
		let resolveStarted!: () => void;
		const started = new Promise<void>(r => {
			resolveStarted = r;
		});
		let resolveEnded!: () => void;
		const ended = new Promise<void>(r => {
			resolveEnded = r;
		});
		session.subscribe(event => {
			if (event.type === "auto_retry_start") resolveStarted();
			if (event.type === "auto_retry_end") resolveEnded();
		});

		const prompt = session.prompt("trigger retry then cancel").catch(() => {});
		await started;
		await Bun.sleep(50);
		session.abortRetry();
		await ended;
		await prompt;
		await session.waitForIdle();

		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("cancelled");
		// The errored assistant message was stripped in preparation for the retry,
		// so cancellation simply returns to idle (the error remains in session history).
		expect(session.isRetrying).toBe(false);
	});
	it("surfaces 400 bad-request errors without retrying", async () => {
		session = buildSession({ responses: [{ throw: "400 Bad Request: malformed messages" }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger bad request");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("surfaces numeric HTTP 4xx (status context) without retrying", async () => {
		// No "bad request" keyword — relies on HTTP-status extraction so a bare
		// numeric 4xx is treated terminal instead of looping as "unknown".
		session = buildSession({ responses: [{ throw: "HTTP 400: malformed request payload" }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger numeric 400");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("surfaces explicit HTTP 400 messages even when text contains transient substrings", async () => {
		for (const errorMessage of [
			"HTTP 400: provider returned error",
			"HTTP 400: max 500 tool calls exceeded",
			"HTTP 400: request timed out during validation",
		] as const) {
			if (session) {
				await session.dispose();
				session = undefined;
			}
			session = buildSession({ responses: [{ throw: errorMessage }] });
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt(`trigger explicit terminal 400: ${errorMessage}`);
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(lastAssistant(session).stopReason).toBe("error");
		}
	});

	it("surfaces structured HTTP 400 even when text contains transient substrings", async () => {
		session = buildStatusErrorSession({
			errorMessage: "provider returned error",
			errorStatus: 400,
			recoveredContent: "should not retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger structured terminal 400");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("surfaces explicit status-code 4xx errors without retrying", async () => {
		session = buildSession({ responses: [{ throw: "provider returned status code 400 for malformed payload" }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger status-code 400");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retries rate-limit text with incidental 4xx numbers even when provider status extraction says 400", async () => {
		session = buildStatusErrorSession({
			errorMessage: "rate limit error: 400 requests per minute",
			errorStatus: 400,
			recoveredContent: "recovered after rate-limit retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger misleading rate limit status");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("does not terminalize retryable explicit HTTP statuses", async () => {
		for (const [status, message] of [
			[408, "HTTP 408 request timeout"],
			[425, "HTTP 425 too early retry your request"],
			[429, "HTTP 429 rate limit exceeded"],
			[503, "HTTP 503 service unavailable"],
		] as const) {
			if (session) {
				await session.dispose();
				session = undefined;
			}
			session = buildSession({ responses: [{ throw: message }, { content: [`recovered ${status}`] }] });
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt(`trigger retryable HTTP ${status}`);
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("stop");
		}
	});

	it("emits auto_retry_end when a retry ends on a terminal error", async () => {
		// First a transient error (retries), then a terminal 401 that must not
		// retry — the retry session must emit a terminal auto_retry_end.
		session = buildSession({
			responses: [
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "401 unauthorized: invalid api key" },
			],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("transient then terminal");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(session.isRetrying).toBe(false);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("honors retryNow() invoked synchronously from the auto_retry_start subscriber", async () => {
		// Regression for the controller-assignment race: retryNow() fired the
		// instant auto_retry_start arrives must still skip the (huge) backoff.
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }, { content: ["recovered now"] }],
			settingsOverrides: { "retry.baseDelayMs": 600_000, "retry.maxDelayMs": 600_000 },
		});
		const { retryEndEvents } = track(session);
		const sess = session;
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") sess.retryNow();
		});

		await sess.prompt("retry-now race");
		await sess.waitForIdle();

		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(sess).stopReason).toBe("stop");
	});

	it("bounds ollama-cloud first-event timeout retries instead of looping unbounded (#713)", async () => {
		// ollama-cloud (ollama-chat API) can stall before its first token even
		// for tiny prompts. Unbounded continuation retries re-issue the full
		// request to a billable backend and spike usage; the retry must be
		// capped at retry.maxRetries and then surface.
		const model = getBundledModel("ollama-cloud", "gpt-oss:120b");
		if (!model) throw new Error("Expected bundled ollama-cloud test model to exist");
		const timeoutMessage = "Provider stream timed out while waiting for the first event";
		const requestedModels: string[] = [];
		session = buildModelSession({
			model,
			// Far more throws than maxRetries: an unbounded loop would consume them all.
			responses: Array.from({ length: 10 }, () => ({ throw: timeoutMessage })),
			settingsOverrides: { "retry.maxRetries": 2 },
			requestedModels,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("tiny prompt");
		await session.waitForIdle();

		// Bounded: 1 initial attempt + retry.maxRetries(2) retries = 3 requests, then surface.
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(e => e.unbounded === false)).toBe(true);
		expect(requestedModels).toHaveLength(3);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("first event");
		expect(waitSpy).toHaveBeenCalled();
	});

	it("keeps first-party first-event timeout retries unbounded (#713 scope guard)", async () => {
		// The fix is scoped to ollama-cloud: first-party providers keep their
		// existing unbounded transient-retry behavior for first-event timeouts.
		const requestedModels: string[] = [];
		session = buildSession({
			responses: [
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("first-party first-event timeout");
		await session.waitForIdle();

		// maxRetries is 1, but unbounded transient retries continue past it.
		expect(retryStartEvents).toHaveLength(3);
		expect(retryStartEvents.every(e => e.unbounded === true)).toBe(true);
		expect(requestedModels).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
});
