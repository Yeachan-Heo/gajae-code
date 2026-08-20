import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "../src/types";
import { applyProviderSafetyStop, isProviderSafetyStopAuthenticated } from "../src/utils/provider-safety-stop";

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
	test("mints the typed kind only for structured first-party refusal signals", () => {
		for (const signal of ["refusal", "sensitive", "content_filter", "SAFETY", "JAILBREAK", "RECITATION"]) {
			const marked = message();
			expect(applyProviderSafetyStop(marked, signal)).toBe(true);
			expect(marked.errorKind).toBe("provider_safety_stop");
			expect(isProviderSafetyStopAuthenticated(marked)).toBe(true);
		}
	});

	test("fails closed on an unrecognized signal: no kind, no authority", () => {
		const unmarked = message();
		unmarked.errorKind = "provider_safety_stop";
		expect(applyProviderSafetyStop(unmarked, "totally-not-a-refusal")).toBe(false);
		// The pre-existing wire-assignable field stays exactly as unauthenticated
		// as it was; the adapter bug degraded to ordinary fallback, not a mint.
		expect(isProviderSafetyStopAuthenticated(unmarked)).toBe(false);
	});

	test("data alone is never authenticated: clones, JSON round-trips, and fresh copies lose authority", () => {
		const marked = message();
		expect(applyProviderSafetyStop(marked, "refusal")).toBe(true);

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
