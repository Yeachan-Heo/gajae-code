import { describe, expect, test } from "bun:test";
import {
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
} from "../src/adapter-internals/provider-safety-stop";
import * as publicAi from "../src/index";
import type { AssistantMessage } from "../src/types";
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
	test("public AI exports expose verification only, never the minting operation", () => {
		const publicSurface = publicAi as unknown as Record<string, unknown>;
		expect(publicSurface.applyProviderSafetyStop).toBeUndefined();
		expect(typeof publicSurface.isProviderSafetyStopAuthenticated).toBe("function");
		expect(typeof publicSurface.transferProviderSafetyStop).toBe("function");
	});

	test("mints the typed kind only for structured first-party refusal signals", () => {
		for (const signal of ["refusal", "sensitive", "content_filter", "SAFETY", "JAILBREAK", "RECITATION"]) {
			const marked = message();
			expect(mintProviderSafetyStop(marked, signal, PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY)).toBe(true);
			expect(marked.errorKind).toBe("provider_safety_stop");
			expect(isProviderSafetyStopAuthenticated(marked)).toBe(true);
		}
	});

	test("fails closed on an unrecognized signal: no kind, no authority", () => {
		const unmarked = message();
		unmarked.errorKind = "provider_safety_stop";
		expect(mintProviderSafetyStop(unmarked, "totally-not-a-refusal", PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY)).toBe(
			false,
		);
		// The pre-existing wire-assignable field stays exactly as unauthenticated
		// as it was; the adapter bug degraded to ordinary fallback, not a mint.
		expect(isProviderSafetyStopAuthenticated(unmarked)).toBe(false);
	});

	test("a structurally forged capability cannot mint authority", () => {
		const forged = message();
		const forgedCapability = {} as Parameters<typeof mintProviderSafetyStop>[2];
		expect(mintProviderSafetyStop(forged, "refusal", forgedCapability)).toBe(false);
		expect(isProviderSafetyStopAuthenticated(forged)).toBe(false);
		expect(forged.errorKind).toBeUndefined();
	});

	test("data alone is never authenticated: clones, JSON round-trips, and fresh copies lose authority", () => {
		const marked = message();
		expect(mintProviderSafetyStop(marked, "refusal", PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY)).toBe(true);

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
});
