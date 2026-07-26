import { describe, expect, test } from "bun:test";
import { assignmentRequestsUltragoalRedTeam } from "../../src/task/ultragoal-redteam-activation";

describe("assignmentRequestsUltragoalRedTeam", () => {
	test("is off for empty or ordinary implementation assignments", () => {
		expect(assignmentRequestsUltragoalRedTeam(undefined)).toBe(false);
		expect(assignmentRequestsUltragoalRedTeam("")).toBe(false);
		expect(assignmentRequestsUltragoalRedTeam("   ")).toBe(false);
		expect(assignmentRequestsUltragoalRedTeam("Implement the retry helper and add unit tests.")).toBe(false);
		expect(
			assignmentRequestsUltragoalRedTeam("Fix blocking findings only, then leave verification to the parent."),
		).toBe(false);
	});

	test("does not activate on a bare executorQa token (incidental mention)", () => {
		// #2698: free-form assignment text that merely contains the field name
		// used to flip red-team mode via /executorQa/i.
		expect(assignmentRequestsUltragoalRedTeam("Document the executorQa JSON field names.")).toBe(false);
		expect(
			assignmentRequestsUltragoalRedTeam("Do not invent executorQa rows; the parent owns the quality gate."),
		).toBe(false);
		expect(
			assignmentRequestsUltragoalRedTeam("The quality gate schema includes architectReview and executorQa keys."),
		).toBe(false);
	});

	test("activates on explicit ultragoal completion QA / red-team labeling", () => {
		expect(assignmentRequestsUltragoalRedTeam("You are the Ultragoal completion QA lane. Break the change.")).toBe(
			true,
		);
		expect(assignmentRequestsUltragoalRedTeam("Ultragoal completion red-team: produce the adversarial matrix.")).toBe(
			true,
		);
		expect(assignmentRequestsUltragoalRedTeam("Run ultragoal completion red team against HEAD.")).toBe(true);
	});

	test("activates when assignment asks for executorQa red-team evidence", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Produce executorQa red-team evidence for the frozen change set."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("Fill the executorQa matrix with contractCoverage and adversarialCases."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("Return red-team evidence under the executorQa contract exactly."),
		).toBe(true);
	});

	test("activates on Ultragoal skill spawn phrasing for the QA/red-team lane", () => {
		expect(
			assignmentRequestsUltragoalRedTeam("Delegate an executor QA/red-team lane to build and run the e2e suite."),
		).toBe(true);
		expect(
			assignmentRequestsUltragoalRedTeam("You are the executor red-team lane for this story's live CLI surface."),
		).toBe(true);
	});
});
