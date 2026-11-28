import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai/api-registry";
import { getBundledModel } from "@gajae-code/ai/models";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { isProviderSafetyStopModelTrusted } from "../../ai/src/adapter-internals/provider-safety-stop";
import { trackTempDirs } from "./helpers/tracked-temp-dirs";

const SOURCE_ID = "authheader-credential-race-test";
const API = "authheader-credential-race-test" as Api;
const PROVIDER = "authheader-race-fixture";
const HEADER_PROVIDER = "authheader-headers-fixture";
const MODEL_ID = "race-model";
const BASE_URL = "https://authheader-race.example.test/v1";
const LOAD_KEY = "load-generated-key";
const CREDENTIAL_SCOPE = "authheader-race-scope";
const KEY_A = "stored-race-key-a";
const KEY_B = "stored-race-key-b";
const KEY_C = "stored-race-key-c";
const KEY_D = "stored-race-key-d";
const tempDirs = trackTempDirs();

type Outcome = "ok" | "auth" | "transient";

/** What the provider actually received, from the request it was handed. */
type ProviderDispatch = {
	authorization: string | undefined;
	apiKey: string | undefined;
	credentialId: number | undefined;
	/** The detached provider-local model object `streamSimple` dispatched this attempt with. */
	model: Model<Api>;
	/** Undefined on every native attempt: `streamSimple` strips the outer session callback. */
	onAuthError: SimpleStreamOptions["onAuthError"];
};

function providerMessage(model: Model<Api>, outcome: Outcome): AssistantMessage {
	return {
		role: "assistant",
		content: outcome === "ok" ? [{ type: "text", text: "accepted" }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: outcome === "ok" ? 2 : 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: outcome === "ok" ? 5 : 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: outcome === "ok" ? "stop" : "error",
		...(outcome === "auth"
			? {
					errorMessage: "401 invalid_api_key",
					errorStatus: 401,
					transportFailure: { kind: "transport" as const, status: 401, providerCode: "invalid_api_key" },
				}
			: outcome === "transient"
				? {
						errorMessage: "503 service unavailable",
						errorStatus: 503,
						transportFailure: { kind: "transport" as const, status: 503 },
					}
				: {}),
		timestamp: Date.now(),
	};
}

/** One real Anthropic refusal envelope, so the provider itself mints the stop mark. */
function anthropicRefusalRequest(): {
	withResponse(): Promise<{
		data: AsyncIterable<Record<string, unknown>>;
		response: Response;
		request_id: string | null;
	}>;
} {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_authheader_refusal" } });
	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "message_start",
							message: {
								id: "msg_authheader_refusal",
								usage: {
									input_tokens: 3,
									output_tokens: 0,
									cache_read_input_tokens: 0,
									cache_creation_input_tokens: 0,
								},
							},
						};
						yield {
							type: "message_delta",
							delta: { stop_reason: "refusal", stop_sequence: null, stop_details: null },
							usage: { input_tokens: 3, output_tokens: 0 },
						};
						yield { type: "message_stop" };
					},
				},
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

/**
 * Fake provider behind the real `streamSimple` custom-API dispatch. It records
 * the shared model's generated Authorization header alongside the options the
 * session resolved for the same request, so a cross-request header overwrite is
 * visible on the request that was already in flight.
 */
function registerFakeProvider(outcomeFor: (apiKey: string | undefined) => Outcome): ProviderDispatch[] {
	const dispatches: ProviderDispatch[] = [];
	registerCustomApi(
		API,
		(model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			dispatches.push({
				authorization: model.headers?.Authorization,
				apiKey: options?.apiKey,
				credentialId: options?.credentialId,
				model,
				onAuthError: options?.onAuthError,
			});
			const message = providerMessage(model, outcomeFor(options?.apiKey));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (message.stopReason === "stop") {
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "accepted", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				} else {
					stream.push({ type: "error", reason: "error", error: message });
				}
			});
			return stream;
		},
		SOURCE_ID,
	);
	return dispatches;
}

function modelEntry(id: string, headers?: Record<string, string>) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(headers ? { headers } : {}),
	};
}

/**
 * `authHeader: true` is what makes the registry generate the request's
 * Authorization header, so the provider has to be declared through the
 * models.json loader; runtime `registerProvider` cannot declare
 * `credential: store`. The declaration is fully static and the test swaps the
 * model's wire API for the synthetic one at the session boundary.
 */
async function createRegistry(dir: string, authStorage: AuthStorage): Promise<ModelRegistry> {
	const modelsPath = path.join(dir, "models.json");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					baseUrl: BASE_URL,
					api: "anthropic-messages",
					credential: "store",
					authHeader: true,
					models: [modelEntry(MODEL_ID)],
				},
			},
		}),
	);
	return new ModelRegistry(authStorage, modelsPath);
}

/**
 * Static header fixture for the request-header helper. The provider-level
 * apiKey makes the loader stamp a generated Authorization at build time, and
 * the `explicit` model declares its own mixed-case header instead.
 */
async function createHeaderRegistry(dir: string, authStorage: AuthStorage): Promise<ModelRegistry> {
	const modelsPath = path.join(dir, "headers-models.json");
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				[HEADER_PROVIDER]: {
					baseUrl: BASE_URL,
					api: "anthropic-messages",
					authHeader: true,
					apiKey: LOAD_KEY,
					models: [
						modelEntry("generated", { "X-Tenant-Id": "tenant-generated" }),
						modelEntry("explicit", {
							authorization: "Bearer literal-explicit",
							"X-Tenant-Id": "tenant-explicit",
						}),
					],
				},
			},
		}),
	);
	return new ModelRegistry(authStorage, modelsPath);
}

function headerModel(registry: ModelRegistry, id: string): Model<Api> {
	const model = registry.find(HEADER_PROVIDER, id);
	if (!model) throw new Error(`Expected the ${id} header fixture model`);
	return model;
}

function authorizationKeys(headers: Record<string, string> | undefined): string[] {
	return Object.keys(headers ?? {}).filter(key => key.toLowerCase() === "authorization");
}

function authorizationOf(headers: Record<string, string> | undefined): string | undefined {
	const key = authorizationKeys(headers)[0];
	return key === undefined ? undefined : headers?.[key];
}

function rowIdForKey(authStorage: AuthStorage, key: string): number {
	const row = authStorage
		.exportSnapshot()
		.credentials.find(
			entry => entry.provider === PROVIDER && entry.credential.type === "api_key" && entry.credential.key === key,
		);
	if (!row) throw new Error("Expected a stored credential row for the test key");
	return row.id;
}

async function persistedAssistants(sessionManager: SessionManager): Promise<Array<Record<string, unknown>>> {
	await sessionManager.flush();
	const file = sessionManager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.trim() !== "");
	return lines
		.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
		.filter(entry => entry.type === "message" && entry.message?.role === "assistant")
		.map(entry => entry.message as Record<string, unknown>);
}

/**
 * Pause the real main-provider dispatch after the session resolved its
 * credential but before the provider sees the request, so another lookup can
 * run against the same live model object in between.
 */
function deferObservedProviderDispatch(session: AgentSession): { entered: Promise<void>; release: () => void } {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const real = session.observeMainProviderStream.bind(session);
	vi.spyOn(session, "observeMainProviderStream").mockImplementation(
		async (
			model: Model,
			context: Context,
			options: SimpleStreamOptions | undefined,
			start: (options: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
		) => {
			entered.resolve();
			await released.promise;
			return await real(model, context, options, start);
		},
	);
	barrierReleases.push(() => released.resolve());
	return { entered: entered.promise, release: () => released.resolve() };
}

/** Capture the detached request model the session hands to the provider observer. */
function captureObservedProviderModel(session: AgentSession): Model[] {
	const observed: Model[] = [];
	const real = session.observeMainProviderStream.bind(session);
	vi.spyOn(session, "observeMainProviderStream").mockImplementation(
		async (
			model: Model,
			context: Context,
			options: SimpleStreamOptions | undefined,
			start: (options: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
		) => {
			observed.push(model);
			return await real(model, context, options, start);
		},
	);
	return observed;
}

const sessions: AgentSession[] = [];
const modelRegistries: ModelRegistry[] = [];
const authStorages: AuthStorage[] = [];
const pendingTurns: Promise<void>[] = [];
const barrierReleases: Array<() => void> = [];

afterEach(async () => {
	for (const release of barrierReleases.splice(0)) release();
	await Promise.allSettled(pendingTurns.splice(0));
	while (sessions.length > 0) await sessions.pop()?.dispose();
	while (modelRegistries.length > 0) await modelRegistries.pop()?.dispose();
	while (authStorages.length > 0) authStorages.pop()?.close();
	unregisterCustomApis(SOURCE_ID);
	vi.restoreAllMocks();
});

/**
 * `authHeader: true` renders the resolved credential into the model object's
 * headers rather than into a request-scoped copy. Two credential lookups for
 * the same live session model therefore race: the later row overwrites the
 * Authorization of a request that already resolved its own key. These tests
 * exercise that race and the related requirement that a 401 retry still sees
 * the replacement row's header.
 */
describe("authHeader credential race through a real session", () => {
	async function setup(options: { pinRowA: boolean; credentials?: string[]; retryBounds?: boolean }): Promise<{
		authStorage: AuthStorage;
		modelRegistry: ModelRegistry;
		sessionManager: SessionManager;
		session: AgentSession;
		rowA: number;
		rowB: number;
	}> {
		const dir = tempDirs.tempDirSync("@authheader-credential-race-").path();
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorages.push(authStorage);
		const credentialKeys = options.credentials ?? [KEY_A, KEY_B];
		await authStorage.set(
			PROVIDER,
			credentialKeys.map(key => ({ type: "api_key" as const, key })),
		);
		const modelRegistry = await createRegistry(dir, authStorage);
		modelRegistries.push(modelRegistry);
		const registryModel = modelRegistry.find(PROVIDER, MODEL_ID);
		if (!registryModel) throw new Error("Expected the fixture model in the registry");
		const rowA = rowIdForKey(authStorage, KEY_A);
		const rowB = rowIdForKey(authStorage, KEY_B);
		const sessionManager = SessionManager.create(dir, dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			authStorage,
			modelRegistry,
			sessionManager,
			// The registry mutates the Authorization header on whatever model object a
			// lookup receives, so this clone is the shared live object under test.
			model: { ...registryModel, api: API },
			credentialSessionId: CREDENTIAL_SCOPE,
			// Serving from row A is a hard pin, which must not silently retarget; the
			// retry case runs without it so a 401 can rotate to row B.
			...(options.pinRowA
				? {
						credentialSelector: {
							provider: PROVIDER,
							selector: { kind: "id" as const, value: String(rowA) },
							raw: `${PROVIDER}/id:${rowA}`,
						},
					}
				: {}),
			settings: Settings.isolated({
				"compaction.enabled": false,
				...(options.retryBounds
					? {
							"retry.enabled": true,
							"retry.baseDelayMs": 1,
							"retry.maxDelayMs": 10,
							"retry.maxRetries": 2,
						}
					: {}),
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);
		return { authStorage, modelRegistry, sessionManager, session, rowA, rowB };
	}

	it("keeps an in-flight request on its own credential when a concurrent lookup selects the other row", async () => {
		const { modelRegistry, sessionManager, session, rowA, rowB } = await setup({ pinRowA: true });
		const dispatches = registerFakeProvider(() => "ok");
		const liveModel = session.model;
		if (!liveModel) throw new Error("Expected the session to have a live model");

		const observer = deferObservedProviderDispatch(session);
		const turn = session.prompt("hello");
		pendingTurns.push(turn.catch(() => {}));
		const settled = turn.catch(() => {});
		try {
			const raced = await Promise.race([
				observer.entered.then(() => "entered" as const),
				settled.then(() => "settled" as const),
			]);
			if (raced === "settled") throw new Error("The turn settled without dispatching a provider request");

			// Another consumer of the same session model picks row B while the turn
			// above is paused between credential resolution and provider dispatch.
			const lookup = await modelRegistry.getApiKeyWithCredentialRowId(liveModel, CREDENTIAL_SCOPE, {
				credentialSelector: { kind: "id", value: String(rowB) },
			});
			expect(lookup).toEqual({ apiKey: KEY_B, credentialRowId: rowB });
		} finally {
			// Release on every path, so a failed assertion cannot strand the turn.
			observer.release();
		}
		await turn;
		await session.waitForIdle();

		expect(dispatches).toHaveLength(1);
		expect(dispatches[0]?.authorization).toBe(`Bearer ${KEY_A}`);
		expect(dispatches[0]?.apiKey).toBe(KEY_A);
		expect(dispatches[0]?.credentialId).toBe(rowA);

		const assistants = await persistedAssistants(sessionManager);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.credentialId).toBe(rowA);
	});

	it("re-resolves the Authorization header for a 401 retry that rotates to the other row", async () => {
		const { authStorage, sessionManager, session } = await setup({ pinRowA: false });
		// Resolve both rows up front: invalidating the rejected key may retire its row.
		const rowByKey = new Map([KEY_A, KEY_B].map(key => [key, rowIdForKey(authStorage, key)] as const));
		let attempt = 0;
		const dispatches = registerFakeProvider(() => {
			attempt += 1;
			return attempt === 1 ? "auth" : "ok";
		});

		await session.prompt("hello");
		await session.waitForIdle();

		// A request-local snapshot must follow the replacement credential; freezing
		// the rejected row's header would send the rotated request with a rejected key.
		expect(dispatches).toHaveLength(2);
		const rejected = dispatches[0];
		const retried = dispatches[1];
		if (!rejected || !retried) throw new Error("Expected both attempts to reach the provider");
		expect(new Set([rejected.apiKey, retried.apiKey])).toEqual(new Set([KEY_A, KEY_B]));
		expect(retried.apiKey).not.toBe(rejected.apiKey);
		expect(rejected.authorization).toBe(`Bearer ${rejected.apiKey}`);
		expect(retried.authorization).toBe(`Bearer ${retried.apiKey}`);
		const rejectedRow = rowByKey.get(String(rejected.apiKey));
		const retriedRow = rowByKey.get(String(retried.apiKey));
		expect(rejectedRow).toBeDefined();
		expect(retriedRow).toBeDefined();
		expect(rejected.credentialId).toBe(rejectedRow);
		expect(retried.credentialId).toBe(retriedRow);

		const assistants = await persistedAssistants(sessionManager);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.credentialId).toBe(retriedRow);
	});

	// Native auth recovery permits one rotation; another 401 is terminal rather
	// than invoking the session callback again on the same provider-local model.
	it("rotates the header once and stops when both native attempts are rejected", async () => {
		const { authStorage, session } = await setup({ pinRowA: false });
		const rowByKey = new Map([KEY_A, KEY_B].map(key => [key, rowIdForKey(authStorage, key)] as const));
		const dispatches = registerFakeProvider(() => "auth");

		await session.prompt("hello");
		await session.waitForIdle();

		expect(dispatches).toHaveLength(2);
		const rejected = dispatches[0];
		const retried = dispatches[1];
		if (!rejected || !retried) throw new Error("Expected both native attempts to reach the provider");
		expect(retried.apiKey).not.toBe(rejected.apiKey);
		expect(rejected.authorization).toBe(`Bearer ${rejected.apiKey}`);
		expect(retried.authorization).toBe(`Bearer ${retried.apiKey}`);
		expect(rejected.credentialId).toBe(rowByKey.get(String(rejected.apiKey)));
		expect(retried.credentialId).toBe(rowByKey.get(String(retried.apiKey)));

		// The retry's 401 is terminal: no third rotation, and the final assistant
		// message keeps the provider's 401 rather than a later attempt's header.
		const last = [...session.state.messages].reverse().find(message => message.role === "assistant") as
			| AssistantMessage
			| undefined;
		expect(last).toMatchObject({ stopReason: "error", errorStatus: 401 });
	});

	// The review alleges a second auth rotation on the same providerModel can
	// reuse a stale replacement marker. This pins the boundary such a marker
	// would have to cross: an outer session retry re-enters streamFn with a
	// fresh provider model. Drive the real backoff after a rotated replacement
	// 503, then require that new model to rotate once on its own 401 and stop
	// at the next 401. Two extra stored credentials rule out exhaustion.
	it("rotates once on the fresh provider model after an outer auto retry", async () => {
		const { authStorage, sessionManager, session } = await setup({
			pinRowA: false,
			credentials: [KEY_A, KEY_B, KEY_C, KEY_D],
			retryBounds: true,
		});
		const storedKeys = [KEY_A, KEY_B, KEY_C, KEY_D];
		const rowByKey = new Map(storedKeys.map(key => [key, rowIdForKey(authStorage, key)] as const));
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});
		// Calls through to the real invalidation; only the call record is observed.
		const invalidate = vi.spyOn(authStorage, "invalidateCredentialMatching");
		let attempt = 0;
		const dispatches = registerFakeProvider(() => {
			attempt += 1;
			if (attempt === 1) return "auth";
			if (attempt === 2) return "transient";
			return "auth";
		});

		await session.prompt("hello");
		await session.waitForIdle();

		// Exactly four real dispatches: the first model's 401 + replacement 503,
		// then the outer retry's 401 + replacement 401. Nothing else retries.
		expect(dispatches).toHaveLength(4);
		const first = dispatches[0];
		const firstReplacement = dispatches[1];
		const afterBackoff = dispatches[2];
		const terminal = dispatches[3];
		if (!first || !firstReplacement || !afterBackoff || !terminal) {
			throw new Error("Expected four provider dispatches");
		}

		// `streamSimple`'s native rotation reuses one provider model; the outer
		// retry's new streamFn invocation must hand it a different one.
		expect(first.model).toBe(firstReplacement.model);
		expect(afterBackoff.model).toBe(terminal.model);
		expect(first.model).not.toBe(afterBackoff.model);

		// Every request carries the header materialized for the key it dispatched,
		// and no native attempt receives the session callback: the adapter-level
		// retry loop cannot mint a nested callback even with retry budgets set.
		for (const dispatch of dispatches) {
			expect(dispatch.authorization).toBe(`Bearer ${dispatch.apiKey}`);
			expect(dispatch.credentialId).toBe(rowByKey.get(String(dispatch.apiKey)));
			expect(dispatch.onAuthError).toBeUndefined();
		}

		// One rotation per model, and the transient attempt keeps the key it
		// rotated to when the outer retry re-resolves the credential.
		expect(firstReplacement.apiKey).not.toBe(first.apiKey);
		expect(afterBackoff.apiKey).toBe(firstReplacement.apiKey);
		expect(terminal.apiKey).not.toBe(afterBackoff.apiKey);
		expect(terminal.apiKey).not.toBe(first.apiKey);
		expect(new Set(dispatches.map(dispatch => dispatch.apiKey)).size).toBe(3);

		// Exactly one invalidation per distinct provider model, each naming the
		// first attempt's key on that model.
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(invalidate.mock.calls.map(call => [call[0], call[1]])).toEqual([
			[PROVIDER, first.apiKey],
			[PROVIDER, afterBackoff.apiKey],
		]);

		// The outer session retry is the real backoff path, not a direct dispatch.
		expect(retryStarts).toHaveLength(1);
		expect(retryStarts[0]).toMatchObject({ type: "auto_retry_start", attempt: 1 });
		expect(retryStarts[0]?.delayMs).toBeLessThanOrEqual(10);

		// A second 401 on the new model is terminal even though two of the four
		// stored credentials remain usable: the key that just failed and the key
		// never dispatched. Stopping is the terminal auth rule, not exhaustion.
		const unused = storedKeys.filter(key => !dispatches.some(dispatch => dispatch.apiKey === key));
		expect(unused).toHaveLength(1);
		for (const key of [terminal.apiKey, unused[0]]) {
			expect(authStorage.isCredentialAvailable(PROVIDER, rowByKey.get(String(key))!)).toBe(true);
		}

		const last = [...session.state.messages].reverse().find(message => message.role === "assistant") as
			| AssistantMessage
			| undefined;
		expect(last).toMatchObject({ stopReason: "error", errorStatus: 401 });

		const assistants = await persistedAssistants(sessionManager);
		// The outer retry's 503 is already in the transcript; the terminal 401 is
		// the last persisted assistant and must be attributed to its own key.
		expect(assistants.at(-1)?.credentialId).toBe(rowByKey.get(String(terminal.apiKey)));
	});

	it("preserves catalog trust on the observer request and final provider model", async () => {
		const catalogModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!catalogModel) throw new Error("Expected the bundled Anthropic fixture model");
		const dir = tempDirs.tempDirSync("@authheader-trust-").path();
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		modelRegistries.push(modelRegistry);
		const sessionManager = SessionManager.create(dir, dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			authStorage,
			modelRegistry,
			sessionManager,
			model: catalogModel,
			credentialSessionId: CREDENTIAL_SCOPE,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);

		const observed = captureObservedProviderModel(session);
		const create = vi
			.spyOn(Messages.prototype, "create")
			.mockImplementation(() => anthropicRefusalRequest() as never);

		await session.prompt("hello");
		await session.waitForIdle();

		// The observer sees the request-model clone before any deferred dispatch; it
		// must retain the catalog identity or first-party adapters lose authority.
		expect(observed).toHaveLength(1);
		expect(isProviderSafetyStopModelTrusted(observed[0])).toMatchObject({
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		});

		// The real Anthropic adapter mints the terminal stop only when the final
		// provider model it received is still trusted.
		expect(create).toHaveBeenCalledTimes(1);
		const last = [...session.state.messages].reverse().find(message => message.role === "assistant") as
			| AssistantMessage
			| undefined;
		expect(last).toMatchObject({ stopReason: "error", errorKind: "provider_safety_stop" });
		// The provider sets this kind only when its adapter invocation was trusted;
		// the untrusted path instead publishes a statusless transport failure.
		expect(last?.transportFailure).toBeUndefined();
	});

	it("does not grant catalog trust to a synthetic custom dispatch model", async () => {
		const { session } = await setup({ pinRowA: true });
		registerFakeProvider(() => "ok");
		const observed = captureObservedProviderModel(session);

		await session.prompt("hello");
		await session.waitForIdle();

		expect(observed).toHaveLength(1);
		expect(isProviderSafetyStopModelTrusted(observed[0])).toBe(false);
	});
});

/**
 * `getRequestHeaders` is the request-local companion to the registry's
 * model-level auth-header rendering: it must materialize headers for one key
 * without mutating the shared model, and it must keep treating a generated
 * Authorization as generated so key rotation and removal stay possible.
 */
describe("getRequestHeaders materializes detached request auth headers", () => {
	async function headerRegistry(): Promise<ModelRegistry> {
		const dir = tempDirs.tempDirSync("@authheader-headers-").path();
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorages.push(authStorage);
		const registry = await createHeaderRegistry(dir, authStorage);
		modelRegistries.push(registry);
		return registry;
	}

	it("derives the exact key without touching the shared model or its header object", async () => {
		const registry = await headerRegistry();
		const model = headerModel(registry, "generated");
		const sharedHeaders = model.headers;
		const sharedAuthorization = authorizationOf(sharedHeaders);
		expect(sharedAuthorization).toBe(`Bearer ${LOAD_KEY}`);

		const requestHeaders = registry.getRequestHeaders(model, "materialized-request-key");
		expect(requestHeaders).toBeDefined();
		expect(requestHeaders?.Authorization).toBe("Bearer materialized-request-key");
		expect(authorizationKeys(requestHeaders)).toEqual(["Authorization"]);
		expect(requestHeaders?.["X-Tenant-Id"]).toBe("tenant-generated");
		expect(requestHeaders).not.toBe(sharedHeaders);
		expect(model.headers).toBe(sharedHeaders);
		expect(authorizationOf(model.headers)).toBe(sharedAuthorization);

		if (!requestHeaders) throw new Error("Expected materialized request headers");
		requestHeaders["X-Tenant-Id"] = "mutated";
		expect(model.headers?.["X-Tenant-Id"]).toBe("tenant-generated");
	});

	it("materializes A -> B -> A without losing generated ownership", async () => {
		const registry = await headerRegistry();
		const model = headerModel(registry, "generated");
		const first = registry.getRequestHeaders(model, KEY_A);
		const requestModel = { ...model, headers: first };
		const second = registry.getRequestHeaders(requestModel, KEY_B);
		requestModel.headers = second;
		const third = registry.getRequestHeaders(requestModel, KEY_A);
		requestModel.headers = third;

		expect([authorizationOf(first), authorizationOf(second), authorizationOf(third)]).toEqual([
			`Bearer ${KEY_A}`,
			`Bearer ${KEY_B}`,
			`Bearer ${KEY_A}`,
		]);
		expect(third).not.toBe(first);
		expect(model.headers?.Authorization).toBe(`Bearer ${LOAD_KEY}`);
		// Ownership survived the round trip: a keyless materialization still strips it.
		expect(authorizationOf(registry.getRequestHeaders(requestModel, undefined))).toBeUndefined();
	});

	it("removes the generated Authorization when no key is supplied", async () => {
		const registry = await headerRegistry();
		const model = headerModel(registry, "generated");
		const sharedHeaders = model.headers;

		const requestHeaders = registry.getRequestHeaders(model, undefined);
		expect(authorizationOf(requestHeaders)).toBeUndefined();
		expect(requestHeaders?.["X-Tenant-Id"]).toBe("tenant-generated");
		expect(model.headers).toBe(sharedHeaders);
		expect(model.headers?.Authorization).toBe(`Bearer ${LOAD_KEY}`);
	});

	it("keeps an explicit mixed-case Authorization and unrelated headers", async () => {
		const registry = await headerRegistry();
		const model = headerModel(registry, "explicit");
		const sharedHeaders = model.headers;

		const withKey = registry.getRequestHeaders(model, KEY_B);
		expect(authorizationKeys(withKey)).toEqual(["authorization"]);
		expect(authorizationOf(withKey)).toBe("Bearer literal-explicit");
		expect(withKey?.["X-Tenant-Id"]).toBe("tenant-explicit");

		const withoutKey = registry.getRequestHeaders(model, undefined);
		expect(authorizationKeys(withoutKey)).toEqual(["authorization"]);
		expect(authorizationOf(withoutKey)).toBe("Bearer literal-explicit");
		expect(withoutKey?.["X-Tenant-Id"]).toBe("tenant-explicit");
		expect(model.headers).toBe(sharedHeaders);
	});
});
