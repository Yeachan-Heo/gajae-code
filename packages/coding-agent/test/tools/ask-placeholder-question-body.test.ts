/**
 * Regression coverage for gajae-code#5002: a deep-interview `ask` whose question
 * body is a placeholder token ("unused", "TODO", "", "  ") was accepted by the
 * contract and rendered to the user as the entire question, with a fully
 * numbered option list. Field report: the ask showed the word `unused`.
 */

import { describe, expect, it } from "bun:test";
import { recoverRoundZeroIntentContract } from "@gajae-code/coding-agent/tools/ask-contract";

function validate(question: string) {
	return recoverRoundZeroIntentContract({
		questions: [
			{
				id: "q1",
				question,
				options: [{ label: "JWT" }, { label: "OAuth2" }, { label: "Session cookies" }],
				deepInterview: { round: 3, component: "Auth", dimension: "Mechanism", ambiguity: 0.4 },
			},
		],
	});
}

describe("deep-interview ask question bodies", () => {
	it("rejects placeholder and empty bodies with a named correction code", () => {
		for (const body of ["unused", "TODO", "tbd", "n/a", "N/A", "none", "placeholder", "empty", "stub", "", "   "]) {
			const result = validate(body) as { outcome: string; code?: string };
			expect(result.outcome).toBe("reject");
			expect(result.code).toBe("ask-deep-interview-question-body-required");
		}
	});

	it("leaves a substantive question body alone", () => {
		const result = validate("Which auth mechanism should the service use?") as { outcome: string; code?: string };
		expect(result.code).not.toBe("ask-deep-interview-question-body-required");
	});
});
