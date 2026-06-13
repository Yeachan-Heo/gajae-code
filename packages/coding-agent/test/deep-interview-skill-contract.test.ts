import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "../src/defaults/gjc/skills/deep-interview/SKILL.md");

const skill = readFileSync(skillPath, "utf8");

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
