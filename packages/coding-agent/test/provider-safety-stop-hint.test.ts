/**
 * Issue #4650 — provider_safety_stop diagnostics hint.
 *
 * Presentation-only contract:
 * - the terminal stop is unchanged: no retry, no second dispatch, no state
 *   mutation (#2069/#2077 invariants preserved);
 * - the raw provider refusal is retained verbatim, never replaced;
 * - a configured-chain alternate is named only when it validates against the
 *   current catalog; otherwise bounded static guidance is shown;
 * - unrelated error kinds get no hint at all.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import {
	formatProviderSafetyStopDisplayError,
	formatProviderSafetyStopHint,
	isProviderSafetyStop,
	refusingModelSelector,
	resolveProviderSafetyStopHint,
	resolveSafetyStopAlternateSelector,
} from "../src/session/provider-safety-stop-hint";

function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorKind: "provider_safety_stop",
		errorMessage: "Refusal (reasoning_extraction): This request was blocked.",
		timestamp: 0,
		...overrides,
	};
}

const catalog: Model[] = [
	{ provider: "anthropic", id: "claude-fable-5", api: "anthropic-messages" } as unknown as Model,
	{ provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages" } as unknown as Model,
];

describe("isProviderSafetyStop", () => {
	it("recognizes typed safety stops", () => {
		expect(isProviderSafetyStop(makeAssistant({ errorKind: "provider_safety_stop" }))).toBe(true);
	});

	it("recognizes legacy persisted refusal labels", () => {
		expect(
			isProviderSafetyStop(makeAssistant({ errorKind: undefined, errorMessage: "Refusal (no details provided)" })),
		).toBe(true);
		expect(
			isProviderSafetyStop(
				makeAssistant({ errorKind: undefined, errorMessage: "Content flagged by safety filters" }),
			),
		).toBe(true);
	});

	it("rejects unrelated errors and non-error stops", () => {
		expect(isProviderSafetyStop(makeAssistant({ errorKind: undefined, errorMessage: "rate limit exceeded" }))).toBe(
			false,
		);
		expect(
			isProviderSafetyStop(makeAssistant({ stopReason: "stop", errorKind: undefined, errorMessage: undefined })),
		).toBe(false);
		// Errors that merely mention refusal prose mid-sentence stay retryable (#2077).
		expect(
			isProviderSafetyStop(
				makeAssistant({ errorKind: undefined, errorMessage: "upstream said refusal once but retried ok" }),
			),
		).toBe(false);
	});
});

describe("refusingModelSelector", () => {
	it("uses the message's own provider/model identity", () => {
		expect(refusingModelSelector(makeAssistant())).toBe("anthropic/claude-fable-5");
		expect(refusingModelSelector(makeAssistant({ provider: undefined, model: undefined }))).toBeUndefined();
	});
});

describe("resolveSafetyStopAlternateSelector", () => {
	it("names the first valid non-refusing chain entry", () => {
		expect(
			resolveSafetyStopAlternateSelector(
				"anthropic/claude-fable-5",
				["anthropic/claude-fable-5", "anthropic/claude-opus-5"],
				catalog,
			),
		).toBe("anthropic/claude-opus-5");
	});

	it("accepts a configured chain value in string form", () => {
		expect(resolveSafetyStopAlternateSelector("anthropic/claude-fable-5", "anthropic/claude-opus-5", catalog)).toBe(
			"anthropic/claude-opus-5",
		);
	});

	it("skips the refuser under a different thinking level", () => {
		expect(
			resolveSafetyStopAlternateSelector(
				"anthropic/claude-fable-5",
				["anthropic/claude-fable-5:high", "anthropic/claude-fable-5:low"],
				catalog,
			),
		).toBeUndefined();
	});

	it("returns undefined when the only other entry is not in the catalog", () => {
		expect(
			resolveSafetyStopAlternateSelector(
				"anthropic/claude-fable-5",
				["anthropic/claude-fable-5", "openai/gpt-9"],
				catalog,
			),
		).toBeUndefined();
	});

	it("returns undefined for empty chains, missing refuser, or malformed entries", () => {
		expect(resolveSafetyStopAlternateSelector("anthropic/claude-fable-5", [], catalog)).toBeUndefined();
		expect(resolveSafetyStopAlternateSelector(undefined, ["anthropic/claude-opus-5"], catalog)).toBeUndefined();
		expect(
			resolveSafetyStopAlternateSelector("anthropic/claude-fable-5", ["not-a-selector"], catalog),
		).toBeUndefined();
		expect(
			resolveSafetyStopAlternateSelector("anthropic/claude-fable-5", ["anthropic/", "/x"], catalog),
		).toBeUndefined();
	});

	it("never names a malformed thinking-suffix selector as an alternate (#4653 review)", () => {
		// `:bogus` is not a thinking level; the resolver must reject the entry
		// instead of stripping the suffix and offering the base model.
		expect(
			resolveSafetyStopAlternateSelector(
				"anthropic/claude-fable-5",
				["anthropic/claude-fable-5", "anthropic/claude-opus-5:bogus"],
				catalog,
			),
		).toBeUndefined();
		// Same guard when the malformed entry is the only chain tail.
		expect(
			resolveSafetyStopAlternateSelector("anthropic/claude-fable-5", ["anthropic/claude-opus-5:bogus"], catalog),
		).toBeUndefined();
	});

	it("resolves route-suffixed IDs through the authoritative resolver (#4653 review)", () => {
		// OpenRouter-style route suffixes are legal model IDs, not thinking
		// levels. A route-suffixed alternate that exists in the catalog is
		// nameable, and one that does not exist is skipped.
		const routedCatalog: Model[] = [
			{
				provider: "openrouter",
				id: "anthropic/claude-opus-5:extended",
				api: "openai-completions",
			} as unknown as Model,
			{ provider: "openrouter", id: "anthropic/claude-fable-5", api: "openai-completions" } as unknown as Model,
		];
		expect(
			resolveSafetyStopAlternateSelector(
				"openrouter/anthropic/claude-fable-5",
				["openrouter/anthropic/claude-fable-5", "openrouter/anthropic/claude-opus-5:extended"],
				routedCatalog,
			),
		).toBe("openrouter/anthropic/claude-opus-5:extended");
		expect(
			resolveSafetyStopAlternateSelector(
				"openrouter/anthropic/claude-fable-5",
				["openrouter/anthropic/claude-fable-5", "openrouter/anthropic/claude-opus-5:novel-route"],
				routedCatalog,
			),
		).toBeUndefined();
	});

	it("falls back to static guidance when the refuser itself does not resolve", () => {
		expect(
			resolveSafetyStopAlternateSelector(
				"anthropic/claude-fable-5",
				["anthropic/claude-fable-5", "anthropic/claude-opus-5"],
				[], // empty catalog: identity comparison is unsafe
			),
		).toBeUndefined();
	});
});

describe("formatProviderSafetyStopHint", () => {
	it("names the alternate and the /model command when one is resolved", () => {
		const hint = formatProviderSafetyStopHint("anthropic/claude-opus-5");
		expect(hint).toContain("specific to the (model, context) pair");
		expect(hint).toContain("not necessarily at fault");
		expect(hint).toContain("does not need to be discarded");
		expect(hint).toContain("/model anthropic/claude-opus-5");
		// Never claims the alternate is guaranteed.
		expect(hint).toContain("not guaranteed");
	});

	it("falls back to bounded static guidance without naming any model", () => {
		const hint = formatProviderSafetyStopHint(undefined);
		expect(hint).toContain("/model");
		expect(hint).toContain("manual model switch");
		expect(hint).not.toContain("chain also contains");
	});
});

describe("resolveProviderSafetyStopHint", () => {
	it("resolves the configured alternate through the session", () => {
		const session = {
			getConfiguredModelChainState: () => ({
				entries: ["anthropic/claude-fable-5", "anthropic/claude-opus-5"],
				origin: "modelRoles",
				explicitHead: true,
			}),
			getAvailableModels: () => catalog,
		};
		const hint = resolveProviderSafetyStopHint(makeAssistant(), session);
		expect(hint).toContain("/model anthropic/claude-opus-5");
	});

	it("falls back to static guidance when no session is available", () => {
		const hint = resolveProviderSafetyStopHint(makeAssistant(), undefined);
		expect(hint).toContain("manual model switch");
		expect(hint).not.toContain("chain also contains");
	});

	it("falls back to static guidance when the session has no chain", () => {
		const hint = resolveProviderSafetyStopHint(makeAssistant(), {});
		expect(hint).toContain("manual model switch");
	});

	it("returns undefined for unrelated error kinds", () => {
		const unrelated = makeAssistant({ errorKind: undefined, errorMessage: "500 internal error" });
		expect(resolveProviderSafetyStopHint(unrelated, { getAvailableModels: () => catalog })).toBeUndefined();
	});
});

describe("formatProviderSafetyStopDisplayError", () => {
	it("retains the raw provider refusal and appends the hint", () => {
		const display = formatProviderSafetyStopDisplayError(makeAssistant(), "anthropic/claude-opus-5");
		expect(display).toContain("Refusal (reasoning_extraction): This request was blocked.");
		expect(display?.startsWith("Refusal (reasoning_extraction)")).toBe(true);
		expect(display).toContain("/model anthropic/claude-opus-5");
	});

	it("shows the hint alone when the provider gave no message", () => {
		const display = formatProviderSafetyStopDisplayError(makeAssistant({ errorMessage: undefined }), undefined);
		expect(display).toContain("Provider safety stop");
	});

	it("returns undefined for unrelated errors", () => {
		expect(
			formatProviderSafetyStopDisplayError(
				makeAssistant({ errorKind: undefined, errorMessage: "timeout" }),
				undefined,
			),
		).toBeUndefined();
	});
});
