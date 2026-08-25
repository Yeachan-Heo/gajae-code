import { describe, expect, it } from "bun:test";
import {
	AuthBrokerClient,
	AuthStorage,
	RemoteAuthCredentialStore,
	SqliteAuthCredentialStore,
	startAuthBroker,
} from "../src";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { cleanReason } from "../src/auth-broker/redact";
import { createAuthGatewayModelCatalog, isSafeProviderScope, startAuthGateway } from "../src/auth-gateway/server";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	Usage,
} from "../src/types";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(id: string, provider: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "mock://gateway-scope",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function makeEventStream(message: AssistantMessage): AssistantMessageEventStream {
	async function* events(): AsyncGenerator<AssistantMessageEvent> {}
	const stream = events() as unknown as AssistantMessageEventStream;
	stream.result = async () => message;
	return stream;
}

function makeHangingEventStream(
	signal: AbortSignal | undefined,
	partial: AssistantMessage,
): AssistantMessageEventStream {
	async function waitForAbort(): Promise<void> {
		if (!signal || signal.aborted) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => resolve(), { once: true });
		await promise;
	}
	async function* events(): AsyncGenerator<AssistantMessageEvent> {
		yield { type: "start", partial };
		await waitForAbort();
	}
	const stream = events() as unknown as AssistantMessageEventStream;
	stream.result = async () => {
		await waitForAbort();
		return partial;
	};
	return stream;
}

const baseContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const testAuthority = (_provider: string) => ({
	hasProviderCredential: () => true,
	reloadProviderCredentials: async () => {},
	validateProviderCredential: () => true,
});

async function withGateway(
	provider: string,
	models: readonly Model<Api>[],
	resolveModel: (id: string) => Model<Api> | undefined,
	fn: (url: string) => Promise<void>,
): Promise<void> {
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		providerScope: { provider },
		...testAuthority(provider),
		bearerTokens: [],
		version: "test",
		storage: {
			exportSnapshot: () => ({ credentials: [{ provider }] }),
		} as unknown as AuthStorage,
		resolveModel,
		listModels: () => models,
	});
	try {
		await fn(gateway.url);
	} finally {
		await gateway.close();
	}
}

describe("provider-scoped auth-gateway catalogs", () => {
	it("removes cross-provider collision ambiguity without first-write routing", () => {
		const codex = model("gpt-5.6-luna", "openai-codex", "openai-codex-responses");
		const copilot = model("gpt-5.6-luna", "github-copilot", "openai-responses");
		const catalog = createAuthGatewayModelCatalog("openai-codex", [copilot, codex]);

		expect(catalog.models).toEqual([codex]);
		expect(catalog.resolve("gpt-5.6-luna")).toBe(codex);
	});

	it("exposes only the scoped catalog and exact Codex wire identity", async () => {
		const codex = model("gpt-5.6-luna", "openai-codex", "openai-codex-responses");
		const copilot = model("gpt-5.6-luna", "github-copilot", "openai-responses");
		const other = model("copilot-only", "github-copilot", "openai-responses");
		const models = [copilot, codex, other];
		const resolved = new Map(models.map(entry => [entry.id, entry]));

		await withGateway(
			"openai-codex",
			models,
			id => resolved.get(id),
			async url => {
				const response = await fetch(`${url}/v1/models`);
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({
					object: "list",
					data: [
						{
							id: "gpt-5.6-luna",
							object: "model",
							owned_by: "openai-codex",
							api: "openai-codex-responses",
						},
					],
				});

				const wrongProvider = await fetch(`${url}/v1/pi/stream`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ modelId: "copilot-only", context: baseContext, stream: false }),
				});
				expect(wrongProvider.status).toBe(404);
			},
		);
	});

	it("rejects a resolver result from another provider even for a colliding id", async () => {
		const codex = model("gpt-5.6-luna", "openai-codex", "openai-codex-responses");
		const copilot = model("gpt-5.6-luna", "github-copilot", "openai-responses");
		await withGateway(
			"openai-codex",
			[codex],
			() => copilot,
			async url => {
				const response = await fetch(`${url}/v1/pi/stream`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ modelId: codex.id, context: baseContext, stream: false }),
				});
				expect(response.status).toBe(404);
			},
		);
	});

	it("rejects a same-scope resolver replacement from another origin", async () => {
		const catalogModel = model("origin-guard-model", "openai-codex", "openai-codex-responses");
		const redirected = { ...catalogModel, baseUrl: "https://attacker.example/v1" };
		await withGateway(
			"openai-codex",
			[catalogModel],
			() => redirected,
			async url => {
				const response = await fetch(`${url}/v1/pi/stream`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ modelId: catalogModel.id, context: baseContext, stream: false }),
				});
				expect(response.status).toBe(404);
			},
		);
	});

	it("fails closed before binding when the broker snapshot lacks the scoped credential", () => {
		const scopedModel = model("gpt-5.6-luna", "openai-codex", "openai-codex-responses");

		expect(() =>
			startAuthGateway({
				bind: "127.0.0.1:0",
				providerScope: { provider: "openai-codex" },
				...testAuthority("openai-codex"),
				bearerTokens: [],
				version: "test",
				hasProviderCredential: () => false,
				validateProviderCredential: () => false,
				storage: {
					exportSnapshot: () => ({ credentials: [] }),
				} as unknown as AuthStorage,
				resolveModel: () => scopedModel,
				listModels: () => [scopedModel],
			}),
		).toThrow(/has no enabled broker credential/);
	});

	it("fails closed after the live broker scope loses its credential", async () => {
		const provider = "live-scope-provider";
		const scopedModel = model("live-scope-model", provider, "openai-codex-responses");
		let credentialAvailable = true;
		let getApiKeyCalls = 0;
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			hasProviderCredential: () => credentialAvailable,
			validateProviderCredential: () => credentialAvailable,
			storage: {
				exportSnapshot: () => ({ credentials: [{ provider }] }),
				getApiKey: async () => {
					getApiKeyCalls += 1;
					return "must-not-be-used";
				},
			} as unknown as AuthStorage,
			resolveModel: () => scopedModel,
			listModels: () => [scopedModel],
		});
		try {
			credentialAvailable = false;
			const response = await fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: scopedModel.id, context: baseContext, stream: false }),
			});
			expect(response.status).toBe(401);
			expect(getApiKeyCalls).toBe(0);
		} finally {
			await gateway.close();
		}
	});

	it("rejects a credential revoked while selection is in flight", async () => {
		const source = "auth-gateway-provider-scope-toctou-test";
		const api = "auth-gateway-provider-scope-toctou-test" as Api;
		const provider = "gateway-toctou-provider";
		const scopedModel = model("gateway-toctou-model", provider, api);
		const selectionStarted = Promise.withResolvers<void>();
		const releaseSelection = Promise.withResolvers<void>();
		let credentialAvailable = true;
		let dispatched = false;
		registerCustomApi(
			api,
			(_model, _context, _options) => {
				dispatched = true;
				return makeEventStream({
					role: "assistant",
					api,
					provider,
					model: scopedModel.id,
					content: [{ type: "text", text: "must not dispatch" }],
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 0,
				});
			},
			source,
		);
		const storage = {
			exportSnapshot: () => ({
				generation: 1,
				generatedAt: 1,
				credentials: [
					{
						id: 1,
						provider,
						credential: { type: "api_key" as const, key: "stale-key" },
						identityKey: null,
					},
				],
			}),
			getApiKey: async () => {
				selectionStarted.resolve();
				await releaseSelection.promise;
				return "stale-key";
			},
		} as unknown as AuthStorage;
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			hasProviderCredential: () => credentialAvailable,
			reloadProviderCredentials: async () => {},
			validateProviderCredential: () => credentialAvailable,
			storage,
			resolveModel: () => scopedModel,
			listModels: () => [scopedModel],
		});
		try {
			const responsePromise = fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: scopedModel.id, context: baseContext, stream: false }),
			});
			await selectionStarted.promise;
			credentialAvailable = false;
			releaseSelection.resolve();
			const response = await responsePromise;
			expect(response.status).toBe(401);
			expect(dispatched).toBe(false);
		} finally {
			await gateway.close();
			unregisterCustomApis(source);
		}
	});

	it("keeps usage and credential checks inside the selected provider scope", async () => {
		const provider = "scope-diagnostics-provider";
		const otherProvider = "scope-diagnostics-other";
		const scopedModel = model("scope-diagnostics-model", provider, "openai-codex-responses");
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			storage: {
				exportSnapshot: () => ({ credentials: [{ provider }] }),
				fetchUsageReports: async () => [
					{ provider, limits: [], metadata: {} },
					{ provider: otherProvider, limits: [], metadata: {} },
				],
				checkCredentials: async () => [
					{ id: 1, provider, type: "api_key", ok: true },
					{ id: 2, provider: otherProvider, type: "api_key", ok: true },
				],
			} as unknown as AuthStorage,
			resolveModel: () => scopedModel,
			listModels: () => [scopedModel],
		});
		try {
			const usage = await fetch(`${gateway.url}/v1/usage`);
			expect(usage.status).toBe(200);
			const usageBody = (await usage.json()) as { reports: unknown };
			expect(usageBody.reports).toEqual([{ provider, limits: [], metadata: {} }]);

			const checks = await fetch(`${gateway.url}/v1/credentials/check`);
			expect(checks.status).toBe(200);
			const checksBody = (await checks.json()) as { credentials: unknown };
			expect(checksBody.credentials).toEqual([{ id: 1, provider, type: "api_key", ok: true }]);
		} finally {
			await gateway.close();
		}
	});

	it("does not turn broker reload failures into false-zero diagnostics", async () => {
		const provider = "scope-reload-failure-provider";
		const scopedModel = model("scope-reload-failure-model", provider, "openai-codex-responses");
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			hasProviderCredential: () => true,
			reloadProviderCredentials: async () => {
				throw new Error("broker bearer token=secret must not escape");
			},
			validateProviderCredential: () => true,
			storage: { exportSnapshot: () => ({ credentials: [{ provider }] }) } as unknown as AuthStorage,
			resolveModel: () => scopedModel,
			listModels: () => [scopedModel],
		});
		try {
			const usage = await fetch(`${gateway.url}/v1/usage`);
			expect(usage.status).toBe(503);
			expect(await usage.text()).not.toContain("secret");

			const checks = await fetch(`${gateway.url}/v1/credentials/check`);
			expect(checks.status).toBe(503);
			expect(await checks.text()).not.toContain("secret");
		} finally {
			await gateway.close();
		}
	});

	it("projects credential check failures without upstream secrets or reports", async () => {
		const provider = "scope-diagnostic-redaction-provider";
		const scopedModel = model("scope-diagnostic-redaction-model", provider, "openai-codex-responses");
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			storage: {
				exportSnapshot: () => ({ credentials: [{ provider }] }),
				checkCredentials: async () => [
					{
						id: 7,
						provider,
						type: "api_key",
						ok: false,
						reason: "password=secret access=token refresh=refresh cookie=cookie Authorization: Basic dGVzdA==",
						report: { raw: "secret-report" },
					},
				],
			} as unknown as AuthStorage,
			resolveModel: () => scopedModel,
			listModels: () => [scopedModel],
		});
		try {
			const response = await fetch(`${gateway.url}/v1/credentials/check`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				generatedAt: expect.any(Number),
				credentials: [{ id: 7, provider, type: "api_key", ok: false, reason: "Credential check failed." }],
			});
		} finally {
			await gateway.close();
		}
	});
});

describe("provider-scoped auth-gateway credential dispatch", () => {
	const source = "auth-gateway-provider-scope-test";
	const api = "auth-gateway-provider-scope-test" as Api;

	it("dispatches with the scoped provider credential and never borrows another provider", async () => {
		const keys: string[] = [];
		registerCustomApi(
			api,
			(modelForRequest, _context, options) => {
				keys.push(`${modelForRequest.provider}:${options?.apiKey ?? ""}`);
				return makeEventStream({
					role: "assistant",
					api,
					provider: modelForRequest.provider,
					model: modelForRequest.id,
					content: [{ type: "text", text: "ok" }],
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 0,
				});
			},
			source,
		);
		const tempDir = await Bun.$`mktemp -d /tmp/gjc-auth-gateway-scope.XXXXXX`.text();
		const root = tempDir.trim();
		const store = await SqliteAuthCredentialStore.open(`${root}/auth.db`);
		const storage = new AuthStorage(store);
		const provider = "gateway-scope-provider";
		const otherProvider = "github-copilot";
		const scopedModel = model("scoped-model", provider, api);
		await storage.set(provider, { type: "api_key", key: "scoped-secret" });
		await storage.set(otherProvider, { type: "api_key", key: "other-secret" });
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			storage,
			resolveModel: id => (id === scopedModel.id ? scopedModel : undefined),
			listModels: () => [scopedModel],
		});
		try {
			const response = await fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: scopedModel.id, context: baseContext, stream: false }),
			});
			expect(response.status).toBe(200);
			expect(keys).toEqual([`${provider}:scoped-secret`]);
		} finally {
			await gateway.close();
			store.close();
			await Bun.$`rm -rf ${root}`;
			unregisterCustomApis(source);
		}
	});

	it("reloads the current provider snapshot before format and pi-native dispatch", async () => {
		const source = "auth-gateway-provider-scope-live-revoke-test";
		const api = "auth-gateway-provider-scope-live-revoke-test" as Api;
		const provider = "gateway-live-revoke-provider";
		const scopedModel = model("live-revoke-model", provider, api);
		const keys: string[] = [];
		registerCustomApi(
			api,
			(modelForRequest, _context, options) => {
				keys.push(`${modelForRequest.provider}:${options?.apiKey ?? ""}`);
				return makeEventStream({
					role: "assistant",
					api,
					provider,
					model: scopedModel.id,
					content: [{ type: "text", text: "ok" }],
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 0,
				});
			},
			source,
		);
		const tempDir = await Bun.$`mktemp -d /tmp/gjc-auth-gateway-live-revoke.XXXXXX`.text();
		const root = tempDir.trim();
		const store = await SqliteAuthCredentialStore.open(`${root}/auth.db`);
		const storage = new AuthStorage(store);
		await storage.set(provider, [
			{ type: "api_key", key: "credential-a" },
			{ type: "api_key", key: "credential-b" },
		]);
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			hasProviderCredential: () => storage.exportSnapshot().credentials.some(entry => entry.provider === provider),
			reloadProviderCredentials: () => storage.reload(),
			validateProviderCredential: (candidateProvider, apiKey) =>
				storage.exportSnapshot().credentials.some(entry => {
					if (entry.provider !== candidateProvider) return false;
					return entry.credential.type === "api_key"
						? entry.credential.key === apiKey
						: entry.credential.access === apiKey;
				}),
			storage,
			resolveModel: id => (id === scopedModel.id ? scopedModel : undefined),
			listModels: () => [scopedModel],
		});
		try {
			const formatResponse = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: scopedModel.id,
					messages: [{ role: "user", content: "hello" }],
					stream: false,
				}),
			});
			expect(formatResponse.status).toBe(200);

			const firstId = storage.exportSnapshot().credentials.find(entry => entry.credential.type === "api_key")?.id;
			expect(firstId).toBeDefined();
			if (firstId === undefined) throw new Error("expected first credential id");
			store.deleteAuthCredential(firstId, "revoked in live snapshot");

			const nativeResponse = await fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: scopedModel.id, context: baseContext, stream: false }),
			});
			expect(nativeResponse.status).toBe(200);
			expect(keys).toEqual([`${provider}:credential-a`, `${provider}:credential-b`]);
		} finally {
			await gateway.close();
			store.close();
			await Bun.$`rm -rf ${root}`;
			unregisterCustomApis(source);
		}
	});

	it("follows broker live removal across A+B and never reports revoked A", async () => {
		const source = "auth-gateway-provider-scope-broker-revoke-test";
		const api = "auth-gateway-provider-scope-broker-revoke-test" as Api;
		const provider = "gateway-broker-revoke-provider";
		const scopedModel = model("broker-revoke-model", provider, api);
		const keys: string[] = [];
		registerCustomApi(
			api,
			(modelForRequest, _context, options) => {
				keys.push(`${modelForRequest.provider}:${options?.apiKey ?? ""}`);
				return makeEventStream({
					role: "assistant",
					api,
					provider,
					model: scopedModel.id,
					content: [{ type: "text", text: "ok" }],
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 0,
				});
			},
			source,
		);
		const root = (await Bun.$`mktemp -d /tmp/gjc-auth-gateway-broker-revoke.XXXXXX`.text()).trim();
		const brokerStore = await SqliteAuthCredentialStore.open(`${root}/broker.db`);
		const brokerStorage = new AuthStorage(brokerStore);
		brokerStore.upsertAuthCredentialForProvider(provider, { type: "api_key", key: "credential-a" });
		brokerStore.upsertAuthCredentialForProvider(provider, { type: "api_key", key: "credential-b" });
		await brokerStorage.reload();
		const broker = startAuthBroker({
			bind: "127.0.0.1:0",
			bearerTokens: ["broker-token"],
			disableRefresher: true,
			storage: brokerStorage,
		});
		const client = new AuthBrokerClient({ url: broker.url, token: "broker-token" });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected broker snapshot");
		if (initial.snapshot.credentials.length !== 2) {
			throw new Error(`expected two broker credentials, got ${initial.snapshot.credentials.length}`);
		}
		const remote = new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot });
		const storage = new AuthStorage(remote);
		await storage.reload();
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			storage,
			hasProviderCredential: () => remote.snapshot.credentials.some(entry => entry.provider === provider),
			reloadProviderCredentials: async () => {
				await remote.refreshSnapshot();
				await storage.reload();
			},
			validateProviderCredential: (candidateProvider, apiKey) =>
				remote.snapshot.credentials.some(entry => {
					if (entry.provider !== candidateProvider) return false;
					return entry.credential.type === "api_key"
						? entry.credential.key === apiKey
						: entry.credential.access === apiKey;
				}),
			resolveModel: id => (id === scopedModel.id ? scopedModel : undefined),
			listModels: () => [scopedModel],
		});
		try {
			const first = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: scopedModel.id,
					messages: [{ role: "user", content: "hello" }],
					stream: false,
				}),
			});
			if (first.status !== 200)
				throw new Error(`initial gateway request failed: ${first.status} ${await first.text()}`);
			const revokedId = remote.snapshot.credentials.find(
				entry => entry.credential.type === "api_key" && entry.credential.key === "credential-a",
			)?.id;
			expect(revokedId).toBeDefined();
			if (revokedId === undefined) throw new Error("expected credential A");
			expect(brokerStorage.disableCredentialById(revokedId, "revoked in live test")).toBe(true);
			for (
				let attempt = 0;
				attempt < 50 && remote.snapshot.credentials.some(entry => entry.id === revokedId);
				attempt++
			) {
				await Bun.sleep(10);
			}

			const second = await fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: scopedModel.id, context: baseContext, stream: false }),
			});
			expect(second.status).toBe(200);
			const checks = await fetch(`${gateway.url}/v1/credentials/check`);
			const checkBody = (await checks.json()) as { credentials: Array<{ id: number }> };
			expect(checkBody.credentials).toHaveLength(1);
			expect(checkBody.credentials[0]?.id).not.toBe(revokedId);
			expect(keys).toEqual([`${provider}:credential-a`, `${provider}:credential-b`]);
		} finally {
			await gateway.close();
			remote.close();
			await broker.close();
			brokerStorage.close();
			brokerStore.close();
			await Bun.$`rm -rf ${root}`;
			unregisterCustomApis(source);
		}
	});
});

describe("provider-scoped auth-gateway cancellation", () => {
	it("propagates client cancellation to the scoped upstream stream", async () => {
		const source = "auth-gateway-provider-scope-cancel-test";
		const api = "auth-gateway-provider-scope-cancel-test" as Api;
		const provider = "gateway-cancel-provider";
		const scopedModel = model("cancel-model", provider, api);
		const signalSeen = Promise.withResolvers<AbortSignal>();
		registerCustomApi(
			api,
			(_model, _context, options) => {
				if (options?.signal) signalSeen.resolve(options.signal);
				return makeHangingEventStream(options?.signal, {
					role: "assistant",
					api,
					provider,
					model: scopedModel.id,
					content: [],
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 0,
				});
			},
			source,
		);
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
			...testAuthority(provider),
			bearerTokens: [],
			version: "test",
			storage: {
				exportSnapshot: () => ({ credentials: [{ provider }] }),
				getApiKey: async () => "scoped-key",
			} as unknown as AuthStorage,
			resolveModel: id => (id === scopedModel.id ? scopedModel : undefined),
			listModels: () => [scopedModel],
		});
		const controller = new AbortController();
		try {
			const responsePromise = fetch(`${gateway.url}/v1/pi/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: scopedModel.id, context: baseContext, stream: true }),
				signal: controller.signal,
			}).catch(() => undefined);
			const signal = await signalSeen.promise;
			controller.abort();
			for (let attempt = 0; attempt < 20 && !signal.aborted; attempt++) await Bun.sleep(10);
			expect(signal.aborted).toBe(true);
			const response = await responsePromise;
			await response?.body?.cancel();
		} finally {
			controller.abort();
			await gateway.close();
			unregisterCustomApis(source);
		}
	});

	it("scrubs credential-bearing scoped usage diagnostics", () => {
		const safe = cleanReason(
			"Authorization: Basic dXNlcjpwYXNz password=secret access=access-token refresh=refresh-token cookie=session https://alice:secret@example.test",
		);
		expect(safe).not.toContain("dXNlcjpwYXNz");
		expect(safe).not.toContain("secret");
		expect(safe).not.toContain("access-token");
		expect(safe).not.toContain("refresh-token");
		expect(safe).not.toContain("session");
		expect(safe).not.toContain("alice:secret");
		const jsonSafe = cleanReason(
			'{"access_token":"json-access","refresh_token":"json-refresh","client_secret":"json-secret"}',
		);
		expect(jsonSafe).not.toContain("json-access");
		expect(jsonSafe).not.toContain("json-refresh");
		expect(jsonSafe).not.toContain("json-secret");
		const delimitedJsonSafe = cleanReason(
			'{"client_secret":"prefix, secret-suffix", "refresh_token":"escaped \\" value"}',
		);
		expect(delimitedJsonSafe).not.toContain("prefix");
		expect(delimitedJsonSafe).not.toContain("secret-suffix");
		expect(delimitedJsonSafe).not.toContain("escaped");
		expect(cleanReason("https://gemini.example.test/v1?key=gemini-secret")).not.toContain("gemini-secret");
		expect(cleanReason('{\\"access_token\\":\\"escaped-secret\\"}')).not.toContain("escaped-secret");
		const escapedInterior = cleanReason('{\\"access_token\\":\\"prefix\\\\\\"suffix\\"}');
		expect(escapedInterior).not.toContain("prefix");
		expect(escapedInterior).not.toContain("suffix");
		expect(cleanReason('{"\\u0061ccess_token":"unicode-escaped-secret"}')).toBe("Credential diagnostic unavailable.");
		expect(cleanReason("authorization_header=header-secret")).not.toContain("header-secret");
		expect(cleanReason("Authorization: Token multi-token-secret")).toBe("Credential diagnostic unavailable.");
		expect(cleanReason('{"Authorization": Token multi-token-secret}')).toBe("Credential diagnostic unavailable.");
		expect(cleanReason('api_key="opaque secret"')).toBe("Credential diagnostic unavailable.");
		expect(cleanReason("api_key = 'opaque secret'")).toBe("Credential diagnostic unavailable.");
		expect(cleanReason('Bearer "opaque secret"')).toBe("Credential diagnostic unavailable.");
		expect(cleanReason('client_secret = "client secret"')).toBe("Credential diagnostic unavailable.");
		expect(cleanReason('clientSecret: "client secret"')).toBe("Credential diagnostic unavailable.");
		expect(cleanReason("https://login.example/callback?code=authorization-code&state=opaque#fragment")).toBe(
			"https://login.example/callback",
		);
		expect(isSafeProviderScope("openai-codex")).toBe(true);
		expect(isSafeProviderScope("openai\u001b]52;c\u0007")).toBe(false);
		expect(isSafeProviderScope("openai-codex\n")).toBe(false);
	});
});
