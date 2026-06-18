import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderAssistantText(text: string): string {
	const component = new AssistantMessageComponent(createAssistantMessage(text));
	return Bun.stripANSI(component.render(100).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
	await Settings.init({ inMemory: true });
});

describe("deep-interview assistant render middleware", () => {
	it("renders progress tables as readable sections", () => {
		const raw = [
			"Round 3 complete.",
			"",
			"| Dimension | Score | Weight | Weighted | Gap |",
			"|-----------|-------|--------|----------|-----|",
			"| Goal | 0.80 | 0.40 | 0.32 | Clear |",
			"| Constraints | 0.65 | 0.30 | 0.20 | Mobile/Desktop boundaries are still unresolved |",
			"| Success Criteria | 0.55 | 0.30 | 0.17 | Approval completion criteria are not yet testable |",
			"| **Ambiguity** | | | **38%** | |",
			"",
			"**Topology:** Targeted Review UI | Active: 4 | Deferred: 0 | Next rotation after: review-ui",
			"**Ontology:** 6 entities | Stability: 75% | New: 1 | Changed: 0 | Stable: 5",
			"**Next target:** Review UI / Success Criteria — approval criteria remain unclear",
		].join("\n");

		const rendered = renderAssistantText(raw);

		expect(rendered).toContain("Deep Interview · Round 3 complete");
		expect(rendered).toContain("Ambiguity");
		expect(rendered).toContain("38%");
		expect(rendered).toContain("Constraints");
		expect(rendered).toContain("Gap: Mobile/Desktop boundaries are still unresolved");
		expect(rendered).toContain("Next target");
		expect(rendered).not.toContain("┌");
		expect(rendered).not.toContain("| Dimension | Score | Weight | Weighted | Gap |");
	});

	it("preserves unstructured progress lines instead of dropping them", () => {
		const raw = [
			"Round 4 complete.",
			"",
			"Matched entities: User→User, Task→Task",
			"| Dimension | Score | Weight | Weighted | Gap |",
			"|-----------|-------|--------|----------|-----|",
			"| Goal | 0.90 | 0.40 | 0.36 | Clear |",
			"| Constraints | 0.70 | 0.30 | 0.21 | Export limits still need clarification |",
			"| Success Criteria | 0.60 | 0.30 | 0.18 | Approval evidence is not fully testable |",
			"| **Ambiguity** | | | **25%** | |",
			"",
			"Clarity threshold met! Ready to proceed.",
		].join("\n");

		const rendered = renderAssistantText(raw);

		expect(rendered).toContain("Additional details");
		expect(rendered).toContain("Matched entities: User→User, Task→Task");
		expect(rendered).toContain("Status");
		expect(rendered).toContain("Clarity threshold met! Ready to proceed.");
	});

	it("preserves Korean text literally in deep-interview progress rendering", () => {
		const raw = [
			"Round 5 complete.",
			"",
			"| Dimension | Score | Weight | Weighted | Gap |",
			"|-----------|-------|--------|----------|-----|",
			"| Goal | 0.90 | 0.40 | 0.36 | Clear |",
			"| Constraints | 0.70 | 0.30 | 0.21 | 추천 내용 이해 자체가 어렵네요 |",
			"| Success Criteria | 0.60 | 0.30 | 0.18 | 한국어 출력이 리터럴로 보여야 합니다 |",
			"| **Ambiguity** | | | **25%** | |",
			"",
			"**Next target:** 리뷰 UI / Success Criteria — 한국어 기준을 명확히 합니다",
		].join("\n");

		const rendered = renderAssistantText(raw);

		expect(rendered).toContain("추천 내용 이해 자체가 어렵네요");
		expect(rendered).toContain("한국어 출력이 리터럴로 보여야 합니다");
		expect(rendered).toContain("한국어 기준을 명확히 합니다");
		expect(rendered).not.toContain("\\u");
	});
});
