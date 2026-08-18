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
import { parseModelPattern } from "../src/config/model-resolver";
import {
	formatProviderSafetyStopDisplayError,
	formatProviderSafetyStopHint,
	isProviderSafetyStop,
	refusingModelSelector,
	resolveProviderSafetyStopHint,
	resolveSafetyStopAlternateSelector,
	sanitizeModelSelectorForDisplay,
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
	it("reconstructs the selector from the resolved model, never the unresolved entry (#4653 review)", () => {
		// A bare entry still names its resolved model as a provider-qualified
		// selector, so the advertised /model command pins exactly the model that
		// was validated.
		expect(resolveSafetyStopAlternateSelector("anthropic/claude-fable-5", ["claude-opus-5"], catalog)).toBe(
			"anthropic/claude-opus-5",
		);
		// A substring entry resolves through fuzzy matching onto its dated
		// variant, and the hint must name that concrete variant.
		const fuzzyCatalog: Model[] = [
			{ provider: "openai", id: "gpt-5-turbo", input: ["text"], api: "openai-completions" } as unknown as Model,
			{
				provider: "anthropic",
				id: "claude-fable-5",
				input: ["text"],
				api: "anthropic-messages",
			} as unknown as Model,
		];
		expect(resolveSafetyStopAlternateSelector("anthropic/claude-fable-5", ["turbo"], fuzzyCatalog)).toBe(
			"openai/gpt-5-turbo",
		);
	});

	it("never routes an ambiguous cross-provider entry back to the refusing provider (#4653 review)", () => {
		// The hint resolver runs without usage-preference context; the real
		// /model command resolves with model usage order. When the same bare ID
		// exists under two providers, the two resolvers can disagree about which
		// provider it means: without usage order the deprioritization ranking
		// picks one, with the refuser's provider first in usage order the real
		// command picks the other — the refusing provider itself.
		const ambiguousId = "shared-model";
		const ambiguousCatalog: Model[] = [
			{ provider: "anthropic", id: ambiguousId, input: ["text"], api: "anthropic-messages" } as unknown as Model,
			{
				provider: "openai",
				id: ambiguousId,
				input: ["text", "image"],
				api: "openai-completions",
			} as unknown as Model,
		];
		// The refusing model is anthropic/shared-model. The ambiguous chain
		// entry is the bare ID "shared-model".
		//
		// 1) What the OLD behavior advertised: the raw entry "shared-model".
		//    Pasting `/model shared-model` resolves under usage-preference
		//    context where "anthropic/shared-model" is most recent — straight
		//    back to the refusing provider.
		// 2) What the fixed hint advertises: the provider-qualified selector of
		//    the model validated here, which is NOT the refuser. Pasting that
		//    command is an exact pin and can never re-select the refuser.
		const advertised = resolveSafetyStopAlternateSelector(
			`anthropic/${ambiguousId}`,
			[ambiguousId],
			ambiguousCatalog,
		);
		expect(advertised).toBeDefined();
		expect(advertised).not.toBe(ambiguousId);

		// Prove the divergence premise: the entry resolves differently under
		// the real /model command's usage-preference context (usage order
		// headed by the refusing provider) than under the hint resolver.
		const underUsage = parseModelPattern(ambiguousId, ambiguousCatalog, {
			usageOrder: [`anthropic/${ambiguousId}`, `openai/${ambiguousId}`],
		});
		const withoutUsage = parseModelPattern(ambiguousId, ambiguousCatalog, undefined);
		expect(underUsage.model?.provider).toBe("anthropic");
		expect(withoutUsage.model?.provider).toBe("openai");
		expect(withoutUsage.model?.provider).not.toBe(underUsage.model?.provider);

		// The hint must never name the refusing provider's ambiguous twin.
		expect(advertised).not.toContain("anthropic");
		// And it must be a provider-qualified exact pin.
		expect(advertised?.startsWith("openai/")).toBe(true);

		// Re-resolving the advertised selector under the usage-preference
		// context that favors the refusing provider still pins the validated
		// model: the advertised command can never route back to the refuser.
		const reResolved = parseModelPattern(advertised ?? "", ambiguousCatalog, {
			usageOrder: [`anthropic/${ambiguousId}`, `openai/${ambiguousId}`],
		});
		expect(reResolved.model?.provider).toBe("openai");
		expect(reResolved.model?.provider).not.toBe("anthropic");
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

describe("sanitizeModelSelectorForDisplay (#4653 review)", () => {
	it("keeps ordinary selectors unchanged", () => {
		expect(sanitizeModelSelectorForDisplay("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
	});

	it("strips ANSI escape sequences from custom model ids", () => {
		expect(sanitizeModelSelectorForDisplay("\x1b[31mred\x1b[0m/model")).toBe("red/model");
		expect(sanitizeModelSelectorForDisplay("provider/id\x1b]0;title\x07")).toBe("provider/id");
	});

	it("removes other control characters", () => {
		expect(sanitizeModelSelectorForDisplay("pro\x00vider/id")).toBe("provider/id");
		expect(sanitizeModelSelectorForDisplay("pro\x07vider/id")).toBe("provider/id");
		expect(sanitizeModelSelectorForDisplay("provider\r/id")).toBe("provider/id");
	});

	it("replaces tabs with single spaces, never tab-expands", () => {
		expect(sanitizeModelSelectorForDisplay("pro\tvider/id")).toBe("pro vider/id");
		expect(sanitizeModelSelectorForDisplay("a\t\tb")).toBe("a  b");
	});

	it("removes Unicode format controls (bidi overrides, zero-width joiners) from custom model ids (#4653 QA red-team)", () => {
		const hostile = "safe\u200Dmodel\u202Eroute";
		const safe = sanitizeModelSelectorForDisplay(hostile);
		expect(safe).toBe("safemodelroute");
		expect(safe).not.toMatch(/\p{Cf}/u);
		const hint = formatProviderSafetyStopHint(hostile);
		expect(hint).not.toMatch(/\p{Cf}/u);
		expect(hint).toContain("safemodelroute");
	});

	it("bounds unbounded custom model ids to the shared display limit", () => {
		const longId = `${"a".repeat(500)}/model`;
		const bounded = sanitizeModelSelectorForDisplay(longId);
		expect(Bun.stringWidth(bounded)).toBeLessThanOrEqual(64);
		expect(bounded.startsWith("aaa")).toBe(true);
	});

	it("never emits control characters or tabs for hostile input", () => {
		const hostile = "\t\x1b[2J\x1b[?25lprovider/id:x\t\b\x0b";
		const safe = sanitizeModelSelectorForDisplay(hostile);
		expect(safe).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/u);
		expect(safe).not.toContain("\t");
	});

	it("is applied by the hint formatter so both render surfaces share it", () => {
		const hostile = "\x1b[1manthropic\x1b[0m/claude-opus-5:x\t";
		const hint = formatProviderSafetyStopHint(hostile);
		expect(hint).toContain('"anthropic/claude-opus-5:x" —');
		expect(hint).toContain("/model anthropic/claude-opus-5:x.");
		expect(hint).not.toContain("\x1b");
	});
});
