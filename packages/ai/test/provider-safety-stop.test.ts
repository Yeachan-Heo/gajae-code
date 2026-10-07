import { describe, expect, test, vi } from "bun:test";
import {
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
	PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
} from "../src/adapter-internals/provider-safety-stop";
import * as publicAi from "../src/index";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { stream, streamSimple } from "../src/stream";
import type { AssistantMessage, Context, FetchImpl, Model } from "../src/types";
import { isProviderSafetyStopAuthenticated } from "../src/utils/provider-safety-stop";

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
});
