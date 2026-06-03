import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
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
	if (!message || message.role !== "assistant") {
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
});
