import { describe, expect, it } from "bun:test";
import { getDefaultGjcDefinitions } from "@gajae-code/coding-agent/defaults/gjc-defaults";
import { getBundledAgent } from "@gajae-code/coding-agent/task/agents";

const rolePromptSectionContracts = [
	{
		name: "planner",
		requiredSections: ["Intent Diff", "Decision Drivers", "Options", "Escalation/Risk Gate", "Verification Plan"],
	},
	{
		name: "architect",
		requiredSections: ["Claims", "Root Cause", "Tradeoffs", "Recommendations"],
	},
	{
		name: "critic",
		requiredSections: ["Verdict", "Claim Checks", "Missing Evidence", "Approval Boundary", "Required Changes"],
	},
] as const;

const finalPlanContractPatterns = [
	/\*\*## Intent Reconciliation\*\*/u,
	/Final plan must include ADR \(Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups\)/u,
	/workflowGate: \{ stage: "ralplan", kind: "approval" \}/u,
	/mark the plan `pending approval`/u,
] as const;

const criticApprovalContractPatterns = [
	/Any non-`OKAY` Critic verdict \(`ITERATE` or `REJECT`\)/u,
	/until Critic returns `OKAY` \*\*and\*\* Architect is `CLEAR`\/`APPROVE`/u,
	/without Critic `OKAY` plus Architect `CLEAR`\/`APPROVE`/u,
	/After the review join gate has both Critic `OKAY` and Architect `CLEAR`\/`APPROVE`/u,
	/re-check the review join gate \(Critic `OKAY` plus Architect `CLEAR`\/`APPROVE`/u,
] as const;

const ralplanReviewPipelineContractPatterns = [
	/Review fan-out after Planner persistence/u,
	/launch fresh Architect and Critic review lanes against the same immutable Planner receipt\/path\/sha\/stage_n/u,
	/Plan-only Critic lane/u,
	/does not consume Architect output/u,
	/Sequential fallback/u,
	/await the Architect result before issuing that Architect-dependent Critic pass/u,
	/Review join gate/u,
	/both Architect and Critic receipts\/verdicts exist for the same Planner artifact\/pass/u,
	/Architect and Critic MAY run in the same parallel batch only for the plan-only Critic lane/u,
] as const;

const staleReviewPipelineContractPatterns = [
	/Steps 3 and 4 MUST run sequentially/u,
	/Do NOT issue both agent Task calls in the same parallel batch/u,
	/Always await the Architect result before issuing the Critic Task/u,
	/After Critic returns `OKAY`/u,
] as const;

const staleCriticApprovalPatterns = [
	/non-`APPROVE` Critic verdict/u,
	/Critic returns `APPROVE`/u,
	/without `APPROVE`/u,
] as const;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionMarkerPattern(section: string): RegExp {
	return new RegExp(`(^|\\n)(?:#{1,6}\\s+|[-*]\\s+)${escapeRegExp(section)}(?:\\s|$)`, "u");
}

describe("ralplan decision artifacts", () => {
	it("requires decision artifact sections in bundled role prompts and final handoff", () => {
		for (const contract of rolePromptSectionContracts) {
			const agent = getBundledAgent(contract.name);
			if (!agent) throw new Error(`missing bundled ${contract.name} agent`);
			for (const requiredSection of contract.requiredSections) {
				expect(agent.systemPrompt).toMatch(sectionMarkerPattern(requiredSection));
			}
		}

		const ralplan = getDefaultGjcDefinitions().find(
			definition => definition.kind === "skill" && definition.name === "ralplan",
		);
		expect(ralplan).toBeDefined();
		const content = ralplan?.content ?? "";

		for (const pattern of finalPlanContractPatterns) {
			expect(content).toMatch(pattern);
		}

		for (const pattern of criticApprovalContractPatterns) {
			expect(content).toMatch(pattern);
		}

		for (const pattern of ralplanReviewPipelineContractPatterns) {
			expect(content).toMatch(pattern);
		}
		for (const pattern of staleReviewPipelineContractPatterns) {
			expect(content).not.toMatch(pattern);
		}
		for (const pattern of staleCriticApprovalPatterns) {
			expect(content).not.toMatch(pattern);
		}
	});
});
