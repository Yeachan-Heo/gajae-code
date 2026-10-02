import { describe, expect, test } from "bun:test";
import { validRecommendedIndex } from "./ask";
import {
	askSchema,
	ordinaryAskSchema,
	postTopologyAskSchema,
	recoverRoundZeroIntentContract,
	topologyAskSchema,
} from "./ask-contract";

const baseQuestion = {
	id: "q",
	question: "Choose one.",
	options: [{ label: "Keep current behavior" }, { label: "Use repository default" }],
};

describe("ask interview integrity", () => {
	const topologyQuestion = {
		...baseQuestion,
		deepInterview: {
			round: 0,
			component: "review-topology",
			dimension: "topology",
			ambiguity: 1,
			intent_contract: {
				items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
				confirmation_options: ["Keep current behavior"],
			},
		},
	};

	test("rejects the incident's missing metadata in both interview phases", () => {
		for (const [stage, schema] of [
			["topology", topologyAskSchema],
			["post-topology", postTopologyAskSchema],
		] as const) {
			const payload = { questions: [{ ...baseQuestion, question: "Round 0 | Topology confirmation" }] };
			expect(schema.safeParse(payload).success).toBe(false);
			expect(recoverRoundZeroIntentContract(payload, stage)).toMatchObject({
				outcome: "reject",
				code: "ask-deep-interview-metadata-required",
			});
		}
	});

	test("rejects blank question bodies without requiring interview metadata", () => {
		for (const question of ["", " \t\n", "\u2003"]) {
			const payload = { questions: [{ ...baseQuestion, question }] };
			for (const schema of [askSchema, ordinaryAskSchema]) expect(schema.safeParse(payload).success).toBe(false);
			expect(recoverRoundZeroIntentContract(payload)).toMatchObject({
				outcome: "reject",
				code: "ask-question-body-required",
			});
		}
	});

	test("rejects extra interview questions but preserves ordinary batches and free text", () => {
		const batch = { questions: [topologyQuestion, topologyQuestion] };
		expect(topologyAskSchema.safeParse(batch).success).toBe(false);
		expect(recoverRoundZeroIntentContract(batch, "topology")).toMatchObject({
			outcome: "reject",
			code: "ask-deep-interview-single-question-required",
		});
		expect(
			ordinaryAskSchema.parse({ questions: [baseQuestion, { ...baseQuestion, id: "free", options: [] }] }).questions,
		).toHaveLength(2);
	});

	test("rejects encoded missing metadata and blank siblings before coercion", () => {
		expect(recoverRoundZeroIntentContract({ questions: JSON.stringify([baseQuestion]) }, "topology")).toMatchObject({
			outcome: "reject",
			code: "ask-deep-interview-metadata-required",
		});
		expect(
			recoverRoundZeroIntentContract(
				{ questions: [baseQuestion, { ...baseQuestion, id: "metadata", question: "" }] },
				"topology",
			),
		).toMatchObject({
			outcome: "reject",
			code: "ask-question-body-required",
		});
	});
});

describe("ask option contract", () => {
	test("rejects custom-input pseudo-options", () => {
		for (const label of [
			"Other (type your own)",
			"Type your own",
			"custom input",
			"직접 입력",
			"1. 직접 입력",
			"직접 입력으로 추가",
			"  OTHER（SPECIFY）  ",
			"other…",
			"write your own",
			"enter manually",
			"기타",
			"기타 입력",
		]) {
			const result = ordinaryAskSchema.safeParse({
				questions: [{ ...baseQuestion, options: [{ label }, { label: "Cancel" }], recommended: 0 }],
			});
			expect(result.success, label).toBe(false);
		}
	});

	test("accepts a genuine Other domain value", () => {
		const result = ordinaryAskSchema.safeParse({
			questions: [{ ...baseQuestion, options: [{ label: "Other" }, { label: "Cancel" }] }],
		});
		expect(result.success).toBe(true);
	});

	test("accepts descriptive labels that merely contain custom-input words", () => {
		const result = ordinaryAskSchema.safeParse({
			questions: [{ ...baseQuestion, options: [{ label: "Deploy Other (type your own)" }, { label: "Cancel" }] }],
		});
		expect(result.success).toBe(true);
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
