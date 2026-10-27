import { describe, expect, test, vi } from "bun:test";
import {
	isProviderSafetyStopModelTrusted,
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
	PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
	registerProviderSafetyStopModel,
	withProviderSafetyStopAdapterInvocation,
} from "../src/adapter-internals/provider-safety-stop";
import * as publicAi from "../src/index";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { stream, streamSimple } from "../src/stream";
import type { AssistantMessage, Context, FetchImpl, Model } from "../src/types";
import { isProviderSafetyStopAuthenticated } from "../src/utils/provider-safety-stop";
import { createTrustedStrippedModelClone, registerFinalizedModelClone } from "../src/utils/trusted-model-clone";

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "Refusal (safety): Policy violation",
		timestamp: 1,
	};
}

describe("provider safety-stop provenance authority", () => {
	test("does not mint from a public OpenAI adapter with caller-supplied fetch", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		};
		const fetchImpl: FetchImpl = (async () =>
			new Response(
				JSON.stringify({
					error: { message: "filtered", type: "invalid_request_error", code: "content_filter" },
				}),
				{ status: 429, headers: { "Content-Type": "application/json" } },
			)) as FetchImpl;

		const result = await streamOpenAICompletions(model, context, {
			apiKey: "caller-key",
			fetch: fetchImpl,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorKind).toBeUndefined();
		expect(isProviderSafetyStopAuthenticated(result)).toBe(false);
	});

	test("does not mint from a public stream when a caller redirects a cloned model", async () => {
		const bundled = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model = { ...bundled, baseUrl: "https://attacker.example/v1" };
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { message: "filtered", type: "invalid_request_error", code: "content_filter" },
				}),
				{ status: 429, headers: { "Content-Type": "application/json" } },
			),
		);
		try {
			const result = await stream(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				{ apiKey: "caller-key", requestMaxRetries: 0, streamMaxRetries: 0 },
			).result();

			expect(fetchSpy).toHaveBeenCalled();
			expect(result.stopReason).toBe("error");
			expect(result.errorKind).toBeUndefined();
			expect(isProviderSafetyStopAuthenticated(result)).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("preserves authenticated safety stops through the Synthetic wrapper", async () => {
		const model = getBundledModel("synthetic", "hf:deepseek-ai/DeepSeek-R1-0528");
		if (!model) throw new Error("Expected bundled Synthetic model");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { message: "filtered", type: "invalid_request_error", code: "content_filter" },
				}),
				{ status: 429, headers: { "Content-Type": "application/json" } },
			),
		);
		try {
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
				{ apiKey: "synthetic-key", requestMaxRetries: 0, streamMaxRetries: 0 },
			).result();

			expect(fetchSpy).toHaveBeenCalled();
			expect(result.stopReason).toBe("error");
			expect(result.errorKind).toBe("provider_safety_stop");
			expect(isProviderSafetyStopAuthenticated(result)).toBe(true);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("public AI exports expose verification only, never the minting operation", () => {
		const publicSurface = publicAi as unknown as Record<string, unknown>;
		expect(publicSurface.applyProviderSafetyStop).toBeUndefined();
		expect(typeof publicSurface.isProviderSafetyStopAuthenticated).toBe("function");
		expect(publicSurface.revokeProviderSafetyStop).toBeUndefined();
		expect(publicSurface.transferProviderSafetyStop).toBeUndefined();
	});

	test("mints the typed kind only for structured first-party refusal signals", () => {
		for (const signal of ["refusal", "sensitive", "content_filter", "SAFETY", "JAILBREAK", "RECITATION"]) {
			const marked = message();
			expect(
				mintProviderSafetyStop(
					marked,
					signal,
					PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
					undefined,
					PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
				),
			).toBe(true);
			expect(marked.errorKind).toBe("provider_safety_stop");
			expect(isProviderSafetyStopAuthenticated(marked)).toBe(true);
		}
	});

	test("fails closed on an unrecognized signal: no kind, no authority", () => {
		const unmarked = message();
		unmarked.errorKind = "provider_safety_stop";
		expect(
			mintProviderSafetyStop(
				unmarked,
				"totally-not-a-refusal",
				PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
				undefined,
				PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
			),
		).toBe(false);
		// The pre-existing wire-assignable field stays exactly as unauthenticated
		// as it was; the adapter bug degraded to ordinary fallback, not a mint.
		expect(isProviderSafetyStopAuthenticated(unmarked)).toBe(false);
	});

	test("fails closed when a caller controls the adapter transport seam", () => {
		for (const callerTransport of [() => undefined, {}]) {
			const forged = message();
			expect(
				mintProviderSafetyStop(
					forged,
					"refusal",
					PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
					callerTransport,
					PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
				),
			).toBe(false);
			expect(forged.errorKind).toBeUndefined();
			expect(isProviderSafetyStopAuthenticated(forged)).toBe(false);
		}
	});

	test("snapshots caller transport to prevent Proxy TOCTOU on spread", () => {
		// Regression test for P1 id 4197329335: ensure the snapshotted fetch/client values
		// are used in the result, even if a Proxy would return different values on re-read.
		let fetchReadCount = 0;
		const targetOptions = { apiKey: "test-key" };
		// Define fetch as a getter so spread will re-read it
		Object.defineProperty(targetOptions, "fetch", {
			get() {
				fetchReadCount++;
				// Return undefined on first read, function on second read
				if (fetchReadCount === 1) return undefined;
				return () => new Response();
			},
			enumerable: true,
		});
		Object.defineProperty(targetOptions, "client", {
			get() {
				return undefined;
			},
			enumerable: true,
		});

		// First, verify that the getter logic works as expected
		const firstRead = Reflect.get(targetOptions, "fetch");
		const firstReadCount = fetchReadCount;
		const secondRead = Reflect.get(targetOptions, "fetch");
		const secondReadCount = fetchReadCount;

		// First read should return undefined, second should return function
		expect(firstRead).toBeUndefined();
		expect(typeof secondRead).toBe("function");
		expect(firstReadCount).toBe(1);
		expect(secondReadCount).toBe(2);

		// Create a fresh target for the actual test with a fresh counter
		let testFetchReadCount = 0;
		const testTargetOptions = { apiKey: "test-key" };
		Object.defineProperty(testTargetOptions, "fetch", {
			get() {
				testFetchReadCount++;
				if (testFetchReadCount === 1) return undefined;
				return () => new Response();
			},
			enumerable: true,
		});
		Object.defineProperty(testTargetOptions, "client", {
			get() {
				return undefined;
			},
			enumerable: true,
		});

		const result = withProviderSafetyStopAdapterInvocation(testTargetOptions as any);

		// The snapshot reads fetch (read 1 = undefined).
		// The spread operation in the object literal reads it again (read 2 = function).
		// However, the explicit assignment `fetch` after the spread overwrites with the
		// snapshotted value (undefined), preventing the caller-controlled function.
		// This ensures the caller cannot inject fetch after the authority check.
		expect(testFetchReadCount).toBe(2);

		// Since the snapshotted fetch is undefined, hasTransport should be false
		// and the adapter should add the invocation marker
		// The result should be a different object than the target (indicating we created a new one with the marker)
		expect(result).not.toBe(testTargetOptions);

		// The result should have at least one symbol property (the invocation marker)
		const resultSymbols = Object.getOwnPropertySymbols(result);
		expect(resultSymbols.length).toBeGreaterThan(0);

		// At least one of those symbols should have the value PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION
		const hasMarkerWithCorrectValue = resultSymbols.some(
			sym => Reflect.get(result, sym) === PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
		);
		expect(hasMarkerWithCorrectValue).toBe(true);

		// Crucially, fetch should be undefined (the snapshotted value), not the function
		// This proves the Proxy couldn't inject its function despite returning it on the second read
		expect(result.fetch).toBeUndefined();
	});

	test("requires the runtime-owned adapter invocation token", () => {
		const untrusted = message();
		expect(mintProviderSafetyStop(untrusted, "refusal", PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY)).toBe(false);
		expect(untrusted.errorKind).toBeUndefined();
		expect(isProviderSafetyStopAuthenticated(untrusted)).toBe(false);
	});

	test("a structurally forged capability cannot mint authority", () => {
		const forged = message();
		const forgedCapability = {} as Parameters<typeof mintProviderSafetyStop>[2];
		expect(
			mintProviderSafetyStop(
				forged,
				"refusal",
				forgedCapability,
				undefined,
				PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
			),
		).toBe(false);
		expect(isProviderSafetyStopAuthenticated(forged)).toBe(false);
		expect(forged.errorKind).toBeUndefined();
	});

	test("a public consumer cannot clone authority from a genuine marked source", () => {
		const marked = message();
		expect(
			mintProviderSafetyStop(
				marked,
				"refusal",
				PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
				undefined,
				PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
			),
		).toBe(true);

		const forgedDestination = { ...marked };
		expect(isProviderSafetyStopAuthenticated(marked)).toBe(true);
		expect(isProviderSafetyStopAuthenticated(forgedDestination)).toBe(false);
		expect((publicAi as unknown as Record<string, unknown>).transferProviderSafetyStop).toBeUndefined();
	});

	test("data alone is never authenticated: clones, JSON round-trips, and fresh copies lose authority", () => {
		const marked = message();
		expect(
			mintProviderSafetyStop(
				marked,
				"refusal",
				PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
				undefined,
				PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
			),
		).toBe(true);

		const cloned = structuredClone(marked);
		expect(cloned.errorKind).toBe("provider_safety_stop");
		expect(isProviderSafetyStopAuthenticated(cloned)).toBe(false);

		const persisted = JSON.parse(JSON.stringify(marked)) as AssistantMessage;
		expect(persisted.errorKind).toBe("provider_safety_stop");
		expect(isProviderSafetyStopAuthenticated(persisted)).toBe(false);

		const fresh = message();
		fresh.errorKind = "provider_safety_stop";
		expect(isProviderSafetyStopAuthenticated(fresh)).toBe(false);
		expect(isProviderSafetyStopAuthenticated(undefined)).toBe(false);
		expect(isProviderSafetyStopAuthenticated("provider_safety_stop")).toBe(false);
	});

	test("the mint module is unreachable through the package export map", async () => {
		// Deep imports through the public package name resolve through the
		// exports map; `./adapter-internals/*` is null there, so neither the
		// mint nor the capability is importable outside first-party relative
		// imports (#4777 review follow-up).
		// Non-literal specifier so typecheck cannot resolve the blocked subpath;
		// the point is runtime resolution failing closed.
		const deepImport = "@gajae-code/ai/adapter-internals/provider-safety-stop";
		await expect(import(deepImport)).rejects.toThrow();
		const manifest = (await import("../package.json", { with: { type: "json" } })).default;
		expect(manifest.exports["./adapter-internals/*"]).toBeNull();
		expect(manifest.exports["./adapter-internals/*.js"]).toBeNull();
	});

	describe("model identity snapshot and clone registration", () => {
		test("clone with changed baseUrl is rejected as untrusted", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);
			expect(isProviderSafetyStopModelTrusted(original)).toBeTruthy();

			const cloneWithDifferentBaseUrl = { ...original, baseUrl: "https://attacker.example/v1" };
			registerFinalizedModelClone(original, cloneWithDifferentBaseUrl);

			// Clone with arbitrary baseUrl is not trusted
			expect(isProviderSafetyStopModelTrusted(cloneWithDifferentBaseUrl)).toBe(false);
		});

		test("clone with changed provider is rejected as untrusted", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);
			expect(isProviderSafetyStopModelTrusted(original)).toBeTruthy();

			const cloneWithDifferentProvider = { ...original, provider: "attacker" };
			registerFinalizedModelClone(original, cloneWithDifferentProvider);

			// Clone with changed provider is not trusted
			expect(isProviderSafetyStopModelTrusted(cloneWithDifferentProvider)).toBe(false);
		});

		test("clone with changed id is rejected as untrusted", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);
			expect(isProviderSafetyStopModelTrusted(original)).toBeTruthy();

			const cloneWithDifferentId = { ...original, id: "attacker-model" };
			registerFinalizedModelClone(original, cloneWithDifferentId);

			// Clone with changed id is not trusted
			expect(isProviderSafetyStopModelTrusted(cloneWithDifferentId)).toBe(false);
		});

		test("clone with changed api is rejected as untrusted", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);
			expect(isProviderSafetyStopModelTrusted(original)).toBeTruthy();

			const cloneWithDifferentApi = { ...original, api: "attacker-api" as any };
			registerFinalizedModelClone(original, cloneWithDifferentApi);

			// Clone with changed api is not trusted
			expect(isProviderSafetyStopModelTrusted(cloneWithDifferentApi)).toBe(false);
		});

		test("mutating registered clone's baseUrl makes it untrusted", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);
			expect(isProviderSafetyStopModelTrusted(original)).toBeTruthy();

			// Register a clone
			const clone = { ...original };
			const registered = registerFinalizedModelClone(original, clone);
			expect(registered).toBeDefined();
			expect(isProviderSafetyStopModelTrusted(registered!)).toBeTruthy();

			// Mutate the registered model's baseUrl
			(registered as any).baseUrl = "https://attacker.example";

			// Mutated model is no longer trusted
			expect(isProviderSafetyStopModelTrusted(registered!)).toBe(false);
		});

		test("createTrustedStrippedModelClone strips userinfo/query/hash and registers as trusted", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			const modelWithUserinfo = {
				...original,
				baseUrl: "https://user:pass@example.com/v1?key=secret#section",
			};

			registerProviderSafetyStopModel(modelWithUserinfo);
			expect(isProviderSafetyStopModelTrusted(modelWithUserinfo)).toBeTruthy();

			const stripped = createTrustedStrippedModelClone(modelWithUserinfo);

			// Stripped clone should have userinfo/query/hash removed
			expect(stripped.baseUrl).toBe("https://example.com/v1");
			// Stripped clone is trusted
			expect(isProviderSafetyStopModelTrusted(stripped)).toBeTruthy();
		});

		test("createTrustedStrippedModelClone handles invalid URLs gracefully", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			const modelWithInvalidUrl = {
				...original,
				baseUrl: "not-a-valid-url",
			};

			registerProviderSafetyStopModel(modelWithInvalidUrl);
			expect(isProviderSafetyStopModelTrusted(modelWithInvalidUrl)).toBeTruthy();

			const stripped = createTrustedStrippedModelClone(modelWithInvalidUrl);

			// Stripped clone should not have baseUrl
			expect(stripped.baseUrl).toBeUndefined();
			// Stripped clone is still trusted
			expect(isProviderSafetyStopModelTrusted(stripped)).toBeTruthy();
		});

		test("registerFinalizedModelClone rejects getter-based clone", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			// Create a clone with a getter for baseUrl
			const getterClone = Object.create(Object.prototype);
			Object.defineProperty(getterClone, "api", { value: original.api, writable: true });
			Object.defineProperty(getterClone, "provider", { value: original.provider, writable: true });
			Object.defineProperty(getterClone, "id", { value: original.id, writable: true });
			Object.defineProperty(getterClone, "baseUrl", {
				get() {
					return original.baseUrl;
				},
			});

			// Try to register the getter-based clone
			registerFinalizedModelClone(original, getterClone);

			// The getter-based clone should NOT be trusted
			expect(isProviderSafetyStopModelTrusted(getterClone)).toBe(false);
		});

		test("registerFinalizedModelClone with Proxy still registers if first read is correct", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			// Create a Proxy with a custom get trap that changes baseUrl on different reads
			let readCount = 0;
			const proxyClone = new Proxy(original, {
				get(target, prop) {
					if (prop === "baseUrl") {
						readCount++;
						// Return different values on different reads
						return readCount === 1 ? original.baseUrl : "https://attacker.example";
					}
					return Reflect.get(target, prop);
				},
			}) as Model<"openai-completions">;

			// Try to register the proxy clone
			const returned = registerFinalizedModelClone(original, proxyClone);

			// The returned object should be a fresh object built from the trusted snapshot
			expect(returned).toBeDefined();
			expect(returned).not.toBe(proxyClone);
			// The returned object should be trusted (built from original's snapshot)
			expect(isProviderSafetyStopModelTrusted(returned!)).toBeTruthy();
			// The proxy itself should NOT be trusted (because we didn't register the proxy)
			expect(isProviderSafetyStopModelTrusted(proxyClone)).toBe(false);
		});

		test("registerFinalizedModelClone builds fresh object from trusted snapshot", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			// Create a clone with additional properties
			const plainClone = { ...original, customField: "value" } as any;

			// Register the clone
			const returned = registerFinalizedModelClone(original, plainClone);

			// The returned value should be a new object
			expect(returned).toBeDefined();
			expect(returned).not.toBe(plainClone);
			// But it should contain the identity fields
			expect(returned!.api).toBe(original.api);
			expect(returned!.provider).toBe(original.provider);
			expect(returned!.id).toBe(original.id);
			expect(returned!.baseUrl).toBe(original.baseUrl);
			// The returned object should be trusted
			expect(isProviderSafetyStopModelTrusted(returned!)).toBeTruthy();
		});

		test("registerFinalizedModelClone with non-identity fields", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			const clone = { ...original, headers: { Authorization: "Bearer token" } } as any;
			const returned = registerFinalizedModelClone(original, clone);

			// The returned object should contain non-identity fields from the clone
			expect(returned).toBeDefined();
			expect(returned!.headers).toEqual({ Authorization: "Bearer token" });
			// The returned object should be trusted
			expect(isProviderSafetyStopModelTrusted(returned!)).toBeTruthy();
		});

		test("registerFinalizedModelClone builds fresh object even with Proxy on read 3+", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			// Create a Proxy that changes baseUrl on read 3
			let readCount = 0;
			const proxyClone = new Proxy(original, {
				get(target, prop) {
					if (prop === "baseUrl") {
						readCount++;
						return readCount >= 3 ? "https://attacker.example" : original.baseUrl;
					}
					return Reflect.get(target, prop);
				},
			}) as Model<"openai-completions">;

			const returned = registerFinalizedModelClone(original, proxyClone);

			// The function should return a fresh object
			expect(returned).toBeDefined();
			expect(returned).not.toBe(proxyClone);
			// The returned object should have the correct identity
			expect(returned!.baseUrl).toBe(original.baseUrl);
			// The returned object should be trusted
			expect(isProviderSafetyStopModelTrusted(returned!)).toBeTruthy();
			// The proxy itself should NOT be trusted
			expect(isProviderSafetyStopModelTrusted(proxyClone)).toBe(false);
		});

		test("registerFinalizedModelClone builds fresh object even with Proxy on read 4+", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			// Create a Proxy that changes baseUrl on read 4
			let readCount = 0;
			const proxyClone = new Proxy(original, {
				get(target, prop) {
					if (prop === "baseUrl") {
						readCount++;
						return readCount >= 4 ? "https://attacker.example" : original.baseUrl;
					}
					return Reflect.get(target, prop);
				},
			}) as Model<"openai-completions">;

			const returned = registerFinalizedModelClone(original, proxyClone);

			// Fresh object should be built and returned
			expect(returned).toBeDefined();
			expect(returned).not.toBe(proxyClone);
			expect(returned!.baseUrl).toBe(original.baseUrl);
			expect(isProviderSafetyStopModelTrusted(returned!)).toBeTruthy();
		});

		test("registerFinalizedModelClone builds fresh object even with Proxy on read 5+", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			// Create a Proxy that changes baseUrl on read 5
			let readCount = 0;
			const proxyClone = new Proxy(original, {
				get(target, prop) {
					if (prop === "baseUrl") {
						readCount++;
						return readCount >= 5 ? "https://attacker.example" : original.baseUrl;
					}
					return Reflect.get(target, prop);
				},
			}) as Model<"openai-completions">;

			const returned = registerFinalizedModelClone(original, proxyClone);

			expect(returned).toBeDefined();
			expect(returned).not.toBe(proxyClone);
			expect(returned!.baseUrl).toBe(original.baseUrl);
			expect(isProviderSafetyStopModelTrusted(returned!)).toBeTruthy();
		});

		test("registerFinalizedModelClone builds fresh object even with Proxy on read 6+", () => {
			const original = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
			if (!original) throw new Error("Expected bundled OpenAI model");

			registerProviderSafetyStopModel(original);

			// Create a Proxy that changes baseUrl on read 6
			let readCount = 0;
			const proxyClone = new Proxy(original, {
				get(target, prop) {
					if (prop === "baseUrl") {
						readCount++;
						return readCount >= 6 ? "https://attacker.example" : original.baseUrl;
					}
					return Reflect.get(target, prop);
				},
			}) as Model<"openai-completions">;

			const returned = registerFinalizedModelClone(original, proxyClone);

			expect(returned).toBeDefined();
			expect(returned).not.toBe(proxyClone);
			expect(returned!.baseUrl).toBe(original.baseUrl);
			expect(isProviderSafetyStopModelTrusted(returned!)).toBeTruthy();
		});

		test("registerFinalizedModelClone returns undefined when original is not trusted", () => {
			// Create a fresh model object that's not registered
			const unregisteredModel: Model<"openai-completions"> = {
				id: "custom-model",
				name: "Custom Model",
				api: "openai-completions",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			};

			// Don't register the original as trusted
			const clone = { ...unregisteredModel };
			const returned = registerFinalizedModelClone(unregisteredModel, clone);

			// When original is not trusted, return undefined
			expect(returned).toBeUndefined();
		});
	});
});
