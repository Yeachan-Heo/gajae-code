/**
 * Issue #4650 — TUI render of the provider_safety_stop hint.
 *
 * Proves the AssistantMessageComponent renders the raw provider refusal
 * unchanged AND appends the bounded hint after it, with no hint for unrelated
 * error kinds. Rendering only — no dispatch, no state mutation.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai/core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { ProviderSafetyStopHintSession } from "@gajae-code/coding-agent/session/provider-safety-stop-hint";

const REFUSAL = "Refusal (reasoning_extraction): This request was blocked as it seems to violate restrictions.";

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
		errorMessage: REFUSAL,
		timestamp: 0,
		...overrides,
	};
}

function renderPlain(component: AssistantMessageComponent, width = 100): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

/** Compare against wrap-insensitive prose: collapse all whitespace runs. */
function compact(text: string): string {
	return text.replace(/\s+/gu, " ");
}

describe("AssistantMessageComponent provider safety stop hint (#4650)", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const themeInstance = await getThemeByName("red-claw");
		if (!themeInstance) throw new Error("Failed to load test theme");
		setThemeInstance(themeInstance);
	});

	it("renders the raw refusal and appends the hint naming the validated alternate", () => {
		const hintSession: ProviderSafetyStopHintSession = {
			getConfiguredModelChainState: () => ({
				entries: ["anthropic/claude-fable-5", "anthropic/claude-opus-5"],
				origin: "modelRoles",
				explicitHead: true,
			}),
			getAvailableModels: () =>
				[
					{ provider: "anthropic", id: "claude-fable-5" },
					{ provider: "anthropic", id: "claude-opus-5" },
				] as never,
		};
		const component = new AssistantMessageComponent(
			makeAssistant(),
			false,
			undefined,
			undefined,
			undefined,
			hintSession,
		);
		const rendered = compact(renderPlain(component));
		// Raw refusal retained verbatim.
		expect(rendered).toContain(REFUSAL);
		// Hint appended after it, naming the alternate and the command.
		expect(rendered.indexOf(REFUSAL)).toBeLessThan(rendered.indexOf("Provider safety stop"));
		expect(rendered).toContain("/model anthropic/claude-opus-5");
		expect(rendered).toContain("not guaranteed");
	});

	it("falls back to bounded static guidance when no alternate can be named", () => {
		const component = new AssistantMessageComponent(makeAssistant(), false, undefined, undefined, undefined, {});
		const rendered = compact(renderPlain(component));
		expect(rendered).toContain(REFUSAL);
		expect(rendered).toContain("manual model switch");
		expect(rendered).not.toContain("chain also contains");
	});

	it("renders no hint for unrelated terminal errors", () => {
		const component = new AssistantMessageComponent(
			makeAssistant({ errorKind: undefined, errorMessage: "401 unauthorized: invalid api key" }),
			false,
			undefined,
			undefined,
			undefined,
			{},
		);
		const rendered = renderPlain(component);
		expect(rendered).toContain("401 unauthorized");
		expect(rendered).not.toContain("Provider safety stop");
	});

	it("renders the hint for legacy persisted refusal labels too", () => {
		const component = new AssistantMessageComponent(
			makeAssistant({ errorKind: undefined, errorMessage: "Refusal (no details provided)" }),
			false,
			undefined,
			undefined,
			undefined,
			{},
		);
		const rendered = compact(renderPlain(component));
		expect(rendered).toContain("Refusal (no details provided)");
		expect(rendered).toContain("manual model switch");
	});
});
