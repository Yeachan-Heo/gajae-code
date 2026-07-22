import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "../src/defaults/gjc/skills/deep-interview/SKILL.md");

const skill = readFileSync(skillPath, "utf8");

function extractSection(content: string, sectionName: string): string {
	const sectionMatch = content.match(new RegExp(`<${sectionName}>\\n([\\s\\S]*?)\\n</${sectionName}>`));
	const sectionContent = sectionMatch?.[1];
	if (sectionContent === undefined) throw new Error(`missing <${sectionName}> section`);
	return sectionContent;
}

describe("deep-interview skill conflict-aware scoring contract", () => {
	it("documents the ambiguity-raising triggers and established facts", () => {
		expect(skill).toContain("A direct contradiction");
		expect(skill).toContain("B internal inconsistency");
		expect(skill).toContain("C low-quality/evasive");
		expect(skill).toContain("D scope expansion");
		expect(skill).toContain("established_facts");
	});

	it("documents bidirectional scoring mechanism A without a penalty term", () => {
		expect(skill).toMatch(/BIDIRECTIONAL/i);
		expect(skill).toMatch(/NON-MONOTONIC/i);
		expect(skill).toMatch(/mechanism A/i);
		expect(skill).toMatch(/no separate penalty term/i);
	});

	it("requires structured scorer output for conflict transitions", () => {
		expect(skill).toMatch(/Structured scorer output is required/i);
		expect(skill).toContain("affected_dimension");
		expect(skill).toContain("prior_ambiguity");
		expect(skill).toContain("new_ambiguity");
		expect(skill).toContain("contradicted_established_fact");
	});

	it("reports ambiguity direction and validates trigger transitions", () => {
		expect(skill).toContain("{prior_score}% -> {score}% {up|down|flat}");
		expect(skill).toMatch(/TRANSITION VALIDATION/i);
		expect(skill).toMatch(
			/trigger is present, the affected dimension must not improve and overall ambiguity must rise/i,
		);
	});

	it("documents convergence pacing as deferred", () => {
		expect(skill).toMatch(/Convergence Pacing deferral/i);
		expect(skill).toMatch(/min-round floor, score-drop cap, (confidence )?dampening/i);
		expect(skill).toMatch(/Bidirectional scoring is the pacing mechanism/i);
	});
});

describe("deep-interview simple-request escape hatch", () => {
	it("stops before interview state, Round 0, or spec writing when the request is already clear and small", () => {
		const doNotUseWhen = extractSection(skill, "Do_Not_Use_When");
		const steps = extractSection(skill, "Steps");
		const suitabilityGateIndex = steps.indexOf("## Phase 0.5: Suitability Gate");
		const initializeIndex = steps.indexOf("## Phase 1: Initialize");
		const roundZeroIndex = steps.indexOf("## Round 0: Topology Enumeration Gate");
		const executionBridgeIndex = steps.indexOf("## Phase 5: Execution Bridge");

		expect(doNotUseWhen).toMatch(/detailed,\s+specific request[\s\S]*execute directly/i);
		expect(doNotUseWhen).toMatch(/quick fix or single change[\s\S]*direct execution/i);
		expect(suitabilityGateIndex).toBeGreaterThanOrEqual(0);
		expect(suitabilityGateIndex).toBeLessThan(initializeIndex);
		expect(suitabilityGateIndex).toBeLessThan(roundZeroIndex);
		expect(suitabilityGateIndex).toBeLessThan(executionBridgeIndex);

		const suitabilityGate = steps.slice(suitabilityGateIndex, initializeIndex);
		expect(suitabilityGate).toMatch(/clear,\s+bounded,\s+low-risk/i);
		expect(suitabilityGate).toContain("gjc state read --mode deep-interview --json");
		expect(suitabilityGate).toContain("gjc state clear --force --mode deep-interview");
		expect(suitabilityGate).toMatch(/newly seeded empty interview/i);
		expect(suitabilityGate).toMatch(/no recorded `rounds`[\s\S]*no `spec_path`[\s\S]*no `handoff_from`/i);
		expect(suitabilityGate).toMatch(/If state already contains rounds[\s\S]*do not clear it/i);
		expect(suitabilityGate).toMatch(/Preserve the active interview/i);
		expect(suitabilityGate).toMatch(/do not initialize deep-interview state/i);
		expect(suitabilityGate).toMatch(/do not run Round 0/i);
		expect(suitabilityGate).toMatch(/do not write a pending-approval spec/i);
		expect(suitabilityGate).toMatch(/direct implementation/i);
	});
});

describe("deep-interview self-proofread output rule", () => {
	it("adds a silent, best-effort self-proofread rule in Execution_Policy", () => {
		expect(skill).toContain("one silent, best-effort self-proofread in the preserved session language");
		expect(skill).toContain("natural-language prose governed by");
		expect(skill).toContain("Apply it only to newly generated prose and never announce the proofreading");
	});

	it("covers generic error classes without language-specific special cases", () => {
		expect(skill).toContain("obvious spelling, spacing, grammar, inflection/particle, and word-choice errors");
		expect(skill).toContain("rather than special-casing any single language");
	});

	it("separates fixed-literal preservation from generated-prose proofreading", () => {
		expect(skill).toContain(
			"still apply the self-proofread to generated natural-language clauses or cells inside those structures",
		);
		expect(skill).toMatch(/Do not alter code blocks or identifiers/);
	});

	it("references the self-proofread at the four emission points", () => {
		expect(skill).toContain("Before emitting the prose lines in this announcement, apply the");
		expect(skill).toContain("apply the self-proofread once to new prose only");
		expect(skill).toContain(
			"apply the self-proofread once (DIPP-5) to narrative status text, generated prose cells, gaps, and next-target phrasing",
		);
		expect(skill).toContain(
			"Apply the self-proofread once (DIPP-5) to newly generated spec prose before persistence",
		);
	});

	it("adds a Final_Checklist item for the silent self-proofread", () => {
		expect(skill).toContain("was silently self-proofread once according to");
	});
});

describe("deep-interview implementation wording boundary", () => {
	it("treats English and Korean implementation wording as eventual target wording, not execution approval", () => {
		expect(skill).toContain('`implementation`, "implementation plan", Korean `구현`, or "구현 계획"');
		expect(skill).toContain("describing the eventual target, not permission to implement now");
		expect(skill).toContain("do not implement, edit/write code, launch implementation workers");
		expect(skill).toContain("start task/skill/ultragoal implementation");
	});

	it("states the deep-interview implementation boundary and required phase transition", () => {
		expect(skill).toContain(
			"I can interview for an implementation plan, but I won't implement during deep-interview.",
		);
		expect(skill).toContain("continue clarifying scope, risks, acceptance criteria, and unknowns");
		expect(skill).toContain("Implementation requires an explicit phase transition/approval after the interview");
		expect(skill).toContain("workflow phase must explicitly transition out of deep-interview");
		expect(skill).toContain("execution approval must be captured by a downstream execution path");
	});
});

describe("deep-interview ask clarification contract", () => {
	it("treats clarificationQuestion as a non-answer and re-asks without scoring", () => {
		expect(skill).toContain("clarificationQuestion");
		expect(skill).toContain("treat it as a non-answer about the displayed choices");
		expect(skill).toContain(
			"call `ask` again with the exact original question, options, and `deepInterview.*` metadata",
		);
		expect(skill).toContain("bypasses Step 2b′ auto-answer, Step 2b″ free-text refine, Step 2c ambiguity scoring");
		expect(skill).toContain("must not be recorded as a round answer");
	});
});

describe("deep-interview ouroboros ooo-interview parity port", () => {
	it("documents the tiered confirmation cadence while keeping the hard cap (feature B)", () => {
		expect(skill).toMatch(/Tiered Confirmation Cadence/i);
		expect(skill).toMatch(/Rounds 1-3 \(auto-continue\)/i);
		expect(skill).toMatch(/Rounds 4-15 \(ask to continue\)/i);
		expect(skill).toMatch(/Rounds 16\+ \(diminishing-returns warning\)/i);
		expect(skill).toMatch(/never removes this hard safety cap/i);
		expect(skill).toContain("Round 100");
	});

	it("documents advisory fanout lanes distinct from the milestone panel (feature C)", () => {
		expect(skill).toMatch(/advisory fanout/i);
		expect(skill).toMatch(/distinct from the milestone panel/i);
		for (const lane of [
			"code_context",
			"web_context",
			"ambiguity_contrarian",
			"answer_simplifier",
			"architecture_implications",
		])
			expect(skill).toContain(lane);
	});

	it("documents the confused_terms/references non-behavioral contract (feature A)", () => {
		expect(skill).toContain("confused_terms");
		expect(skill).toContain("references");
		expect(skill).toMatch(/MUST NOT alter the first question/i);
		expect(skill).toMatch(/never auto-fetched/i);
	});

	it("documents the FREETEXT_FIELDS allowlist + input size caps (feature D)", () => {
		expect(skill).toContain("FREETEXT_FIELDS");
		expect(skill).toMatch(/shell metacharacters/i);
		expect(skill).toMatch(/50,000/);
		expect(skill).toMatch(/10,000/);
		expect(skill).toMatch(/character-count/i);
	});
});
