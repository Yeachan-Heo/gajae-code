import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool, type StreamFn } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model, type ToolCall } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import type { Extension } from "@gajae-code/coding-agent/extensibility/extensions/types";
import { GJC_COORDINATOR_SESSION_STATE_FILE_ENV } from "@gajae-code/coding-agent/gjc-runtime/session-state-sidecar";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import {
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
	PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
} from "../../ai/src/adapter-internals/provider-safety-stop";

const REAL_DATE_NOW = Date.now;
const ORIGINAL_COORDINATOR_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];

setDefaultTimeout(60_000);

/**
 * Anthropic's statusless capacity-overload envelope exactly as observed in a
 * live session, including the trailing padding the provider sends.
 */
const ANTHROPIC_OVERLOAD_ENVELOPE =
	'{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CeCBq4Y2KiEGipdTbzvNH"             }';

/**
 * The generic Responses capacity overload as it reaches the session: an HTTP 200
 * `response.failed` envelope, so the typed code arrives as statusless transport
 * facts with the provider's own display prose.
 */
const RESPONSES_OVERLOAD_ERROR = "server_is_overloaded: Our servers are currently overloaded. Please try again later.";
const RESPONSES_OVERLOAD_FACTS: AssistantMessage["transportFailure"] = {
	kind: "transport",
	providerCode: "server_is_overloaded",
	openaiErrorCode: "server_is_overloaded",
};

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

function assistantMessage(
	model: Model,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	};
}

/**
 * Resilient-retry contract (deep-interview spec):
 *  - configured transient + unknown/no-code errors retry according to the legacy policy,
 *    capped at retry.maxDelayMs (ceiling, not give-up);
 *  - clearly-terminal coded errors (auth/400/not-found) surface immediately;
 *  - retry.enabled=false surfaces immediately;
 *  - first Esc (retryNow) skips the backoff; abortRetry cancels.
 */
describe.serial("AgentSession resilient retry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	function configureRetryTestSession(value: AgentSession): AgentSession {
		value.setDisposeTimeoutForTests(60_000);
		return value;
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-resilient-retry-");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(tempDir.path(), "runtime-state.json");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	function withDisposeBudget(value: AgentSession): AgentSession {
		value.setDisposeTimeoutForTests(60_000);
		return value;
	}

	afterEach(async () => {
		// Teardown uses real timer/deadline state. Restore test clocks and scheduler
		// hooks before disposing so a mocked Date.now cannot wedge cleanup.
		vi.restoreAllMocks();
		Date.now = REAL_DATE_NOW;
		const currentSession = session;
		const currentAuthStorage = authStorage;
		const currentTempDir = tempDir;
		session = undefined;
		if (currentSession) await currentSession.dispose();
		currentAuthStorage.close();
		currentTempDir.removeSync();
		if (ORIGINAL_COORDINATOR_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_COORDINATOR_STATE_FILE;
	}, 300_000);

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
		return configureRetryTestSession(
			new AgentSession({ agent, sessionManager: SessionManager.inMemory(tempDir.path()), settings, modelRegistry }),
		);
	}

	function buildStatusErrorSession(options: {
		model?: Model;
		errorMessage?: string;
		errorStatus?: number;
		errorKind?: AssistantMessage["errorKind"];
		transportFailure?: AssistantMessage["transportFailure"];
		recoveredContent?: string;
		partialContent?: string;
		partialBlocks?: AssistantMessage["content"];
		bareDefault?: boolean;
		messageApi?: AssistantMessage["api"];
		messageProvider?: string;
		messageModel?: string;
		requestedModels?: string[];
		settingsOverrides?: Record<string, unknown>;
		onStreamStart?: () => void;
		failureByCall?: (call: number) => {
			errorMessage?: string;
			errorStatus?: number;
			transportFailure?: AssistantMessage["transportFailure"];
		};
	}): AgentSession {
		const model = options.model ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		authStorage.setRuntimeApiKey(model.provider, `${model.provider}-test-key`);
		const requestedModels = options.requestedModels ?? [];
		let calls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, opts) => {
				calls++;
				const callFailure = options.failureByCall?.(calls);
				options.onStreamStart?.();
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
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
						content:
							options.partialBlocks ??
							(options.partialContent ? [{ type: "text", text: options.partialContent }] : []),
						api: options.messageApi ?? requestedModel.api,
						provider: options.messageProvider ?? requestedModel.provider,
						model: options.messageModel ?? requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						...(callFailure?.errorMessage === undefined && options.errorMessage === undefined
							? {}
							: { errorMessage: callFailure?.errorMessage ?? options.errorMessage }),
						...(callFailure?.errorStatus === undefined && options.errorStatus === undefined
							? {}
							: { errorStatus: callFailure?.errorStatus ?? options.errorStatus }),
						...(options.errorKind === undefined ? {} : { errorKind: options.errorKind }),
						...(callFailure?.transportFailure === undefined && options.transportFailure === undefined
							? {}
							: { transportFailure: callFailure?.transportFailure ?? options.transportFailure }),
						timestamp: Date.now(),
					};
					// The typed safety stop is adapter-minted: this helper simulates a
					// first-party provider envelope, so the structured refusal signal
					// carries the terminal authority rather than the wire field
					// alone (#4777).
					if (options.errorKind === "provider_safety_stop") {
						mintProviderSafetyStop(
							message,
							"refusal",
							PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
							undefined,
							PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
						);
					}
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			...(options.bareDefault
				? {}
				: {
						"retry.baseDelayMs": 1,
						"retry.maxDelayMs": 10,
						"retry.maxRetries": 1,
					}),
			...options.settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return configureRetryTestSession(
			new AgentSession({ agent, sessionManager: SessionManager.inMemory(tempDir.path()), settings, modelRegistry }),
		);
	}

	// Builds a session pinned to an explicit model (e.g. ollama-cloud) so
	// provider-scoped retry behavior can be exercised. The mock streams as
	// itself, so the active model's API remains authoritative for provider-scoped
	// policies that intentionally use active-model state (such as #713).
	function buildModelSession(options: {
		model: Model;
		responses: Array<{ throw: string } | { content: string[] }>;
		settingsOverrides?: Record<string, unknown>;
		requestedModels?: string[];
		bareDefault?: boolean;
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
			...(options.bareDefault
				? {}
				: {
						"retry.baseDelayMs": 1,
						"retry.maxDelayMs": 10,
						"retry.maxRetries": 1,
					}),
			...options.settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return configureRetryTestSession(
			new AgentSession({ agent, sessionManager: SessionManager.inMemory(tempDir.path()), settings, modelRegistry }),
		);
	}
	// Builds a single-model session with a BARE default retry configuration:
	// no explicit retry.* keys are set, so `legacyRetryConfigured` is false.
	// This mirrors the real-world default and guards the regression where
	// provider stream timeouts silently failed without retrying (agent idle).
	function buildBareRetrySession(options: {
		responses: Array<{ throw: string; responseHeaders?: Record<string, string> } | { content: string[] }>;
		requestedModels?: string[];
		onStreamStart?: (agent: Agent) => void;
		emitProviderPayload?: boolean;
		extensionRunner?: ExtensionRunner;
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: options.responses });
		const extensionRunner = options.extensionRunner;
		const requestedModels = options.requestedModels ?? [];
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			transformContext: extensionRunner
				? (messages, _signal, scope) => extensionRunner.emitContext(messages, scope)
				: undefined,
			onPayload: extensionRunner
				? (payload, _model, scope) => extensionRunner.emitBeforeProviderRequest(payload, scope)
				: undefined,
			streamFn: (requestedModel, context, opts) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				options.onStreamStart?.(agent);
				if (options.emitProviderPayload) void opts?.onPayload?.({}, undefined, opts.attemptScope);
				return mock.stream(requestedModel, context, opts);
			},
		});
		// Only compaction is disabled; no retry.* keys are seeded.
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return configureRetryTestSession(
			new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry,

				extensionRunner,
				onResponse: extensionRunner
					? async (response, model, scope) => {
							await extensionRunner.emitAfterProviderResponse(response, model, scope);
						}
					: undefined,
			}),
		);
	}
	function buildBareStreamingSession(options: {
		model?: Model;
		tools?: AgentTool[];
		streamFn: StreamFn;
		extensionRunner?: ExtensionRunner;
	}): AgentSession {
		const model = options.model ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		authStorage.setRuntimeApiKey(model.provider, `${model.provider}-test-key`);
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			transformContext: options.extensionRunner
				? (messages, _signal, scope) => options.extensionRunner!.emitContext(messages, scope)
				: undefined,
			streamFn: options.streamFn,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return configureRetryTestSession(
			new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry,

				extensionRunner: options.extensionRunner,
			}),
		);
	}
	function createExtensionRunner(handlers = new Map<string, Array<() => Promise<void>>>()) {
		const extension: Extension = {
			path: "test-extension",
			resolvedPath: "test-extension",
			handlers: handlers as Extension["handlers"],
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		return new ExtensionRunner(
			handlers.size === 0 ? [] : [extension],
			{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
			tempDir.path(),
			SessionManager.inMemory(tempDir.path()),
			modelRegistry,
		);
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

	it("retries unknown / no-code errors within retry.maxRetries", async () => {
		session = buildSession({
			responses: [{ throw: "weird unclassified glitch zzz" }, { content: ["recovered"] }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger unknown error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].unbounded).toBe(false);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("does not auto-retry configured legacy unknown errors after partial stream progress (#3791)", async () => {
		// Proxy-style terminal stream failure after partial output crossed the public
		// stream boundary. Under explicit retry.* settings the unclassified failure
		// is bounded-unknown-retry eligible, but replaying after observable content
		// is unsafe for non-idempotent tool side effects.
		const cases: Array<{
			partialContent: string;
			errorMessage: string;
			transportFailure?: AssistantMessage["transportFailure"];
		}> = [
			{
				partialContent: "already streamed",
				errorMessage: "upstream request failed: stream interrupted before terminal response event",
				transportFailure: { kind: "transport", providerCode: "upstream_stream_error" },
			},
			{
				partialContent: "partial thinking leaked as text",
				errorMessage: "weird unclassified glitch after progress",
			},
		];
		for (const testCase of cases) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				errorMessage: testCase.errorMessage,
				transportFailure: testCase.transportFailure,
				partialContent: testCase.partialContent,
				recoveredContent: "should-not-retry",
				requestedModels,
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("partial progress then terminal stream failure");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			const last = lastAssistant(session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(testCase.errorMessage);
			expect(last.content).toEqual([{ type: "text", text: testCase.partialContent }]);
			await session.dispose();
			session = undefined;
		}
	});

	it("does not auto-retry configured legacy transient errors after partial stream progress (#3791)", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "stream stall: connection terminated mid-response",
			partialContent: "hello from the partial stream",
			recoveredContent: "should-not-retry",
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("partial progress then transient-class stream failure");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(requestedModels).toHaveLength(1);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.content).toEqual([{ type: "text", text: "hello from the partial stream" }]);
	});

	it("still retries content-free configured legacy unknown errors after the replay-safety gate (#3791)", async () => {
		// Content-free clean failures keep the existing bounded unknown retry policy.
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "upstream request failed: stream interrupted before terminal response event",
			transportFailure: { kind: "transport", providerCode: "upstream_stream_error" },
			recoveredContent: "recovered",
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("content-free upstream_stream_error");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(lastAssistant(session)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "recovered" }],
		});
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
	it("surfaces typed provider safety stops without text and without retrying", async () => {
		session = buildStatusErrorSession({
			errorKind: "provider_safety_stop",
			recoveredContent: "should not retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger typed provider safety stop");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorKind).toBe("provider_safety_stop");
		expect(last.errorMessage).toBeUndefined();
	});
	it("surfaces persisted legacy provider safety stops without retrying", async () => {
		session = buildStatusErrorSession({
			errorMessage: "Refusal (no details provided)",
			recoveredContent: "should not retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger persisted legacy provider safety stop");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorKind).toBeUndefined();
		expect(last.errorMessage).toBe("Refusal (no details provided)");
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
			"Blocked under Anthropic's Usage Policy.",
			"Provider finish_reason: content_filter",
			"provider FINISH_REASON: CONTENT_FILTER\t",
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

	it("retries errors that merely mention legacy safety-stop labels mid-sentence", async () => {
		const incidentalMessages = [
			"connection error after upstream refusal handshake",
			"connection error: content flagged by safety filters in a prior response",
			"connection error: request was blocked under Anthropic's Usage Policy while retrying",
			"connection error: Provider finish_reason: content_filter",
			"Provider finish_reason: content_filter timeout",
			"Content flagged by safety filtersXYZ",
			"Blocked under vendor Usage Policymaker timeout",
			"Refusal (unterminated transient transport error",
			" Provider finish_reason: content_filter",
			"Provider finish_reason: content_filter\n",
			"Provider finish_reason: content_filter\r\n",
			"Refusal: ",
			"Refusal (cyber): ",
			"Refusal( cyber )",
			"Refusal ( cyber)",
			"Refusal (cyber )",
			"Refusal (cy(ber))",
			"Blocked under xUsage Policy",
			"Provider finish_reason:content_filter",
			"Provider finish_reason:\tcontent_filter",
			"Provider finish_reason:  content_filter",
			"Provider finish_reason: \tcontent_filter",
		];
		for (const errorMessage of incidentalMessages) {
			session = buildSession({
				responses: [{ throw: errorMessage }, { content: ["recovered"] }],
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("mid-sentence legacy safety-stop label");
			await session.waitForIdle();

			expect(retryStartEvents.length).toBeGreaterThanOrEqual(1);
			expect(lastAssistant(session).stopReason).toBe("stop");
			await session.dispose();
			session = undefined;
		}
	}, 30_000);

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

	it("does not retry the canonical wrapped timeout when retry.enabled is false", async () => {
		session = buildSession({
			responses: [{ throw: "Error: Provider stream timed out while waiting for the first event" }],
			settingsOverrides: { "retry.enabled": false },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("canonical timeout with retry disabled");
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
			if (event.type === "auto_retry_start") {
				resolveStarted();
				session?.retryNow();
			}
			if (event.type === "auto_retry_end") resolveEnded();
		});

		const prompt = session.prompt("trigger retry then retry-now").catch(() => {});
		await started;
		await ended;
		await prompt;
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("abortRetry cancels a canonical first-event retry and surfaces cancellation", async () => {
		const errorMessage = "Error: Provider stream timed out while waiting for the first event";
		session = buildSession({
			responses: [{ throw: errorMessage }, { content: ["should not reach"] }],
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
			if (event.type === "auto_retry_start") {
				resolveStarted();
				session?.abortRetry();
			}
			if (event.type === "auto_retry_end") resolveEnded();
		});

		const prompt = session.prompt("trigger retry then cancel").catch(() => {});
		await started;
		await ended;
		await prompt;
		await session.waitForIdle();

		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("cancelled");
		expect(retryStartEvents).toEqual([expect.objectContaining({ errorMessage, unbounded: false, maxAttempts: 2 })]);
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
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
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

	it("surfaces exact Alibaba Token Plan first-event timeouts without duplicate model retries", async () => {
		const responsesModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const completionsModel = getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
		if (!responsesModel || !completionsModel) throw new Error("Expected bundled Alibaba Token Plan models");
		expect(responsesModel.api).toBe("openai-responses");

		const cases = [
			{
				model: responsesModel,
				errorMessage: "Provider stream timed out while waiting for the first event",
				settingsOverrides: { "retry.maxRetries": 10 },
				bareDefault: false,
			},
			{
				model: responsesModel,
				errorMessage: "Error: Provider stream timed out while waiting for the first event",
				settingsOverrides: { "retry.maxRetries": 10 },
				bareDefault: false,
			},
			{
				model: responsesModel,
				errorMessage: "OpenAI responses stream timed out while waiting for the first event",
				settingsOverrides: { "retry.maxRetries": 10 },
				bareDefault: false,
			},
			{
				model: completionsModel,
				errorMessage: "Provider stream timed out while waiting for the first event",
				settingsOverrides: undefined,
				bareDefault: true,
			},
			{
				model: completionsModel,
				errorMessage: "Error: Provider stream timed out while waiting for the first event",
				settingsOverrides: undefined,
				bareDefault: true,
			},
			{
				model: completionsModel,
				errorMessage: "OpenAI completions stream timed out while waiting for the first event",
				settingsOverrides: undefined,
				bareDefault: true,
			},
		] as const;
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		for (const testCase of cases) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				model: testCase.model,
				errorMessage: testCase.errorMessage,
				recoveredContent: "unused retry",
				requestedModels,
				bareDefault: testCase.bareDefault,
				settingsOverrides: testCase.settingsOverrides,
			});
			const { retryStartEvents, retryEndEvents } = track(session);

			await session.prompt(`Alibaba ${testCase.model.api} first-event timeout`);
			await session.waitForIdle();

			expect(requestedModels).toEqual([`${testCase.model.provider}/${testCase.model.id}`]);
			expect(new Set(requestedModels).size).toBe(requestedModels.length);
			expect(retryStartEvents).toHaveLength(0);
			expect(retryEndEvents).toHaveLength(0);
			expect(waitSpy).not.toHaveBeenCalled();
			const final = lastAssistant(session);
			expect(final).toMatchObject({
				stopReason: "error",
				provider: testCase.model.provider,
				api: testCase.model.api,
				model: testCase.model.id,
				errorMessage: testCase.errorMessage,
			});
			expect(session.isRetrying).toBe(false);
			expect(session.isStreaming).toBe(false);

			await session.dispose();
			session = undefined;
			waitSpy.mockClear();
		}
	}, 60_000);

	it("uses failed AssistantMessage identity rather than the active model for Alibaba timeout policy", async () => {
		const alibabaModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!alibabaModel || !anthropicModel) throw new Error("Expected bundled test models");
		const timeoutMessage = "Provider stream timed out while waiting for the first event";
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const retryRequestedModels: string[] = [];
		session = buildStatusErrorSession({
			model: alibabaModel,
			errorMessage: timeoutMessage,
			messageProvider: "openai",
			messageApi: "openai-responses",
			recoveredContent: "recovered after provider mismatch",
			requestedModels: retryRequestedModels,
		});
		const retryEvents = track(session);
		await session.prompt("Alibaba active model with non-Alibaba failed message");
		await session.waitForIdle();
		expect(retryRequestedModels).toHaveLength(2);
		expect(retryEvents.retryStartEvents).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("stop");
		await session.dispose();
		session = undefined;
		waitSpy.mockClear();

		const terminalRequestedModels: string[] = [];
		session = buildStatusErrorSession({
			model: anthropicModel,
			errorMessage: timeoutMessage,
			messageProvider: "alibaba-token-plan",
			messageApi: "openai-responses",
			messageModel: alibabaModel.id,
			recoveredContent: "should-not-reach",
			requestedModels: terminalRequestedModels,
		});
		const terminalEvents = track(session);
		await session.prompt("Non-Alibaba active model with Alibaba failed message");
		await session.waitForIdle();
		expect(terminalRequestedModels).toHaveLength(1);
		expect(terminalEvents.retryStartEvents).toHaveLength(0);
		expect(waitSpy).not.toHaveBeenCalled();
		expect(lastAssistant(session)).toMatchObject({
			stopReason: "error",
			provider: "alibaba-token-plan",
			api: "openai-responses",
			model: alibabaModel.id,
			errorMessage: timeoutMessage,
		});
	}, 60_000);

	it("keeps Alibaba near misses, cross-API text, and unrelated transient failures retryable", async () => {
		const responsesModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const completionsModel = getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
		if (!responsesModel || !completionsModel) throw new Error("Expected bundled Alibaba Token Plan models");
		const cases = [
			{
				model: responsesModel,
				errorMessage: "Error: OpenAI responses stream timed out while waiting for the first event",
			},
			{
				model: responsesModel,
				errorMessage: "OpenAI responses stream timed out while waiting for the first event.",
			},
			{
				model: responsesModel,
				errorMessage: "OpenAI completions stream timed out while waiting for the first event",
			},
			{
				model: completionsModel,
				errorMessage: "OpenAI responses stream timed out while waiting for the first event",
			},
			{ model: completionsModel, errorMessage: "Alibaba stream stalled while waiting for the next event" },
			{ model: completionsModel, errorMessage: "503 service unavailable" },
			{ model: completionsModel, errorMessage: "429 rate limit exceeded" },
			{ model: completionsModel, errorMessage: "network error: connection reset" },
		] as const;
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		for (const testCase of cases) {
			const requestedModels: string[] = [];
			session = buildModelSession({
				model: testCase.model,
				responses: [{ throw: testCase.errorMessage }, { content: ["recovered"] }],
				requestedModels,
			});
			const { retryStartEvents, retryEndEvents } = track(session);
			await session.prompt(`Alibaba non-terminal ${testCase.errorMessage}`);
			await session.waitForIdle();
			expect(requestedModels).toHaveLength(2);
			expect(retryStartEvents).toHaveLength(1);
			expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(waitSpy).toHaveBeenCalled();
			await session.dispose();
			session = undefined;
			waitSpy.mockClear();
		}
	}, 300000);
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
	}, 30000);
	it("surfaces raw and wrapped Kimi Code first-event timeouts without replaying", async () => {
		const model = getBundledModel("kimi-code", "kimi-k2.5");
		if (!model) throw new Error("Expected bundled Kimi Code test model to exist");
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		for (const errorMessage of [
			"Provider stream timed out while waiting for the first event",
			"Error: Provider stream timed out while waiting for the first event",
		]) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				model,
				errorMessage,
				requestedModels,
				settingsOverrides: { "retry.maxRetries": 10 },
			});
			const { retryStartEvents, retryEndEvents } = track(session);

			await session.prompt("slow Kimi request");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(retryEndEvents).toHaveLength(0);
			expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
			expect(waitSpy).not.toHaveBeenCalled();
			expect(lastAssistant(session)).toMatchObject({ stopReason: "error", errorMessage });
			expect(session.isRetrying).toBe(false);
			expect(session.isStreaming).toBe(false);
			await session.dispose();
			session = undefined;
			waitSpy.mockClear();
		}
	}, 300000);

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
	}, 300000);
	it("retries provider stream first-event timeouts under a bare default config (single model)", async () => {
		// Regression: with a single default model and NO explicit retry.* keys,
		// a provider stream timeout used to fail the turn without retrying and
		// leave the agent idle. Clearly-transient stream timeouts must retry even
		// under the default configuration.
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Example Provider Watchdog stream timed out while waiting for the first event" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("bare-config first-event timeout");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
	it("retries the reported Codex capacity overload under bare defaults", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled Codex test model to exist");
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			model,
			bareDefault: true,
			errorMessage:
				"Codex error event: Our servers are currently overloaded. Please try again later. (code=server_is_overloaded)",
			recoveredContent: "recovered after provider retries",
			requestedModels,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("recover Codex overload");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.delayMs).toBeGreaterThan(0);
		expect(waitSpy).toHaveBeenCalledWith(retryStartEvents[0]?.delayMs, expect.anything());
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "recovered after provider retries" }]);
	});
	it("does not retry near-miss or non-Codex overload errors under bare defaults", async () => {
		const codexModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!codexModel || !anthropicModel) throw new Error("Expected bundled test models to exist");
		for (const testCase of [
			{
				model: codexModel,
				errorMessage:
					"Codex error event: Our servers are currently overloaded. Please try again later. (code=server_error)",
			},
			{
				model: anthropicModel,
				errorMessage:
					"Codex error event: Our servers are currently overloaded. Please try again later. (code=server_is_overloaded)",
			},
		]) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				model: testCase.model,
				bareDefault: true,
				errorMessage: testCase.errorMessage,
				recoveredContent: "should not retry",
				requestedModels,
			});
			const { retryStartEvents } = track(session);

			await session.prompt("surface non-admitted overload");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	});
	it("retries the observed Anthropic capacity overload under bare defaults", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: ANTHROPIC_OVERLOAD_ENVELOPE,
			recoveredContent: "recovered after the overload cleared",
			requestedModels,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("recover Anthropic overload");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.delayMs).toBeGreaterThan(0);
		expect(waitSpy).toHaveBeenCalledWith(retryStartEvents[0]?.delayMs, expect.anything());
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "recovered after the overload cleared" }]);
	});
	it("bounds a persistent Anthropic capacity overload under bare defaults", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: ANTHROPIC_OVERLOAD_ENVELOPE,
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("exhaust persistent Anthropic overload");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(4);
		expect(retryStartEvents).toHaveLength(3);
		expect(retryStartEvents.map(event => event.unbounded)).toEqual([false, false, false]);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("does not retry Anthropic overload near misses under bare defaults", async () => {
		for (const testCase of [
			// Transient prose that names the overload code but is not the typed envelope.
			{ errorMessage: "503 service unavailable: overloaded_error" },
			// Correct envelope shape carrying a different typed error.
			{ errorMessage: '{"type":"error","error":{"type":"api_error","message":"Internal error."}}' },
			// The Anthropic envelope delivered by a different provider API.
			{ errorMessage: ANTHROPIC_OVERLOAD_ENVELOPE, messageApi: "openai-responses" as const },
			// A conflicting transport fact means the attempt is not provably content-free.
			{ errorMessage: ANTHROPIC_OVERLOAD_ENVELOPE, errorStatus: 529 },
		]) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				bareDefault: true,
				errorMessage: testCase.errorMessage,
				...("messageApi" in testCase ? { messageApi: testCase.messageApi } : {}),
				...("errorStatus" in testCase ? { errorStatus: testCase.errorStatus } : {}),
				recoveredContent: "should not retry",
				requestedModels,
			});
			const { retryStartEvents } = track(session);

			await session.prompt("surface non-admitted overload");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	});
	it("does not retry an Anthropic overload after visible progress or when retry is disabled", async () => {
		const progressModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: ANTHROPIC_OVERLOAD_ENVELOPE,
			partialContent: "already streamed",
			recoveredContent: "should not retry",
			requestedModels: progressModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const progressEvents = track(session);

		await session.prompt("overload after visible progress");
		await session.waitForIdle();

		expect(progressEvents.retryStartEvents).toHaveLength(0);
		expect(progressModels).toHaveLength(1);
		await session.dispose();

		const disabledModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: ANTHROPIC_OVERLOAD_ENVELOPE,
			recoveredContent: "should not retry",
			requestedModels: disabledModels,
			settingsOverrides: { "retry.enabled": false },
		});
		const disabledEvents = track(session);

		await session.prompt("overload with retry disabled");
		await session.waitForIdle();

		expect(disabledEvents.retryStartEvents).toHaveLength(0);
		expect(disabledModels).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("retries the typed generic Responses capacity overload under bare defaults", async () => {
		const model = getBundledModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled OpenAI Responses test model to exist");
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			model,
			bareDefault: true,
			errorMessage: RESPONSES_OVERLOAD_ERROR,
			transportFailure: RESPONSES_OVERLOAD_FACTS,
			recoveredContent: "recovered after the overload cleared",
			requestedModels,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("recover Responses overload");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.delayMs).toBeGreaterThan(0);
		expect(waitSpy).toHaveBeenCalledWith(retryStartEvents[0]?.delayMs, expect.anything());
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "recovered after the overload cleared" }]);
	});
	it("bounds a persistent typed Responses capacity overload under bare defaults", async () => {
		const model = getBundledModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled OpenAI Responses test model to exist");
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			model,
			bareDefault: true,
			errorMessage: RESPONSES_OVERLOAD_ERROR,
			transportFailure: RESPONSES_OVERLOAD_FACTS,
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("exhaust persistent Responses overload");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(4);
		expect(retryStartEvents).toHaveLength(3);
		expect(retryStartEvents.map(event => event.unbounded)).toEqual([false, false, false]);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("does not retry Responses overload near misses or conflicting facts under bare defaults", async () => {
		const model = getBundledModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled OpenAI Responses test model to exist");
		for (const testCase of [
			// A near-miss code is not the provider's exact capacity-overload code.
			{
				transportFailure: {
					kind: "transport" as const,
					providerCode: "server_is_overloaded_now",
					openaiErrorCode: "server_is_overloaded_now",
				},
			},
			// The code is matched case-sensitively from the parser through this
			// admission, so cased and padded variants stay terminal.
			{
				transportFailure: {
					kind: "transport" as const,
					providerCode: "SERVER_IS_OVERLOADED",
					openaiErrorCode: "SERVER_IS_OVERLOADED",
				},
			},
			{
				transportFailure: {
					kind: "transport" as const,
					providerCode: " server_is_overloaded",
					openaiErrorCode: " server_is_overloaded",
				},
			},
			// Any other transport observation means the facts are more than the
			// bare typed code, so they are not provably this content-free overload.
			{ transportFailure: { ...RESPONSES_OVERLOAD_FACTS, requestBytes: 4096 } },
			{ transportFailure: { ...RESPONSES_OVERLOAD_FACTS, firstEventElapsedMs: 1200 } },
			{ transportFailure: { ...RESPONSES_OVERLOAD_FACTS, firstEventTimeoutMs: 30000 } },
			{ transportFailure: { ...RESPONSES_OVERLOAD_FACTS, endpointClass: "canonical" as const } },
			{ transportFailure: { ...RESPONSES_OVERLOAD_FACTS, retryMaxAttempts: 3 } },
			// The generic Responses path always carries OpenAI's typed code; facts
			// without it are a different transport's failure shape.
			{ transportFailure: { kind: "transport" as const, providerCode: "server_is_overloaded" } },
			// A second typed code means the facts are not provably this overload.
			{
				transportFailure: {
					...RESPONSES_OVERLOAD_FACTS,
					anthropicErrorType: "overloaded_error",
				},
			},
			// A status or a retained retry header is structured evidence the HTTP 200
			// `response.failed` envelope cannot produce.
			{ transportFailure: RESPONSES_OVERLOAD_FACTS, errorStatus: 503 },
			{ transportFailure: { ...RESPONSES_OVERLOAD_FACTS, headers: { "retry-after": "5" } } },
			// The same typed facts delivered by a different provider API.
			{ transportFailure: RESPONSES_OVERLOAD_FACTS, messageApi: "openai-completions" as const },
		]) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				model,
				bareDefault: true,
				errorMessage: RESPONSES_OVERLOAD_ERROR,
				transportFailure: testCase.transportFailure,
				...("errorStatus" in testCase ? { errorStatus: testCase.errorStatus } : {}),
				...("messageApi" in testCase ? { messageApi: testCase.messageApi } : {}),
				recoveredContent: "should not retry",
				requestedModels,
			});
			const { retryStartEvents } = track(session);

			await session.prompt("surface non-admitted Responses overload");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	}, 120_000);
	it("does not retry a Responses overload after observable work or when retry is disabled", async () => {
		const model = getBundledModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled OpenAI Responses test model to exist");
		for (const testCase of [
			{ partialBlocks: [{ type: "text" as const, text: "already streamed" }] },
			{ partialBlocks: [{ type: "thinking" as const, thinking: "already reasoned" }] },
			{
				partialBlocks: [{ type: "toolCall" as const, id: "call_1", name: "read", arguments: { path: "a.ts" } }],
			},
			{ settingsOverrides: { "retry.enabled": false } },
		]) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				model,
				bareDefault: true,
				errorMessage: RESPONSES_OVERLOAD_ERROR,
				transportFailure: RESPONSES_OVERLOAD_FACTS,
				...("partialBlocks" in testCase ? { partialBlocks: testCase.partialBlocks } : {}),
				...("settingsOverrides" in testCase ? { settingsOverrides: testCase.settingsOverrides } : {}),
				recoveredContent: "should not retry",
				requestedModels,
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("surface replay-unsafe Responses overload");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			// A failed attempt carrying a tool call is followed by its synthetic tool
			// result, so read the failed turn itself rather than the trailing message.
			const failed = session.agent.state.messages.findLast(entry => entry.role === "assistant");
			expect((failed as AssistantMessage).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	}, 120_000);
	it("bounds a persistent typed Responses capacity overload by explicit retry settings", async () => {
		// The typed overload is admitted as a replay-safe provider overload, which
		// takes it out of the unbounded transient-prose class it used to fall into
		// under configured retry settings: it now stops at retry.maxRetries.
		const model = getBundledModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled OpenAI Responses test model to exist");
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			model,
			errorMessage: RESPONSES_OVERLOAD_ERROR,
			transportFailure: RESPONSES_OVERLOAD_FACTS,
			settingsOverrides: { "retry.maxRetries": 2 },
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("exhaust a configured Responses overload");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(3);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(event => event.unbounded === false && event.maxAttempts === 2)).toBe(true);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: false, attempt: 2 })]);
		expect(lastAssistant(session)).toMatchObject({ stopReason: "error", errorMessage: RESPONSES_OVERLOAD_ERROR });
	});
	it("does not retry a typed Responses overload after earlier observable work in the same run", async () => {
		// The overload admission is not a watchdog: it never re-issues a request
		// once the run has already produced observable work, so a replay cannot
		// duplicate a tool execution that already happened this turn.
		const model = getBundledModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled OpenAI Responses test model to exist");
		const toolCall: ToolCall = { type: "toolCall", id: "overload-tool-call", name: "counted", arguments: {} };
		let toolRuns = 0;
		let streamCalls = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Counts real executions for replay-safety coverage",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "counted result" }] };
			},
		};
		session = buildBareStreamingSession({
			model,
			tools: [countedTool],
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (streamCalls === 1) {
						const response = assistantMessage(model, [toolCall], "toolUse");
						stream.push({ type: "start", partial: response });
						stream.push({ type: "done", reason: "toolUse", message: response });
						return;
					}
					const failure = assistantMessage(model, [], "error", RESPONSES_OVERLOAD_ERROR);
					failure.transportFailure = RESPONSES_OVERLOAD_FACTS;
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("overload after an earlier tool execution");
		await session.waitForIdle();

		expect(toolRuns).toBe(1);
		expect(streamCalls).toBe(2);
		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session)).toMatchObject({ stopReason: "error", errorMessage: RESPONSES_OVERLOAD_ERROR });
	});
	it("keeps retrying the Codex capacity overload once it carries typed statusless facts", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.4-mini");
		if (!model) throw new Error("Expected bundled Codex test model to exist");
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			model,
			bareDefault: true,
			errorMessage:
				"Codex error event: Our servers are currently overloaded. Please try again later. (code=server_is_overloaded)",
			transportFailure: { kind: "transport", providerCode: "server_is_overloaded" },
			recoveredContent: "recovered after provider retries",
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("recover Codex overload with typed facts");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "recovered after provider retries" }]);
	});
	it("forwards only explicit first-event timeout settings to provider stream options", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		for (const testCase of [
			{ name: "absent", setting: undefined, expected: undefined },
			{ name: "zero", setting: 0, expected: 0 },
			{ name: "positive", setting: 12_345, expected: 12_345 },
		]) {
			const capturedTimeouts: Array<number | undefined> = [];
			const caseRoot = path.join(tempDir.path(), testCase.name);
			const settings = Settings.isolated({
				"compaction.enabled": false,
				...(testCase.setting === undefined ? {} : { "retry.streamFirstEventTimeoutMs": testCase.setting }),
			});
			const { session: configuredSession } = await createAgentSession({
				cwd: caseRoot,
				agentDir: caseRoot,
				model,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				disableExtensionDiscovery: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: [],
				workspaceTree: {
					rootPath: caseRoot,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
			});
			session = configureRetryTestSession(configuredSession);
			const mock = createMockModel({ responses: [{ content: ["ok"] }] });
			configuredSession.agent.streamFn = (streamModel, context, options) => {
				capturedTimeouts.push(options?.streamFirstEventTimeoutMs);
				return mock.stream(streamModel, context, options);
			};

			expect(configuredSession.agent.streamFirstEventTimeoutMs, testCase.name).toBe(testCase.expected);
			await configuredSession.prompt(`first-event timeout ${testCase.name}`);
			await configuredSession.waitForIdle();
			expect(capturedTimeouts, testCase.name).toEqual([testCase.expected]);

			await configuredSession.dispose();
			session = undefined;
		}
	}, 120_000);
	it("retries a typed empty response once on a clean bare-default scope", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: "Provider returned an empty response with zero token usage",
			transportFailure: { kind: "transport", providerCode: "empty_response" },
			recoveredContent: "recovered",
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("typed empty response");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.unbounded).toBe(false);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("bounds repeated typed empty responses by retry.maxRetries", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: "Provider returned an empty response with zero token usage",
			transportFailure: { kind: "transport", providerCode: "empty_response" },
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 2 },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("repeated typed empty response");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(3);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(event => event.unbounded === false)).toBe(true);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("does not retry a typed empty response after visible progress or when retry is disabled", async () => {
		const progressModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: "Provider returned an empty response with zero token usage",
			transportFailure: { kind: "transport", providerCode: "empty_response" },
			partialContent: "already streamed",
			requestedModels: progressModels,
		});

		await session.prompt("typed empty response after progress");
		await session.waitForIdle();

		expect(progressModels).toHaveLength(1);
		await session.dispose();
		session = undefined;

		const disabledModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "Provider returned an empty response with zero token usage",
			transportFailure: { kind: "transport", providerCode: "empty_response" },
			requestedModels: disabledModels,
			settingsOverrides: { "retry.enabled": false },
		});

		await session.prompt("typed empty response retry disabled");
		await session.waitForIdle();

		expect(disabledModels).toHaveLength(1);
	});
	it("replays typed first-event timeouts only up to retry.maxRetries + 1 total attempts", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "provider message is not used for timeout classification",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 2 },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("typed first-event timeout");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(3);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(event => event.maxAttempts === 3 && event.unbounded === false)).toBe(true);
		expect(lastAssistant(session).errorMessage).toMatch(/exhausted after 3 attempts; waited \d+ms total/);
	});
	it("honors the provider first-event retry ceiling for a large request", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage:
				"Anthropic stream timed out while waiting for the first event (elapsed=300000ms request_bytes=1750732 endpoint=custom configured_timeout=300000ms; override with PI_STREAM_FIRST_EVENT_TIMEOUT_MS)",
			transportFailure: {
				kind: "transport",
				providerCode: "stream_first_event_timeout",
				requestBytes: 1_750_732,
				firstEventElapsedMs: 300_000,
				firstEventTimeoutMs: 300_000,
				endpointClass: "custom",
				retryMaxAttempts: 1,
			},
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 3 },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("large timeout must not amplify");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).errorMessage).toContain("exhausted after 1 attempts");
	});
	it("honors a large-request grace ceiling on a late 529", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "529 Overloaded",
			errorStatus: 529,
			transportFailure: {
				kind: "transport",
				status: 529,
				anthropicErrorType: "overloaded_error",
				requestBytes: 1_750_732,
				firstEventElapsedMs: 305_000,
				firstEventTimeoutMs: 300_000,
				endpointClass: "custom",
				retryMaxAttempts: 1,
			},
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 5 },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("late grace failure must not replay");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).errorMessage).toMatch(
			/^First-event\/grace retry ceiling exhausted after 1 attempts; waited \d+ms total: 529 Overloaded$/,
		);
	});
	it("honors the provider first-event retry ceiling for a small request", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "Anthropic stream timed out while waiting for the first event",
			transportFailure: {
				kind: "transport",
				providerCode: "stream_first_event_timeout",
				requestBytes: 4096,
				firstEventElapsedMs: 100_000,
				firstEventTimeoutMs: 100_000,
				endpointClass: "canonical",
				retryMaxAttempts: 2,
			},
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 3 },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("small timeout gets one replay");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.maxAttempts).toBe(2);
		expect(lastAssistant(session).errorMessage).toContain("exhausted after 2 attempts");
	});
	it("keeps the first-event attempt ceiling across a later transient failure", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 5 },
			failureByCall: call =>
				call === 1
					? {
							errorMessage: "Anthropic stream timed out while waiting for the first event",
							transportFailure: {
								kind: "transport",
								providerCode: "stream_first_event_timeout",
								requestBytes: 4096,
								firstEventElapsedMs: 100_000,
								firstEventTimeoutMs: 100_000,
								endpointClass: "canonical",
								retryMaxAttempts: 2,
							},
						}
					: {
							errorMessage: "529 Overloaded",
							errorStatus: 529,
							transportFailure: { kind: "transport", status: 529, anthropicErrorType: "overloaded_error" },
						},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("timeout then overload stays bounded");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(lastAssistant(session).errorMessage).toMatch(
			/^First-event\/grace retry ceiling exhausted after 2 attempts; waited \d+ms total: 529 Overloaded$/,
		);
	});
	it("clears a stale provider ceiling when a manual retry begins", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const recovered = createMockModel({ responses: [{ content: ["continuation recovered"] }] });
		let calls = 0;
		const failureStream = (
			errorMessage: string,
			transportFailure: NonNullable<AssistantMessage["transportFailure"]>,
		): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const failure = assistantMessage(model, [], "error", errorMessage);
				failure.transportFailure = transportFailure;
				stream.push({ type: "start", partial: failure });
				stream.push({ type: "error", reason: "error", error: failure });
			});
			return stream;
		};
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				calls++;
				if (calls === 1) {
					return failureStream("Anthropic stream timed out while waiting for the first event", {
						kind: "transport",
						providerCode: "stream_first_event_timeout",
						requestBytes: 4096,
						firstEventElapsedMs: 100_000,
						firstEventTimeoutMs: 100_000,
						endpointClass: "canonical",
						retryMaxAttempts: 1,
					});
				}
				if (calls === 2) {
					return failureStream("529 Overloaded", {
						kind: "transport",
						status: 529,
						anthropicErrorType: "overloaded_error",
					});
				}
				return recovered.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": 5,
		});
		session = configureRetryTestSession(
			new AgentSession({ agent, sessionManager: SessionManager.inMemory(tempDir.path()), settings, modelRegistry }),
		);

		await session.prompt("timeout once then fail the turn");
		await session.waitForIdle();
		// The one-attempt provider ceiling exhausts the first turn immediately.
		expect(calls).toBe(1);
		expect(lastAssistant(session).errorMessage).toContain("exhausted after 1 attempts");

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		// Manual retry cleared the prior turn's one-attempt ceiling, so the 529 on
		// the reissued turn consumes the ordinary retry budget and recovers; a
		// retained stale ceiling would exhaust the 529 after a single attempt.
		expect(calls).toBe(3);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "continuation recovered" }]);
	});
	it("clears the first-event ceiling after a successful retry before a tool continuation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo test tool",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }] }),
		};
		const toolResponse = createMockModel({
			responses: [{ content: [{ type: "toolCall", name: "echo", arguments: {} }] }],
		});
		const successResponse = createMockModel({ responses: [{ content: ["continuation recovered"] }] });
		let calls = 0;
		const failureStream = (
			errorMessage: string,
			transportFailure: NonNullable<AssistantMessage["transportFailure"]>,
		): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const failure = assistantMessage(model, [], "error", errorMessage);
				failure.transportFailure = transportFailure;
				stream.push({ type: "start", partial: failure });
				stream.push({ type: "error", reason: "error", error: failure });
			});
			return stream;
		};
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: (requestedModel, context, options) => {
				calls++;
				if (calls === 1) {
					return failureStream("Anthropic stream timed out while waiting for the first event", {
						kind: "transport",
						providerCode: "stream_first_event_timeout",
						requestBytes: 4096,
						firstEventElapsedMs: 100_000,
						firstEventTimeoutMs: 100_000,
						endpointClass: "canonical",
						retryMaxAttempts: 2,
					});
				}
				if (calls === 2) return toolResponse.stream(requestedModel, context, options);
				if (calls === 3 || calls === 4) {
					return failureStream("529 Overloaded", {
						kind: "transport",
						status: 529,
						anthropicErrorType: "overloaded_error",
					});
				}
				return successResponse.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": 5,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = configureRetryTestSession(
			new AgentSession({ agent, sessionManager: SessionManager.inMemory(tempDir.path()), settings, modelRegistry }),
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("recover timeout then run a tool continuation");
		await session.waitForIdle();

		expect(calls).toBe(5);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "continuation recovered" }]);
	});
	it("replays a typed first-event timeout before progress and never after progress", async () => {
		const noProgressModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "provider message is not used for timeout classification",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			recoveredContent: "recovered",
			requestedModels: noProgressModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("typed timeout before progress");
		await session.waitForIdle();

		expect(noProgressModels).toHaveLength(2);
		expect(lastAssistant(session).stopReason).toBe("stop");
		await session.dispose();
		session = undefined;

		const progressModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "provider message is not used for timeout classification",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			partialContent: "already streamed",
			requestedModels: progressModels,
		});

		await session.prompt("typed timeout after progress");
		await session.waitForIdle();

		expect(progressModels).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("retries a typed clean first-event timeout without manual attempt-scope seeding", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			recoveredContent: "recovered",
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("typed clean timeout");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "recovered" }]);
	});
	it("recovers a typed first-event timeout in the same bare-default turn", async () => {
		const errorMessage = "Error: Provider stream timed out while waiting for the first event";
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			bareDefault: true,
			errorMessage,
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			recoveredContent: "recovered",
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);
		const maxAttempts = session.settings.getGroup("retry").maxRetries + 1;

		await session.prompt("bare-config canonical wrapped timeout");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(retryStartEvents).toEqual([
			expect.objectContaining({ attempt: 1, maxAttempts, errorMessage, unbounded: false }),
		]);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		expect(lastAssistant(session)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "recovered" }],
		});
	}, 300000);

	it("bounds canonical wrapped first-event timeout exhaustion with exact diagnostics", async () => {
		const errorMessage = "Error: Provider stream timed out while waiting for the first event";
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage,
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 2 },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("exhaust canonical wrapped timeout");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(3);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(event => event.maxAttempts === 3 && event.unbounded === false)).toBe(true);
		expect(lastAssistant(session).errorMessage).toMatch(
			/^First-event stream timeout exhausted after 3 attempts; waited \d+ms total: Error: Provider stream timed out while waiting for the first event$/,
		);
	}, 300000);

	it("bounds the exact no-the first-event compatibility message under explicit retry policy", async () => {
		const errorMessage = "Provider stream timed out while waiting for first event";
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage,
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 1 },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("exact no-the first-event timeout");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(retryStartEvents).toEqual([
			expect.objectContaining({ attempt: 1, maxAttempts: 2, errorMessage, unbounded: false }),
		]);
		expect(lastAssistant(session).errorMessage).toContain("exhausted after 2 attempts");
	}, 60_000);
	it("reseeds first-event timeout accounting at the first retryable failure", async () => {
		let now = 10;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		session = buildStatusErrorSession({
			errorMessage: "Error: Provider stream timed out while waiting for the first event",
			transportFailure: { kind: "transport", providerCode: "stream_first_event_timeout" },
			settingsOverrides: { "retry.maxRetries": 1 },
			onStreamStart: () => {
				now = ++calls === 1 ? 100 : 160;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("deterministic first-event timeout accounting");
		await session.waitForIdle();

		expect(lastAssistant(session).errorMessage).toContain("waited 60ms total");
	}, 300000);
	it("does not replay a bare-default watchdog after a reasoning summary start hook participates", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let hookCalls = 0;
		let streamCalls = 0;
		session = buildBareStreamingSession({
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure = assistantMessage(
						model,
						[],
						"error",
						"Error: Provider stream timed out while waiting for the first event",
					);
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "reasoning_summary_start", contentIndex: 0, partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"reasoning_summary_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config reasoning summary start watchdog");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(streamCalls).toBe(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	}, 60000);
	it("does not replay a bare-default watchdog after an extension hook participates", async () => {
		let hookCalls = 0;
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Error: Provider stream timed out while waiting for the first event" },
				{ content: ["should-not-reach"] },
			],
			requestedModels,
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"agent_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config extension hook watchdog");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(requestedModels).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	}, 300000);
	it("does not replay bare-default watchdogs after provider lifecycle handlers participate", async () => {
		for (const eventType of ["context", "before_provider_request", "after_provider_response"] as const) {
			let hookCalls = 0;
			const requestedModels: string[] = [];
			session = buildBareRetrySession({
				responses: [
					{
						throw: "Error: Provider stream timed out while waiting for the first event",
						...(eventType === "after_provider_response" ? { responseHeaders: { "x-request-id": "test" } } : {}),
					},
					{ content: ["should-not-reach"] },
				],
				requestedModels,
				emitProviderPayload: eventType === "before_provider_request",
				extensionRunner: createExtensionRunner(
					new Map([
						[
							eventType,
							[
								async () => {
									hookCalls++;
								},
							],
						],
					]),
				),
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt(`bare-config ${eventType} lifecycle watchdog`);
			await session.waitForIdle();

			expect(hookCalls).toBe(1);
			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	}, 120000);
	it("rejects a typed watchdog when a handler executes in its current scope", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let hookCalls = 0;
		let streamCalls = 0;
		session = buildBareStreamingSession({
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure = assistantMessage(
						model,
						[],
						"error",
						"Error: Provider stream timed out while waiting for the first event",
					);
					failure.transportFailure = { kind: "transport", providerCode: "stream_first_event_timeout" };
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"context",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("current scope extension watchdog");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(streamCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("does not replay a second bare-default watchdog after auto_retry_start handlers participate", async () => {
		let hookCalls = 0;
		let streamCalls = 0;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = buildBareStreamingSession({
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure = assistantMessage(
						model,
						[],
						"error",
						"Error: Provider stream timed out while waiting for the first event",
					);
					failure.transportFailure = { kind: "transport", providerCode: "stream_first_event_timeout" };
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"auto_retry_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config auto-retry lifecycle watchdog");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(streamCalls).toBe(2);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("does not replay a second bare-default empty response after auto_retry_start handlers participate", async () => {
		let hookCalls = 0;
		let streamCalls = 0;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = buildBareStreamingSession({
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure = assistantMessage(
						model,
						[],
						"error",
						"Provider returned an empty response with zero token usage",
					);
					failure.transportFailure = { kind: "transport", providerCode: "empty_response" };
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"auto_retry_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-default auto-retry lifecycle empty response");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(streamCalls).toBe(2);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("does not replay a second bare-default Anthropic overload after auto_retry_start handlers participate", async () => {
		let hookCalls = 0;
		let streamCalls = 0;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		session = buildBareStreamingSession({
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure = assistantMessage(model, [], "error", ANTHROPIC_OVERLOAD_ENVELOPE);
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"auto_retry_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config auto-retry lifecycle Anthropic overload");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(streamCalls).toBe(2);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retries provider stream idle stalls under a bare default config (single model)", async () => {
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Anthropic stream stalled while waiting for the next event" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("bare-config idle stall");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
	it("disposal cancels a pending idle-stall retry before closing admission", async () => {
		const retryStarted = Promise.withResolvers<void>();
		const requestedModels: string[] = [];
		session = buildSession({
			responses: [{ throw: "Anthropic stream stalled while waiting for the next event" }],
			settingsOverrides: {
				"retry.baseDelayMs": 60_000,
				"retry.maxDelayMs": 60_000,
				"retry.maxRetries": 2,
			},
			requestedModels,
		});
		const { retryStartEvents, retryEndEvents } = track(session);
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarted.resolve();
		});
		const prompt = session.prompt("dispose while idle-stall retry is waiting");
		await retryStarted.promise;

		const disposed = await Promise.race([session.dispose().then(() => true), Bun.sleep(1_000).then(() => false)]);
		expect(disposed).toBe(true);
		await prompt;
		expect(requestedModels).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: false, attempt: 1 })]);
		expect(session.isRetrying).toBe(false);
		expect(session.isStreaming).toBe(false);
		session = undefined;
	});
	it("bounds repeated provider stream idle stalls by retry.maxRetries", async () => {
		const requestedModels: string[] = [];
		session = buildSession({
			responses: [
				{ throw: "Anthropic stream stalled while waiting for the next event" },
				{ throw: "Anthropic stream stalled while waiting for the next event" },
				{ throw: "Anthropic stream stalled while waiting for the next event" },
				{ content: ["must not be reached"] },
			],
			settingsOverrides: { "retry.maxRetries": 2 },
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("repeated idle stall");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(event => event.unbounded === false)).toBe(true);
		expect(requestedModels).toHaveLength(3);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: false, attempt: 2 })]);
		expect(lastAssistant(session)).toMatchObject({
			stopReason: "error",
			errorMessage: "Anthropic stream stalled while waiting for the next event",
		});
	});
	it("fails closed on structured watchdog facts and actual streamed partial output under bare defaults", async () => {
		for (const partialOutput of [false, true]) {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const streamedDeltas: string[] = [];
			session = buildBareStreamingSession({
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const empty = assistantMessage(
							model,
							[],
							"error",
							"Error: Provider stream timed out while waiting for the first event",
						);
						if (!partialOutput) empty.transportFailure = { kind: "transport", status: 503 };
						stream.push({ type: "start", partial: empty });
						if (partialOutput) {
							const visible = assistantMessage(
								model,
								[{ type: "text", text: "already visible" }],
								"error",
								"Error: Provider stream timed out while waiting for the first event",
							);
							stream.push({ type: "text_start", contentIndex: 0, partial: empty });
							stream.push({ type: "text_delta", contentIndex: 0, delta: "already ", partial: visible });
							stream.push({ type: "text_delta", contentIndex: 0, delta: "visible", partial: visible });
							streamedDeltas.push("already ", "visible");
							stream.push({ type: "error", reason: "error", error: visible });
							return;
						}
						stream.push({ type: "error", reason: "error", error: empty });
					});
					return stream;
				},
			});
			const { retryStartEvents } = track(session);
			const observedDeltas: string[] = [];
			session.subscribe(event => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					observedDeltas.push(event.assistantMessageEvent.delta);
				}
			});

			await session.prompt("bare-config unsafe watchdog");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(lastAssistant(session).stopReason).toBe("error");
			if (partialOutput) {
				expect(observedDeltas).toEqual(streamedDeltas);
				expect(lastAssistant(session).content).toEqual([{ type: "text", text: "already visible" }]);
			}
			await session.dispose();
			session = undefined;
		}
	});
	it("retries a typed clean watchdog after an earlier tool execution in the same run", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const toolCall: ToolCall = { type: "toolCall", id: "counted-tool-call", name: "counted", arguments: {} };
		let toolRuns = 0;
		let streamCalls = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Counts real executions for replay-safety coverage",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "counted result" }] };
			},
		};
		session = buildBareStreamingSession({
			tools: [countedTool],
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (streamCalls === 1) {
						const response = assistantMessage(model, [toolCall], "toolUse");
						stream.push({ type: "start", partial: response });
						stream.push({ type: "done", reason: "toolUse", message: response });
						return;
					}
					if (streamCalls === 2) {
						const failure = assistantMessage(
							model,
							[],
							"error",
							"Error: Provider stream timed out while waiting for the first event",
						);
						failure.transportFailure = { kind: "transport", providerCode: "stream_first_event_timeout" };
						stream.push({ type: "start", partial: failure });
						stream.push({ type: "error", reason: "error", error: failure });
						return;
					}
					const recovered = assistantMessage(model, [{ type: "text", text: "recovered" }], "stop");
					stream.push({ type: "start", partial: recovered });
					stream.push({ type: "done", reason: "stop", message: recovered });
				});
				return stream;
			},
			extensionRunner: createExtensionRunner(),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("prior tool history, clean watchdog scope");
		await session.waitForIdle();

		expect(toolRuns).toBe(1);
		expect(session.agent.state.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolCallId: toolCall.id, toolName: "counted" }),
		);
		expect(streamCalls).toBe(3);
		expect(retryStartEvents).toHaveLength(1);
		expect(lastAssistant(session)).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "recovered" }],
		});
	});
	it("retries message-only first-event timeout prose after an earlier tool execution in the same run", async () => {
		// Regression: a content-free first-event timeout that arrives WITHOUT typed
		// transport facts — the wrapped canonical "Error: Provider stream timed out
		// while waiting for the first event" or the per-provider "Anthropic stream
		// timed out..." / "OpenAI responses stream timed out..." variants — was
		// blocked by the scoped bare-default gate once the run had observable
		// activity (a prior tool execution), so the turn died with the surfaced
		// timeout. Typed first-event timeouts already retried in this situation
		// (see the typed-watchdog test above); message-only watchdog prose must
		// retry the same way because nothing observable was emitted before the
		// watchdog fired.
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const openaiModel = getBundledModel("openai", "gpt-4o-mini");
		if (!openaiModel) throw new Error("Expected bundled OpenAI test model to exist");
		const cases = [
			{ model: anthropicModel, errorMessage: "Error: Provider stream timed out while waiting for the first event" },
			{ model: anthropicModel, errorMessage: "Anthropic stream timed out while waiting for the first event" },
			{ model: openaiModel, errorMessage: "OpenAI responses stream timed out while waiting for the first event" },
		] as const;
		const toolCall: ToolCall = { type: "toolCall", id: "counted-tool-call", name: "counted", arguments: {} };
		let toolRuns = 0;
		let streamCalls = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Counts real executions for replay-safety coverage",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "counted result" }] };
			},
		};
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		for (const testCase of cases) {
			toolRuns = 0;
			streamCalls = 0;
			session = buildBareStreamingSession({
				model: testCase.model,
				tools: [countedTool],
				streamFn: () => {
					streamCalls++;
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						if (streamCalls === 1) {
							const response = assistantMessage(testCase.model, [toolCall], "toolUse");
							stream.push({ type: "start", partial: response });
							stream.push({ type: "done", reason: "toolUse", message: response });
							return;
						}
						if (streamCalls === 2) {
							const failure = assistantMessage(testCase.model, [], "error", testCase.errorMessage);
							stream.push({ type: "start", partial: failure });
							stream.push({ type: "error", reason: "error", error: failure });
							return;
						}
						const recovered = assistantMessage(testCase.model, [{ type: "text", text: "recovered" }], "stop");
						stream.push({ type: "start", partial: recovered });
						stream.push({ type: "done", reason: "stop", message: recovered });
					});
					return stream;
				},
				extensionRunner: createExtensionRunner(),
			});
			const { retryStartEvents, retryEndEvents } = track(session);

			await session.prompt("tool use then message-only first-event timeout");
			await session.waitForIdle();

			expect(toolRuns).toBe(1);
			expect(streamCalls).toBe(3);
			expect(retryStartEvents).toHaveLength(1);
			expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
			expect(lastAssistant(session)).toMatchObject({
				stopReason: "stop",
				content: [{ type: "text", text: "recovered" }],
			});

			await session.dispose();
			session = undefined;
			waitSpy.mockClear();
		}
	}, 300000);
	it("retries the wrapped canonical first-event timeout on a clean bare-default epoch", async () => {
		// The wrapped "Error: Provider stream timed out while waiting for the first
		// event" form was previously blocked by the bare-default scoped gate even on
		// a perfectly clean epoch (no prior activity), purely because it lacked
		// typed transport facts. It is the canonical watchdog message and must
		// retry like every other content-free first-event timeout.
		const requestedModels: string[] = [];
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = buildBareRetrySession({
			responses: [
				{ throw: "Error: Provider stream timed out while waiting for the first event" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("bare-config wrapped canonical first-event timeout");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(lastAssistant(session)).toMatchObject({ stopReason: "stop" });
	}, 300000);
	it("gives an active cancel-and-submit replacement a clean retry epoch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const originalStarted = Promise.withResolvers<void>();
		const originalAborted = Promise.withResolvers<void>();
		const originalStream = new AssistantMessageEventStream();
		let streamCalls = 0;
		session = buildBareStreamingSession({
			streamFn: (_requestedModel, _context, options) => {
				streamCalls++;
				if (streamCalls === 1) {
					queueMicrotask(() => {
						originalStream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
						originalStarted.resolve();
						options?.signal?.addEventListener(
							"abort",
							() => {
								originalAborted.resolve();
								const aborted = assistantMessage(model, [], "aborted", "Aborted");
								originalStream.push({ type: "error", reason: "aborted", error: aborted });
							},
							{ once: true },
						);
					});
					return originalStream;
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (streamCalls === 2) {
						const failure = assistantMessage(
							model,
							[],
							"error",
							"Error: Provider stream timed out while waiting for the first event",
						);
						failure.transportFailure = { kind: "transport", providerCode: "stream_first_event_timeout" };
						stream.push({ type: "start", partial: failure });
						stream.push({ type: "error", reason: "error", error: failure });
						return;
					}
					const recovered = assistantMessage(model, [{ type: "text", text: "replacement recovered" }], "stop");
					stream.push({ type: "start", partial: recovered });
					stream.push({ type: "done", reason: "stop", message: recovered });
				});
				return stream;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		const originalPrompt = session.prompt("original");
		await originalStarted.promise;
		expect(await session.cancelAndSubmit("replacement")).toEqual({ kind: "submitted" });
		await originalAborted.promise;
		await originalPrompt;
		await session.waitForIdle();
		originalStream.push({
			type: "done",
			reason: "stop",
			message: assistantMessage(model, [{ type: "text", text: "late original" }], "stop"),
		});
		await Promise.resolve();

		expect(streamCalls).toBe(3);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(session.agent.state.messages.some(message => JSON.stringify(message).includes("late original"))).toBe(
			false,
		);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "replacement recovered" }]);
	}, 60_000);
	it("fails closed on non-canonical watchdog prose under bare defaults", async () => {
		const nearMisses = [
			"stream timed out while waiting for the first event",
			"Provider stream timed out while waiting for first event",
			"Provider stream timed out while waiting for the first event.",
			"TypeError: Provider stream timed out while waiting for the first event",
			"Provider stream timeout waiting for first event",
		];
		for (const errorMessage of nearMisses) {
			const requestedModels: string[] = [];
			session = buildBareRetrySession({
				responses: [{ throw: errorMessage }, { content: ["should-not-reach"] }],
				requestedModels,
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("bare-config watchdog near miss");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	});

	it("still fails closed on generic unknown errors under a bare default config", async () => {
		// The fix is scoped to clearly-transient failures. Generic unknown
		// provider errors preserve the historical fail-closed behavior when no
		// explicit retry.* settings opt into the resilient legacy retry path.
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [{ throw: "some unexpected provider explosion" }, { content: ["should-not-reach"] }],
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config unknown error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(requestedModels).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("keeps managed fallback policy unchanged for the typed Responses overload (#5018)", async () => {
		// The typed overload facts are new transport evidence (issue #5018) and
		// must not grant the managed chain retry/advance authority it did not
		// have before. Before the code survived transport, the failure reached
		// the session as an ordinary committed error and surfaced immediately;
		// the managed run must still stop on the primary model without a retry
		// and without switching models.
		const primary = getBundledModel("openai", "gpt-5.4-mini");
		const fallback = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary || !fallback) throw new Error("Expected bundled test models to exist");
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			model: primary,
			errorMessage: RESPONSES_OVERLOAD_ERROR,
			transportFailure: RESPONSES_OVERLOAD_FACTS,
			recoveredContent: "should not be reached",
			requestedModels,
		});
		session.setConfiguredModelChain(
			"default",
			[`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`],
			"test",
		);
		const { retryStartEvents } = track(session);

		await session.prompt("managed typed Responses overload");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(requestedModels).toEqual([`${primary.provider}/${primary.id}`]);
		expect(lastAssistant(session)).toMatchObject({ stopReason: "error", errorMessage: RESPONSES_OVERLOAD_ERROR });
	});
});
