import { describe, expect, test } from "bun:test";
import { validRecommendedIndex } from "./ask";
import { askSchema, ordinaryAskSchema } from "./ask-contract";

const baseQuestion = {
	id: "q",
	question: "Choose one.",
	options: [{ label: "Keep current behavior" }, { label: "Use repository default" }],
};

describe("ask option contract", () => {
	test("rejects custom-input pseudo-options", () => {
		for (const label of [
			"Other",
			"Other (type your own)",
			"Type your own",
			"custom input",
			"직접 입력",
			"직접 입력으로 추가",
		]) {
			const result = ordinaryAskSchema.safeParse({
				questions: [{ ...baseQuestion, options: [{ label }, { label: "Cancel" }], recommended: 0 }],
			});
			expect(result.success, label).toBe(false);
		}
	});

	test("accepts ordinary recommended options", () => {
		const result = ordinaryAskSchema.safeParse({ questions: [{ ...baseQuestion, recommended: 0 }] });
		expect(result.success).toBe(true);
	});

	test("applies pseudo-option rejection to deep-interview ask schema", () => {
		const result = askSchema.safeParse({
			questions: [{ ...baseQuestion, options: [{ label: "직접 입력으로 추가" }, { label: "취소" }] }],
		});
		expect(result.success).toBe(false);
	});

	test("does not recommend single-option questions", () => {
		expect(validRecommendedIndex(0, 1)).toBeUndefined();
		expect(validRecommendedIndex(0, 2)).toBe(0);
	});
});
