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
		expect(suitabilityGate).toContain("gjc state clear --force --mode deep-interview");
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
			"apply the self-proofread once to narrative status text, generated prose cells, gaps, and next-target phrasing",
		);
		expect(skill).toContain("Apply the self-proofread once to newly generated spec prose before persistence");
	});

	it("adds a Final_Checklist item for the silent self-proofread", () => {
		expect(skill).toContain("was silently self-proofread once according to");
	});
});
