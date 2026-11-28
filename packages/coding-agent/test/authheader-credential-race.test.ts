import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai/api-registry";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
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
const tempDirs = trackTempDirs();

type Outcome = "ok" | "auth";

/** What the provider actually received, from the request it was handed. */
type ProviderDispatch = {
	authorization: string | undefined;
	apiKey: string | undefined;
	credentialId: number | undefined;
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
			: {}),
		timestamp: Date.now(),
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
	async function setup(options: { pinRowA: boolean }): Promise<{
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
		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: KEY_A },
			{ type: "api_key", key: KEY_B },
		]);
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
			settings: Settings.isolated({ "compaction.enabled": false }),
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
