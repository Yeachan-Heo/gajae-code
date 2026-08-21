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
	/Pre-consensus material-intent reconciliation/u,
	/always before Architect\/Critic/u,
	/--stage intent/u,
	/When material open items exist, use the `ask` tool one at a time/u,
	/When none exist, proceed without an empty ceremony or user prompt/u,
	/they never review the superseded pre-reconciliation draft/u,
	/Review fan-out after Planner persistence/u,
	/launch the Architect and Critic ONCE per run as detached, resumable review lanes/u,
	/Plan-only Critic lane/u,
	/does not consume Architect output/u,
	/Sequential fallback/u,
	/await the Architect result before issuing that Architect-dependent Critic pass/u,
	/Review join gate/u,
	/both Architect and Critic receipts\/verdicts exist for the same Planner artifact\/pass/u,
	/Architect and Critic MAY run in the same parallel batch only for the plan-only Critic lane/u,
	/Typed conflict gate \(#2902\)/u,
	/schema `ralplan\.review_conflicts\.v1`/u,
	/`accept_architect` \| `accept_critic` \| `synthesize` \| `defer_user` \| `reject_both`/u,
	/--stage disposition/u,
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

const persistedRoleAgentsContractPatterns = [
	/### Persisted role agents \(consensus loop\)/u,
	/Architect and Critic are also launched once per run as detached, resumable subagents/u,
	/resume the SAME persisted Architect and Critic lane subagents with the mandatory re-review context bundle instead of fresh-spawning\./u,
	/Resume routing table \(for every persisted role: Planner, Architect, and Critic\)/u,
	/fresh-spawn fallback for that role\/lane on that pass; record the fallback metadata\./u,
	/a resumed Architect or Critic natively retains prior-pass context/u,
	/--architect-id <id> --architect-resumable <true\|false>/u,
	/--critic-id <id> --critic-resumable <true\|false>/u,
] as const;

const stalePersistedRoleAgentsContractPatterns = [
	/### Persisted Planner \(consensus loop\)/u,
	/Architect and Critic are fresh independent spawns each pass/u,
] as const;

const criticReReviewRatchetPatterns = [
	/<re_review_ratchet>/u,
	/Rule 1 \(delta-only\): from pass 2, review only the delta against the prior pass/u,
	/The prior pass is identified by the re-review context bundle \(WI-3\): prior reviewed-plan path, prior same-lane review path, and the explicit run-level pass number supplied in the assignment\./u,
	/Rule 2 \(novelty justification\): a new blocker on previously-reviewed ground requires an explicit "why this was not visible in the prior pass" justification/u,
	/Rule 3 \(verdict monotonicity\): once all blockers from the prior pass are resolved, the verdict must not worsen/u,
	/Rule 4 \(severity discipline\): carryover blockers \(raised in a prior pass, still unresolved\) remain blocking regardless of pass number/u,
	/Rule 5 \(counter-review duty\): from pass 2, Critic also reviews the Architect output \(routed via the context bundle\) for over-engineering and unnecessary scope expansion/u,
	/do NOT convert unjustified Architect demands into ITERATE/u,
	/Enrichment lane \("spec too thin — expand"\) preserved verbatim but justification-gated from pass 2: expansion requests on already-reviewed ground need the rule-2 justification\./u,
] as const;

const architectReReviewRatchetPatterns = [
	/<re_review_ratchet>/u,
	/Rule 1 \(delta-only\): from pass 2, review only the delta against the prior pass/u,
	/Rule 2 \(novelty justification\): a new blocker on previously-reviewed ground requires an explicit "why this was not visible in the prior pass" justification/u,
	/Rule 3 \(verdict monotonicity\): once all blockers from the prior pass are resolved, neither Architectural Status/u,
	/Architectural Status \(`CLEAR`\/`WATCH`\/`BLOCK`\) nor Code Review Recommendation \(`APPROVE`\/`COMMENT`\/`REQUEST CHANGES`\) may worsen/u,
	/Rule 4 \(severity discipline\): carryover CRITICAL or HIGH severity issues \(raised in a prior pass and still unresolved\) remain blocking regardless of pass number/u,
	/Rule 5 \(counter-review awareness\): From pass 2 your output is counter-reviewed by Critic for over-engineering and unnecessary scope expansion/u,
	/On pass 2\+, do not broaden scope, add options, or demand synthesis beyond what resolves prior findings; constructive synthesis \(Stage 3\) stays full-strength on pass 1 only\./u,
	/Never approve carryover CRITICAL or HIGH severity issues \(raised in a prior pass and still unresolved\)\. A fresh CRITICAL\/HIGH minted from pass 2 on previously-approved ground blocks only with an explicit why-not-visible-earlier justification \(rule 2\); without that justification, record it as a non-blocking caveat with its severity noted\. On pass 1 every CRITICAL\/HIGH blocks\./u,
] as const;

const staleArchitectReReviewRatchetPatterns = [/^- Never approve CRITICAL or HIGH severity issues\.$/mu] as const;

const ralplanReReviewContractPatterns = [
	/Pass 2\+ resumes the SAME persisted Architect and Critic lane subagents with the mandatory re-review context bundle and runs sequentially Architect -> Critic/u,
	/Pass 2\+ re-reviews MUST run sequentially Architect -> Critic/u,
	/Critic receives the current-pass Architect receipt\/path and performs the rule-5 counter-review before consolidated feedback routes to Planner revision\./u,
	/\*\*Re-review context bundle \(pass 2\+; mandatory\):\*\*/u,
	/Every pass-2\+ Architect or Critic assignment MUST include:/u,
	/stated literally as `review pass N` in the assignment text/u,
	/ordinal review pass for that lane across the entire ralplan run\/re-review loop/u,
	/the review of the initial Planner artifact is `review pass 1`, the review of the first revised Planner artifact is `review pass 2`/u,
	/N never resets within an opener iteration and never resets when a new `revision` opener begins in the same run/u,
	/the current revision receipt under review \(`path`, `sha256`, `stage_n`\)/u,
	/the prior Planner\/revision artifact path that the previous pass reviewed/u,
	/the prior same-lane review artifact path \(`stage-NN-architect\.md` \/ `stage-NN-critic\.md`\) with its receipt fields/u,
	/the consolidated prior blockers and the revision's claimed resolutions, as orchestrator-collected pointers into those artifacts \(never pasted bodies\)/u,
	/Critic pass-2\+ only: the current-pass Architect receipt\/path, awaited first per the sequential cadence, so the rule-5 counter-review is evaluable\./u,
	/gjc\.ralplan\.maxReviewPassesPerLane/u,
	/Default: \*\*1\*\* Architect pass and \*\*1\*\* Critic pass per opener iteration\./u,
	/Override via `gjc\.ralplan\.maxReviewPassesPerLane` \(integer \*\*1\.\.10\*\*, registered in the public settings schema\) using the workflow-settings precedence above; project overrides user\./u,
	/On overflow: exit code \*\*3\*\* with the \*\*`PLANNING-STUCK`\*\* marker and lane-specific JSON\/stderr detail\./u,
	/`post-interview`, `adr`, and `final` are always allowed\./u,
	/including after a crash between artifact write and ledger append: the identical retry repairs the missing ledger row and returns the dedupe receipt\./u,
	/A new `--run-id` starts a fresh budget\./u,
	/A rule-2-justified blocker routes through a Planner `revision` opener \(new iteration, fresh lane budget\), never a second same-iteration review pass\./u,
	/gjc:\n\s+ralplan:\n\s+maxIterations: 3\n\s+maxReviewPassesPerLane: 2/u,
	/--lane-verdict <token>/u,
	/Architect passes its Architectural Status token \(`CLEAR`\/`WATCH`\/`BLOCK`\), and Critic passes its verdict token \(`OKAY`\/`ITERATE`\/`REJECT`\)/u,
] as const;

const staleRalplanReReviewContractPatterns = [/within the current consensus iteration/u] as const;

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
		for (const pattern of persistedRoleAgentsContractPatterns) {
			expect(content).toMatch(pattern);
		}
		for (const pattern of stalePersistedRoleAgentsContractPatterns) {
			expect(content).not.toMatch(pattern);
		}
		for (const pattern of staleCriticApprovalPatterns) {
			expect(content).not.toMatch(pattern);
		}
	});

	it("enforces re-review ratchet and lane-budget contracts", () => {
		const critic = getBundledAgent("critic");
		if (!critic) throw new Error("missing bundled critic agent");
		for (const pattern of criticReReviewRatchetPatterns) {
			expect(critic.systemPrompt).toMatch(pattern);
		}

		const architect = getBundledAgent("architect");
		if (!architect) throw new Error("missing bundled architect agent");
		for (const pattern of architectReReviewRatchetPatterns) {
			expect(architect.systemPrompt).toMatch(pattern);
		}
		for (const pattern of staleArchitectReReviewRatchetPatterns) {
			expect(architect.systemPrompt).not.toMatch(pattern);
		}

		const ralplan = getDefaultGjcDefinitions().find(
			definition => definition.kind === "skill" && definition.name === "ralplan",
		);
		expect(ralplan).toBeDefined();
		const content = ralplan?.content ?? "";
		for (const pattern of ralplanReReviewContractPatterns) {
			expect(content).toMatch(pattern);
		}
		for (const pattern of staleRalplanReReviewContractPatterns) {
			expect(content).not.toMatch(pattern);
		}
	});
});
