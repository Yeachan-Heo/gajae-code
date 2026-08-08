import { describe, expect, it } from "bun:test";
import { appendOrMergeRound, buildAnswerShell } from "../src/gjc-runtime/deep-interview-recorder";
import {
	answerHash,
	assertDeepInterviewInputWithinLimit,
	MAX_USER_RESPONSE_LENGTH,
	questionHash,
} from "../src/gjc-runtime/deep-interview-state";

const COMPOSED_QUESTION = "알림 재시도 정책을 어떻게 잡아야 합니까?";
const COMPOSED_ANSWER = "지수 백오프로 최대 다섯 번 재시도합니다";
const DECOMPOSED_QUESTION = COMPOSED_QUESTION.normalize("NFD");
const DECOMPOSED_ANSWER = COMPOSED_ANSWER.normalize("NFD");

describe("deep-interview Hangul normalization", () => {
	it("keeps the decomposed and composed fixtures distinct as JavaScript strings", () => {
		expect(DECOMPOSED_QUESTION).not.toBe(COMPOSED_QUESTION);
		expect([...DECOMPOSED_ANSWER].length).toBeGreaterThan([...COMPOSED_ANSWER].length);
	});

	it("derives one question identity for canonically equivalent Hangul", () => {
		expect(questionHash(DECOMPOSED_QUESTION)).toBe(questionHash(COMPOSED_QUESTION));
	});

	it("derives one answer identity for selected options and custom input", () => {
		expect(answerHash([DECOMPOSED_ANSWER], undefined)).toBe(answerHash([COMPOSED_ANSWER], undefined));
		expect(answerHash([], DECOMPOSED_ANSWER)).toBe(answerHash([], COMPOSED_ANSWER));
	});

	it("records the same answer once when the two forms arrive for one round", () => {
		const base = {
			interviewId: "iv-1",
			round: 1,
			round_id: "r1",
			questionId: "retry_policy",
			component: "알림",
			dimension: "policy",
			ambiguity: 40,
			selectedOptions: [] as string[],
		};
		const composed = buildAnswerShell(
			{ ...base, questionText: COMPOSED_QUESTION, customInput: COMPOSED_ANSWER },
			"2026-08-05T00:00:00.000Z",
		);
		const decomposed = buildAnswerShell(
			{ ...base, questionText: DECOMPOSED_QUESTION, customInput: DECOMPOSED_ANSWER },
			"2026-08-05T00:00:01.000Z",
		);

		expect(decomposed.custom_input).toBe(COMPOSED_ANSWER);
		expect(decomposed.question_text).toBe(COMPOSED_QUESTION);

		const merged = appendOrMergeRound([composed], decomposed);
		expect(merged.action).toBe("noop");
		expect(merged.rounds).toHaveLength(1);
	});

	it("charges decomposed Hangul the same character budget as composed Hangul", () => {
		const composed = "가".repeat(MAX_USER_RESPONSE_LENGTH);
		expect(() =>
			assertDeepInterviewInputWithinLimit(composed, MAX_USER_RESPONSE_LENGTH, "user_response"),
		).not.toThrow();
		expect(() =>
			assertDeepInterviewInputWithinLimit(composed.normalize("NFD"), MAX_USER_RESPONSE_LENGTH, "user_response"),
		).not.toThrow();
		expect(() =>
			assertDeepInterviewInputWithinLimit(
				`${composed}가`.normalize("NFD"),
				MAX_USER_RESPONSE_LENGTH,
				"user_response",
			),
		).toThrow(`user_response exceeds max length ${MAX_USER_RESPONSE_LENGTH}`);
	});
});
