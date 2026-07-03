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
	/until Critic returns `OKAY`/u,
	/without `OKAY`/u,
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
		for (const pattern of staleCriticApprovalPatterns) {
			expect(content).not.toMatch(pattern);
		}
	});
});
