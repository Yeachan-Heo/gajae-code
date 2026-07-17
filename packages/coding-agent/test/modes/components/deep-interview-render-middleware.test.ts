import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	formatDeepInterviewSelectorPrompt,
	isDeepInterviewAskQuestion,
	renderDeepInterviewAskQuestion,
} from "@gajae-code/coding-agent/deep-interview/render-middleware";
import { AssistantMessageComponent } from "@gajae-code/coding-agent/modes/components/assistant-message";
import { initTheme, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import { askToolRenderer } from "@gajae-code/coding-agent/tools/ask";

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

	it("keeps structured progress rows semantically anchorable", () => {
		const raw = [
			"Round 6 complete.",
			"",
			"| Dimension | Score | Weight | Weighted | Gap |",
			"|-----------|-------|--------|----------|-----|",
			"| Goal | 0.90 | 0.40 | 0.36 | Clear |",
			"| Constraints | 0.70 | 0.30 | 0.21 | 한국어 기준 유지 |",
			"| **Ambiguity** | | | **20%** | |",
			"",
			"**Next target:** 검토 기준",
		].join("\n");
		const component = new AssistantMessageComponent(
			createAssistantMessage(raw),
			false,
			undefined,
			"assistant:entry:deep-interview-progress",
		);
		const rendered = component.renderWithViewportAnchors(40);
		const titleRow = rendered.lines.findIndex(line => Bun.stripANSI(line).includes("Round 6 complete"));
		const koreanRow = rendered.lines.findIndex(line => Bun.stripANSI(line).includes("한국어 기준 유지"));
		expect(titleRow).toBeGreaterThanOrEqual(0);
		expect(koreanRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[titleRow]?.id).toBe("assistant:entry:deep-interview-progress:content:0:text");
		expect(rendered.anchors[koreanRow]?.id).toBe("assistant:entry:deep-interview-progress:content:0:text");
		const semanticRows = rendered.anchors.filter(anchor => anchor !== null);
		expect(semanticRows.length).toBeGreaterThan(3);
		for (let index = 1; index < semanticRows.length; index++) {
			expect(semanticRows[index].graphemeStart).toBeGreaterThanOrEqual(semanticRows[index - 1].graphemeEnd);
			expect(semanticRows[index].cellStart).toBeGreaterThanOrEqual(semanticRows[index - 1].cellEnd);
		}
		const selected = rendered.anchors[koreanRow];
		if (!selected) throw new Error("Expected semantic Korean row");
		const narrow = component.renderWithViewportAnchors(18);
		const resolved = narrow.anchors.find(
			anchor =>
				anchor?.id === selected.id &&
				anchor.graphemeStart <= selected.graphemeStart &&
				anchor.graphemeEnd > selected.graphemeStart &&
				anchor.cellStart <= selected.cellStart &&
				anchor.cellEnd > selected.cellStart,
		);
		expect(resolved).not.toBeNull();
		expect(resolved).not.toBeUndefined();
	});
});

describe("deep-interview render middleware null-safety", () => {
	for (const value of [undefined, null] as const) {
		it(`does not throw on ${String(value)} question input`, () => {
			// @ts-expect-error exercising defensive guard against missing question text
			expect(() => isDeepInterviewAskQuestion(value)).not.toThrow();
			// @ts-expect-error exercising defensive guard against missing question text
			expect(() => formatDeepInterviewSelectorPrompt(value)).not.toThrow();
			// @ts-expect-error exercising defensive guard against missing question text
			expect(() => renderDeepInterviewAskQuestion(value, theme)).not.toThrow();
			// @ts-expect-error exercising defensive guard against missing question text
			expect(isDeepInterviewAskQuestion(value)).toBe(false);
			// @ts-expect-error exercising defensive guard against missing question text
			expect(renderDeepInterviewAskQuestion(value, theme)).toBeNull();
		});
	}

	it("renders an ask result with a missing question field without crashing", () => {
		const result = {
			content: [{ type: "text", text: "User answers:" }],
			details: {
				results: [
					{
						id: "q1",
						// question intentionally omitted to mirror malformed/partial ask details
						options: ["a", "b"],
						multi: false,
						selectedOptions: ["a"],
					},
				],
			},
		};
		expect(() =>
			// @ts-expect-error partial details deliberately omit the question field
			askToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme).render(100),
		).not.toThrow();
	});
});
