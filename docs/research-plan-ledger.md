# Research plan items and evidence ledger

Research/deep-research workflows need a planning contract that is stronger than an execution-order checklist. A plan item should name the claim under investigation, the uncertainty around it, what evidence is required, what counterexamples would falsify it, and how a verifier should handle source conflicts.

This document defines the public product-facing spike for issue #932. It intentionally avoids private operator, session, channel, and routing internals.

## Research plan item schema

```ts
type ResearchPlanConfidence = "low" | "medium" | "high";

type ResearchPlanItem = {
  claim: string;
  confidence: ResearchPlanConfidence;
  unknowns: string[];
  evidenceNeeded: string[];
  counterexampleQueries: string[];
  sourceConflictPolicy: string;
  dropCondition: string;
  verifierChecks: string[];
};
```

Field intent:

- `claim`: The smallest claim that can survive or fail verification.
- `confidence`: Planner's initial confidence before evidence collection.
- `unknowns`: Known gaps the final answer must resolve or explicitly carry forward.
- `evidenceNeeded`: Evidence workers must collect before the claim can be accepted.
- `counterexampleQueries`: Directed search prompts for evidence that would weaken or falsify the claim.
- `sourceConflictPolicy`: How the verifier treats conflicting sources, stale sources, or mismatched methodology.
- `dropCondition`: The explicit condition that removes this claim from the final answer.
- `verifierChecks`: Checklist the verifier applies before accepting the claim.

## Evidence ledger schema

```ts
type ResearchEvidenceVerdict = "support" | "contradict" | "uncertain";

type ResearchEvidenceEntry = {
  claim: string;
  source: string;
  confidence: ResearchPlanConfidence;
  verdict: ResearchEvidenceVerdict;
  notes?: string;
};

type ResearchLedgerVerdict = {
  claim: string;
  finalVerdict: "accepted" | "rejected" | "uncertain";
  survivingSources: ResearchEvidenceEntry[];
  rejectReason?: string;
  unresolvedUnknowns: string[];
};
```

The ledger is claim-centric. Workers add evidence entries against plan-item claims; the verifier reduces those entries into a final verdict. Accepted claims can be cited in the final answer. Rejected claims are named with `rejectReason`. Uncertain claims are either excluded or marked explicitly as unresolved.

## Ralplan/research workflow shape

1. Planner emits `ResearchPlanItem[]` alongside the normal plan narrative when the task is research-heavy.
2. Workers gather independent evidence for each item, including counterexample-oriented searches.
3. Verifier checks contradictions, source quality, stale information, and unresolved uncertainty using the item's `verifierChecks`, `sourceConflictPolicy`, and `dropCondition`.
4. The final answer cites accepted claims, lists rejected claims with reasons, and marks any surviving uncertainty.

## Example

```ts
const item: ResearchPlanItem = {
  claim: "Model X reduces latency by 30% on production-like workloads",
  confidence: "medium",
  unknowns: ["production workload mix"],
  evidenceNeeded: ["benchmark with production-like fixture", "baseline comparison"],
  counterexampleQueries: ["regression on long-context workload", "cold-start latency increase"],
  sourceConflictPolicy: "Reject the claim when any credible counterexample contradicts the benchmark.",
  dropCondition: "Drop if a counterexample contradicts the claim or key unknowns remain unresolved.",
  verifierChecks: ["check source freshness", "compare benchmark harness", "inspect counterexample evidence"],
};
```

If the ledger contains a supporting benchmark and a credible long-context counterexample, the verifier rejects the broad claim instead of letting a plausible summary survive by vibes.

## Current spike

The first implementation spike lives in `packages/coding-agent/src/research-plan/ledger.ts` and provides:

- TypeScript interfaces for research plan items, evidence entries, and final verdicts.
- Validators for product-facing plan/evidence objects.
- A deterministic verifier helper that rejects plausible claims when counterexample/source-conflict/drop-condition evidence applies.
- Regression tests in `packages/coding-agent/test/research-plan-ledger.test.ts`.

Future runtime integration can make `/skill:ralplan` emit these structures as a fenced JSON block or structured sidecar in the persisted ralplan artifact. The spike keeps the schema independent from private session state so it can be exposed in docs and tests safely.
