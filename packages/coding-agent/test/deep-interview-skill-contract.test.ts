import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "../src/defaults/gjc/skills/deep-interview/SKILL.md");
const statePath = join(dirname(fileURLToPath(import.meta.url)), "../src/gjc-runtime/deep-interview-state.ts");

const repairCliPath = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/deep-interview-repair-cli.md");
const skill = readFileSync(skillPath, "utf8");
const stateSource = readFileSync(statePath, "utf8");
const repairCli = readFileSync(repairCliPath, "utf8");

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

	it("keeps ambiguity derived by the native runtime", () => {
		expect(skill).toMatch(/Structured scorer output is required/i);
		expect(skill).toContain("affected_dimension");
		expect(skill).toContain("prior_dimension_score");
		expect(skill).toContain("new_dimension_score");
		expect(skill).toContain("Do not include prior/new ambiguity");
		expect(skill).not.toContain("prior_ambiguity");
		expect(skill).not.toContain("new_ambiguity");
		expect(skill).toContain("runtime validates and returns the authoritative ambiguity transition");
		expect(skill).toContain("{<native>.native_projection.effective_ambiguity}");
	});
	it("renders progress exclusively from version 1 native projection paths", () => {
		const steps = extractSection(skill, "Steps");
		const applyIndex = steps.indexOf("### Step 2d: Apply Round Result and Report Progress");
		const applyCommandIndex = steps.indexOf("gjc deep-interview apply-round-result", applyIndex);
		const reportEndIndex = steps.indexOf("### Step 2e: Check Soft Limits", applyCommandIndex);
		const report = steps.slice(applyCommandIndex, reportEndIndex);
		const projectionStart = stateSource.indexOf("export interface DeepInterviewRoundResultProjection");
		const projectionEnd = stateSource.indexOf("\n}", projectionStart);
		const projectionContract = stateSource.slice(projectionStart, projectionEnd);

		expect(applyIndex).toBeGreaterThanOrEqual(0);
		expect(applyCommandIndex).toBeGreaterThan(applyIndex);
		expect(report).toContain("consume `<native>.native_projection` as the version 1 native projection");
		for (const path of [
			"prior_effective_ambiguity",
			"effective_ambiguity",
			"direction",
			"floor",
			"ambiguity_milestone",
			"targeting.target_component_id",
			"targeting.target_dimension",
			"topology_counts.active",
			"topology_counts.deferred",
			"topology_counts.total",
			"ontology_counts.stable",
			"ontology_counts.changed",
			"ontology_counts.new",
			"transition.auto_answer_streak",
			"transition.lifecycle",
			"transition.round_key",
		]) {
			expect(report).toContain(`<native>.native_projection.${path}`);
			expect(projectionContract).toContain(`${path.split(".").at(-1)}:`);
		}
		for (const unavailable of [
			"target_component_name",
			"trigger_summary",
			"dominant_floor_cause",
			"entity_count",
			"stability_ratio",
			"prior_milestone",
			"milestone_transition",
			"weakest_dimension",
			"weakest_dimension_rationale",
			"threshold",
		])
			expect(report).not.toContain(`native.${unavailable}`);
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
describe("deep-interview CLI-owned draft contract", () => {
	it("uses drafts for all normal-flow payloads and preserves recorder-first answers", () => {
		const steps = extractSection(skill, "Steps");
		for (const kind of ["initialize-context", "confirm-topology", "record-answer", "apply-round-result"]) {
			expect(steps).toContain(`--for ${kind}`);
			expect(steps).toContain(`${kind} --draft-id <draft_id>`);
		}
		expect(steps).not.toContain("draft create --kind");
		for (const forbidden of ["--input-json", "--question-json", "--answer-json", "--result-json"]) {
			expect(steps).not.toContain(forbidden);
		}
		expect(steps).toContain("Recorder-first remains mandatory");
		expect(steps).toContain("draft check --draft-id <draft_id>");
		expect(steps).toContain("--expected-draft-revision <draft_revision>");
		expect(steps).toContain("--value");
		expect(steps).toContain("--null");
		expect(steps).toContain("--op append");
		expect(steps).toContain("draft_revision");
	});
	it("documents public flag grammar and valueless append behavior without permitting raw JSON", () => {
		const steps = extractSection(skill, "Steps");
		const toolUsage = extractSection(skill, "Tool_Usage");

		expect(repairCli).toContain(
			"Value-taking flags use exactly `--name value`; `--json` and `--null` are standalone flags and take no value.",
		);
		expect(repairCli).toContain(
			"A valueless `append` on a missing object-item array appends an `{}` scaffold; on a missing scalar-item array it initializes `[]`.",
		);
		expect(repairCli).toContain(
			"An existing scalar-item array still requires `--value` or `--value-file` for `append`.",
		);
		expect(repairCli).toContain("--op append --path /deferred_components --json");
		expect(toolUsage).toContain(
			"value-taking flags use exactly `--name value`, while `--json` and `--null` take no value",
		);
		expect(steps).toContain("valueless append on a missing scalar-item array initializes `[]`");
		expect(steps).toContain("--op append --path /deferred_components --json");
		expect(toolUsage).toContain("Never construct a full payload");
	});

	it("documents CAS-protected private draft consumption", () => {
		const toolUsage = extractSection(skill, "Tool_Usage");
		const normalFlowDocs = repairCli.slice(0, repairCli.indexOf("## Legacy compatibility:"));
		const typedConsumeExamples = [
			...(skill.match(
				/^gjc deep-interview (?:initialize-context|confirm-topology|record-answer|apply-round-result) --draft-id [^\n]+$/gm,
			) ?? []),
			...(repairCli.match(
				/^gjc deep-interview (?:initialize-context|confirm-topology|record-answer|apply-round-result) --draft-id [^\n]+$/gm,
			) ?? []),
		];

		expect(toolUsage).toContain("draft create|edit|show|check|rebase|discard");
		expect(toolUsage).toContain("there is no public `draft consume` command");
		expect(skill).not.toMatch(/\bgjc deep-interview draft consume\b/);
		expect(normalFlowDocs).not.toMatch(
			/\bgjc deep-interview draft consume\b|--input-json|--question-json|--answer-json|--result-json/,
		);
		expect(typedConsumeExamples).toHaveLength(8);
		expect(normalFlowDocs).toContain("--draft-id ID --expected-draft-revision <latest_draft_revision> --json");
		for (const example of typedConsumeExamples) {
			expect(example).toContain("--expected-draft-revision <latest_draft_revision>");
			expect(example).toContain("--json");
		}

		for (const command of ["create", "edit", "show", "check", "rebase", "discard"]) {
			expect(normalFlowDocs).toMatch(new RegExp(`draft ${command}[^\\n]*--json`));
		}
		expect(normalFlowDocs).toContain(
			"draft rebase  --draft-id ID --expected-draft-revision N --to-state-revision N --json",
		);
		expect(normalFlowDocs).toContain("draft discard --draft-id ID --expected-draft-revision N --json");
		expect(normalFlowDocs).toContain("without consuming or mutating it; it reports when the draft base is stale");
		expect(normalFlowDocs).toContain("caller-observed current state revision as `--to-state-revision`");
		expect(toolUsage).toContain("Inline JSON request flags are compatibility-only");
		expect(toolUsage).toContain("Never construct a full payload");
	});
});
