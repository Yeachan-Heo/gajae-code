import { describe, expect, it } from "bun:test";
import { detectDeepInterviewPlaintextAskLeak } from "@gajae-code/coding-agent/deep-interview/plaintext-gate-guard";

describe("detectDeepInterviewPlaintextAskLeak", () => {
	it("detects Korean/English screenshot-like Restate gate plaintext with canonical options", () => {
		const text = `Deep Interview progress · Round 2
Restate gate / 확인: If someone read only this line, would they know the desired outcome?
요청을 이렇게 정리해도 맞습니까?

Options:
- Yes, crystallize
- Adjust wording
- Missing scope`;

		const result = detectDeepInterviewPlaintextAskLeak(text);

		expect(result).toMatchObject({
			kind: "deep_interview_plaintext_ask_leak",
			signals: {
				optionsHeading: true,
				restateIntent: true,
				deepInterviewContext: true,
			},
		});
		expect(result?.matchedOptions).toEqual(["Yes, crystallize", "Adjust wording", "Missing scope"]);
	});

	it("detects paraphrased localized confirmation intent without relying on the exact English restate sentence", () => {
		const text = `심층 인터뷰 확인 단계
아래 한 줄로 목표와 범위가 맞는지 확정하기 전에 확인합니다.

Options:
1. Yes, crystallize
2. Adjust wording
3. Missing scope`;

		const result = detectDeepInterviewPlaintextAskLeak(text);

		expect(result?.kind).toBe("deep_interview_plaintext_ask_leak");
		expect(text.includes("If someone read only this line")).toBe(false);
		expect(result?.matchedOptions).toEqual(["Yes, crystallize", "Adjust wording", "Missing scope"]);
	});

	it("detects Final confirmation Restate gate plaintext with canonical options", () => {
		const text = `## Final confirmation
Restate gate
If this one-line import decision is all someone reads, confirm it captures the intended scope.
Options:
1. Yes, crystallize
2. Adjust wording
3. Missing scope`;

		const result = detectDeepInterviewPlaintextAskLeak(text);

		expect(result?.kind).toBe("deep_interview_plaintext_ask_leak");
		expect(result?.matchedOptions).toEqual(["Yes, crystallize", "Adjust wording", "Missing scope"]);
	});

	it("does not flag normal progress reports", () => {
		const text = `Deep Interview progress: round 2 completed. Next I will ask one confirmation question through the gate.`;

		expect(detectDeepInterviewPlaintextAskLeak(text)).toBeNull();
	});

	it("does not flag final specs or interview transcripts even when they quote Options", () => {
		const text = `# Final Deep Interview Transcript

Assistant asked a restate confirmation gate.
Options:
- Yes, crystallize
- Adjust wording
- Missing scope

Selected: Yes, crystallize`;

		expect(detectDeepInterviewPlaintextAskLeak(text)).toBeNull();
	});

	it("does not flag ordinary CLI or documentation help containing an Options section", () => {
		const text = `Usage: gjc deep-interview [prompt]

Options:
  --help     Show help.
  --model    Select model.

Examples mention Adjust wording as prose, not a restate gate.`;

		expect(detectDeepInterviewPlaintextAskLeak(text)).toBeNull();
	});

	it("does not flag normal ask-tool render-like option lists", () => {
		const text = `Question: Which action should the tool send to the user?
Options:
[ ] Run tests
[ ] Adjust wording
[ ] Missing scope`;

		expect(detectDeepInterviewPlaintextAskLeak(text)).toBeNull();
	});

	it("does not flag empty or whitespace-only input", () => {
		expect(detectDeepInterviewPlaintextAskLeak("")).toBeNull();
		expect(detectDeepInterviewPlaintextAskLeak(" \t\n ")).toBeNull();
	});

	it("treats the Options heading and canonical labels case-insensitively", () => {
		const text = `deep interview confirmation: does this capture the intended scope?

oPtIoNs:
- YES, CRYSTALLIZE
- adjust wording`;

		const result = detectDeepInterviewPlaintextAskLeak(text);

		expect(result?.matchedOptions).toEqual(["Yes, crystallize", "Adjust wording"]);
	});
});
