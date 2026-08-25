import { describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { createAuthGatewayModelCatalog, startAuthGateway } from "../src/auth-gateway/server";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
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
		await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
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

async function withGateway(
	provider: string,
	models: readonly Model<Api>[],
	resolveModel: (id: string) => Model<Api> | undefined,
	fn: (url: string) => Promise<void>,
): Promise<void> {
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		providerScope: { provider },
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
				bearerTokens: [],
				version: "test",
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
			bearerTokens: [],
			version: "test",
			hasProviderCredential: () => credentialAvailable,
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

	it("keeps usage and credential checks inside the selected provider scope", async () => {
		const provider = "scope-diagnostics-provider";
		const otherProvider = "scope-diagnostics-other";
		const scopedModel = model("scope-diagnostics-model", provider, "openai-codex-responses");
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			providerScope: { provider },
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
});
