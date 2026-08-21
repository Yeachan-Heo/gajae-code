---
name: ralplan
description: Consensus planning entrypoint that auto-gates vague ultragoal requests before execution
argument-hint: "[--interactive] [--deliberate] [--architect openai-code] [--critic openai-code] <task description>"
level: 4

source: "forked from upstream ralplan skill and rebranded for GJC"
---

# Ralplan (Consensus Planning Alias)

Ralplan is the consensus planning workflow. It triggers iterative planning with Planner, Architect, and Critic agents until consensus is reached, with **RALPLAN-DR structured deliberation** (short mode by default, deliberate mode for high-risk work).

## Usage

```
/skill:ralplan "task description"
```

## Flags

- `--interactive`: Adds draft-review prompts and one-at-a-time reconciliation. When the final receipt resolves `auto_handoff.effectiveTarget` to `off` without `degradationReason: "planning_stuck"`, final approval uses an `ask` workflow gate; a configured automatic admission is handled by step 8.
- `--deliberate`: Forces high-risk deliberation: pre-mortem plus expanded test planning. It may also auto-enable for explicit auth/security, migration, destructive, incident, compliance/PII, or public-API-breakage risk.
- `--architect openai-code` / `--critic openai-code`: Use OpenAI code for that review pass when available; otherwise note the fallback and use default GJC review.
- `gjc.ralplan.autoHandoff`: Selects final-plan admission: `off` (default), `ultragoal`, or `autoresearch`. An `autoresearch` target admits `/skill:autoresearch` to continue research from the approved plan rather than implement it; it needs no availability probe. `PLANNING-STUCK` also resolves every target to `off`. Invalid settings reject the final write before any final artifact is persisted. The final receipt's ledger-backed runtime-owned `auto_handoff.effectiveTarget` is authoritative across state loss and run switching.
- `--write --stage <type> --stage_n <N> --artifact <markdown file path or markdown string>`: Native writer for Planner/Architect/Critic/revision/ADR/final pending-approval markdown under `.gjc/_session-{sessionid}/plans/ralplan/<run-id>/`; do not edit `.gjc/` directly.

## Corrupt current-session state recovery

For corrupt, tampered, unreadable, or stale current-session ralplan state, run `gjc state clear --force --mode ralplan` scoped by `--session-id`, command payload, or `GJC_SESSION_ID`; it clears only ralplan state for that session.

## Behavior

## Planning/Execution Boundary

Ralplan is planning only. It may inspect context and draft plan/spec/proposal artifacts, but those remain `pending approval` until explicit current-turn or structured-UI execution approval, or a valid non-off final receipt's runtime-owned `auto_handoff.effectiveTarget` admits the existing handoff chain. Before either admission, do not mutate product source, run mutation-oriented shell, commit, push, open PRs, invoke execution skills, or delegate implementation.

Except for a terminal `planning_stuck` final receipt, explicitly naming `ultragoal` (including `/skill:` and `gjc` forms) counts as opting into execution for that skill — do not re-ask for the same consent.

Persist planning artifacts and handoffs through the ralplan CLI writer, never direct `.gjc/` edits:
Direct `write`, `edit`, or `ast_edit` calls against `.gjc/_session-{sessionid}/specs`, `.gjc/_session-{sessionid}/plans`, `.gjc/_session-{sessionid}/state`, or any other `.gjc/` path are forbidden unless an explicit force override is active.

```bash
gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --session-id <owner-session-id> --run-id <run-id> --stage <type> --stage_n <N> --artifact "markdown file path or markdown string"
# restricted role agents use:
gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --session-id <owner-session-id> --run-id <run-id> --stage <type> --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT
```

Use stages `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr`, or `final`; increment `--stage_n` each consensus pass. The writer accepts inline markdown (or JSON for `disposition`), an artifact path prepared outside `.gjc/`, or `--artifact-env GJC_RALPLAN_ARTIFACT`, persists `stage-<NN>-<stage>.md` plus `index.jsonl` under `.gjc/_session-{sessionid}/plans/ralplan/<run-id>/`, and copies `final` to `pending-approval.md`. Ralplan mutation blocking is enforced in code; use temp directories (`os.tmpdir()`/`$TMPDIR`, `/tmp`, `/var/tmp`) only for oversized scratch artifacts, never the repo or `.gjc/`. Staging via the `write` tool or a quoted-delimiter bash heredoc (`cat > /tmp/plan.md <<'EOF' … EOF`) into those temp roots is tolerated by the planning-phase guard.

Restricted read-only role agents (`planner`, `architect`, `critic`) must pass markdown through `GJC_RALPLAN_ARTIFACT` with `--artifact-env GJC_RALPLAN_ARTIFACT`; their restricted bash environment disables artifact file-path ingestion.

RECEIPT-ONLY guideline: role agents (`planner`, `architect`, and `critic`) persist durable outputs via `gjc ralplan --write` and return ONLY the receipt fields (`session_id`, `run_id`, `path`, `sha256`) plus verdict/status routing fields; include `stage` and `stage_n` when available, and never return the full persisted body.

The ralplan seed/write receipt's `session_id` is the immutable workflow owner session and `run_id` is the run identity. Include both in every Planner/Architect/Critic assignment and every parent-side revision/post-interview/ADR/final write. A role subagent's own session id is transcript/resume identity only and MUST NOT own ralplan state or artifacts.
The seed/write receipt's `repository_binding.worktreeRoot` is the canonical artifact root for the run. Whenever a writer's cwd can differ from that root — a dispatcher directory, a linked branch worktree, or a role subagent runtime cwd — propagate the seed receipt's `repository_binding.worktreeRoot` as `--worktree-root <repository_binding.worktreeRoot>` on every `gjc ralplan` seed/write (Planner, Architect, Critic, revision, disposition, post-interview, ADR, and final). Explicit-target mode routes all run state, stage artifacts, `index.jsonl`, HUD state, stuck markers, and review-budget accounting to that exact worktree regardless of the writer's cwd; it fails before any write when the target is missing, not a directory, not a git worktree root, when no seeded run state exists there, or when the target is not exactly the run's bound `worktreeRoot` (a linked worktree that merely shares `commonDir` is rejected). A relative `--artifact` file is still resolved from the invoking cwd. Without `--worktree-root`, legacy cwd-based behavior is unchanged. Never scan the filesystem for runs or merge artifact trees by hand.

This skill runs GJC planning in consensus mode for the provided arguments.

The consensus workflow:
1. **Planner** creates the initial plan and a compact **RALPLAN-DR summary** before review. Launch the Planner ONCE per run as a detached, resumable subagent (await it before the Architect) and record its returned subagent id as the run's persisted Planner id; persist the stage with `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage planner --stage_n 1 --artifact-env GJC_RALPLAN_ARTIFACT --planner-id <id> --planner-resumable <true|false>` (see **Persisted role agents** below):
   - After persistence, return only the receipt/path plus compact planning status; do not paste the full plan markdown back to the caller unless explicitly requested.
   - Principles (3-5)
   - Decision Drivers (top 3)
   - Viable Options (>=2) with bounded pros/cons
   - If only one viable option remains, explicit invalidation rationale for alternatives
   - Deliberate mode only: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)
2. **Pre-consensus material-intent reconciliation** *(always before Architect/Critic)*: Reconcile material scope and intent before paying for consensus review. This is a bounded contract check, not a second planning loop.
   a. Read the persisted Planner artifact plus relevant `.gjc/_session-{sessionid}/specs/deep-interview-*.md`, prior plans, and current user constraints. Extract only material unresolved decisions, assumptions that could change architecture/scope/acceptance criteria, and conflicts with an explicit prior non-goal. Cosmetic wording and implementation details that do not alter the contract are not material.
   b. When material open items exist, use the `ask` tool one at a time, highest-impact first, with concrete options. When none exist, proceed without an empty ceremony or user prompt.
   c. Persist the check with `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage intent --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`. The artifact must list evidence inspected, resolved material decisions, retained non-goals, and either `material-open-items: none` or the still-open items.
   d. If reconciliation changes objective, scope, non-goals, acceptance criteria, or verification obligations, resume the persisted Planner and persist a `revision` before review. Architect and Critic receive the reconciled Planner/revision receipt plus the `intent` receipt; they never review the superseded pre-reconciliation draft.
   e. With `--interactive`, also present the reconciled draft plus Principles / Drivers / Options summary (Proceed to review / Request changes / Skip review). Without `--interactive`, proceed automatically once material intent is resolved.
3. **Review fan-out after Planner persistence**: launch the Architect and Critic ONCE per run as detached, resumable review lanes against the same immutable Planner receipt/path/sha/stage_n. Their pass-1 fan-out remains parallel when Critic is **plan-only** and does not consume Architect output (see **Persisted role agents** below).
   - **Architect lane**: challenge architecture, surface tradeoff tensions, and enrich thin plans with synthesis or missed sub-scope. Persist with `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage architect --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --architect-id <id> --architect-resumable <true|false> --lane-verdict <token> --json`, then return receipt/path plus `CLEAR`/`WATCH`/`BLOCK` and `APPROVE`/`COMMENT`/`REQUEST CHANGES`.
   - **Plan-only Critic lane**: independently check quality, principle-option consistency, alternatives, risks, acceptance criteria, and verification; when the plan is thin, request concrete expansion rather than only defects. Persist with `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage critic --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --critic-id <id> --critic-resumable <true|false> --lane-verdict <token> --json`, then return receipt/path plus `OKAY`/`ITERATE`/`REJECT`.
   - **Sequential fallback**: if Critic must evaluate Architect findings, verdict, antithesis, tradeoffs, synthesis, status, or any Architect-produced artifact, await the Architect result before issuing that Architect-dependent Critic pass.
   - Every Architect/Critic assignment, including each pass-2+ re-review assignment in step 5, MUST instruct the reviewer to include `--lane-verdict <token>` on its existing `gjc ralplan --write`: Architect passes its Architectural Status token (`CLEAR`/`WATCH`/`BLOCK`), and Critic passes its verdict token (`OKAY`/`ITERATE`/`REJECT`). The flag is optional so legacy invocations stay valid.
4. **Review join gate**: before consensus, revision, reconciliation, finalization, or approval, verify both Architect and Critic receipts/verdicts exist for the same Planner artifact/pass (`path`, `sha256`, `stage_n`). A non-`CLEAR` Architect verdict, non-`APPROVE` Architect decision, or any non-`OKAY` Critic verdict routes back to Planner revision; do not finalize from only one review lane.
   - **Typed conflict gate (#2902)**: when Architect and Critic findings prescribe incompatible actions (`add` vs `remove`, or `remove` vs `change`) against the same stable plan target id, do **not** treat the join as clean and do **not** start revision until a `disposition` stage is persisted for that pass. Collect typed findings (stable `findingId`, `targetId`, `action`, `severity`, `evidence`, `sourceRole`, source receipt) from both review artifacts, derive conflicts, and require one explicit disposition per conflict (`accept_architect` | `accept_critic` | `synthesize` | `defer_user` | `reject_both`) with `rationale`, `decisionOwner`, and `affectedSections`. Persist via `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage disposition --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json` using schema `ralplan.review_conflicts.v1`. Source receipts must be authoritative same-pass attestations: `plannerStageN` equals CLI `--stage_n`, each finding's `sourceReceipt.stage` equals `sourceRole`, `sourceReceipt.stageN` equals `plannerStageN`, and path/sha256 resolve against the run's persisted Architect/Critic `index.jsonl` rows. The writer fails closed if any conflict remains open, a disposition references an unknown conflict, or provenance is mismatched/spoofed. Product intent/scope remains owned by the user + approval gate; the ralplan leader owns reconciliation; reviewers advise and block.
5. **Re-review loop** (max 5 iterations; **runtime-enforced**): Any non-`OKAY` Critic verdict (`ITERATE` or `REJECT`) or Architect result that is not `CLEAR`/`APPROVE` MUST run the same full closed loop. Pass 2+ resumes the SAME persisted Architect and Critic lane subagents with the mandatory re-review context bundle and runs sequentially Architect -> Critic: await the Architect result and its receipt/path before assigning Critic; Critic receives the current-pass Architect receipt/path and performs the rule-5 counter-review before consolidated feedback routes to Planner revision. From pass 2, both reviewers are bound by the five-rule ratchet: delta-only review, novelty justification, verdict monotonicity, severity scoping, and Critic counter-review of Architect scope inflation; unjustified inflation does not force a revision.
   a. Collect Architect + Critic feedback
   b. When typed conflicts exist, persist dispositions (step 4 typed conflict gate) before revision so the Planner receives a machine-checkable conflict set, not prose alone
   c. Revise the plan by resuming the SAME persisted Planner subagent with consolidated Architect + Critic feedback **and** any disposition receipts (see **Persisted role agents** below); fall back to a fresh Planner spawn only per the fallback routing table

   **Re-review context bundle (pass 2+; mandatory):** Every pass-2+ Architect or Critic assignment MUST include:
   1. the explicit review pass number `N` for that lane, stated literally as `review pass N` in the assignment text, where **N is the ordinal review pass for that lane across the entire ralplan run/re-review loop** (equivalently the opener-iteration ordinal): the review of the initial Planner artifact is `review pass 1`, the review of the first revised Planner artifact is `review pass 2`, and so on; **N never resets within an opener iteration and never resets when a new `revision` opener begins in the same run** — it increments monotonically with every review the lane performs in the run. This ordinal is a workflow counter distinct from the runtime lane budget (which counts lane writes per opener iteration, WI-5): at the default budget the two coincide numerically, but the ratchet ("from pass 2") always keys off the run-level N so normal post-revision re-reviews activate delta-only review, monotonicity, and the sequential cadence;
   2. the current revision receipt under review (`path`, `sha256`, `stage_n`);
   3. the prior Planner/revision artifact path that the previous pass reviewed;
   4. the prior same-lane review artifact path (`stage-NN-architect.md` / `stage-NN-critic.md`) with its receipt fields;
   5. the consolidated prior blockers and the revision's claimed resolutions, as orchestrator-collected pointers into those artifacts (never pasted bodies);
   6. Critic pass-2+ only: the current-pass Architect receipt/path, awaited first per the sequential cadence, so the rule-5 counter-review is evaluable.

   **The re-review context bundle remains mandatory regardless of whether a reviewer is resumed or uses a fresh-spawn fallback.** A fresh-spawn fallback always receives everything required to apply delta-only review (rule 1), novelty justification (rule 2), monotonicity (rule 3), severity scoping (rule 4), and counter-review (rule 5).
   d. For pass 2+, resume (or fresh-spawn only per the routing table) Architect -> Critic sequentially: await the Architect result and receipt/path, then issue Critic with the mandatory context bundle, including the current-pass Architect receipt/path. Critic performs the rule-5 counter-review before consolidated feedback routes to Planner revision.
      - Persist each Planner revision with `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage revision --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json` before re-review, then pass the receipt/path forward instead of duplicating the full revision markdown in the parent conversation.
   e. Re-join Architect and Critic verdicts for the same revised Planner artifact/pass (including a fresh disposition stage if new conflicts appear)
   f. Repeat this loop until Critic returns `OKAY` **and** Architect is `CLEAR`/`APPROVE` for the same Planner artifact/pass, or 5 iterations are reached
   g. If 5 iterations are reached without Critic `OKAY` plus Architect `CLEAR`/`APPROVE`, **stop opening further planner/revision passes**. Preserve the best version as a terminal `PLANNING-STUCK` result; do not route it to automatic or explicit execution.
   h. **Runtime budget (#3165):** native `gjc ralplan --write` refuses a new `planner`/`revision` that would open consensus iteration **> max** (default **5**, overridable via `gjc.ralplan.maxIterations`, integer 1..20, using the workflow-settings precedence below). Cap uses the same iteration definition as the HUD (`planner`/`revision` openers in `index.jsonl`). Overflow exits **3**, prints operator-visible **`PLANNING-STUCK`** on stdout (and stderr detail; JSON includes `planning_stuck: true`), and still allows `architect`/`critic` within an already-opened pass plus `post-interview`/`adr`/`final` so the best plan can be escalated to `pending approval` without dispatch. A new `--run-id` starts a fresh budget.
6. **Final intent verification** (post-consensus delta gate): After the review join gate has both Critic `OKAY` and Architect `CLEAR`/`APPROVE` for the same Planner artifact/pass, verify only intent deltas introduced or newly exposed by consensus. The pre-consensus `intent` receipt is the baseline; do not re-ask decisions already settled there.
   a. **Collect new open items** from the run: assumptions or conflicts introduced after the latest `intent` receipt, plus any material ambiguity first exposed by Architect/Critic. Source these from persisted artifacts, not memory.
   b. **Cross-check prior context for conflicts**: glob `.gjc/_session-{sessionid}/specs/deep-interview-*.md` and other prior specs/plans/context relevant by topic. For each, list points where the consensus plan contradicts, weakens, or expands beyond a previously crystallized decision, constraint, or non-goal. Cite the conflicting artifact and line/section.
   c. **Reconcile with the user via the `ask` tool (always, regardless of `--interactive`)**: Never stop idle with plain-text prose after the consensus loop. Every reconciliation question MUST go through the `ask` tool with contextual options plus free-text.
      - If open items exist, confirm the open assumptions and conflicts **one at a time** with the `ask` tool, weakest/highest-impact first, polishing intent. If any confirmation reveals that the plan diverges from user intent, route the consolidated correction back into the re-review loop (step 5b Planner revision) and re-run Architect + Critic before returning here. Cap at the same 5-iteration ceiling.
      - If the plan is crystal clear (no open assumptions or prior-context conflicts), continue to final persistence in step 7; do not choose an approval or handoff path before its final receipt exists.
      - For every confirmed open item, embed the resolved outcome into the final plan under an **## Intent Reconciliation** section so the `pending approval` artifact records each decision; record any item the user explicitly defers as an open confirmation under that same section.
   d. Persist the reconciliation with `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage post-interview --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`, then return the receipt/path plus a compact status (reconciled-clean / reconciled-with-revision / open-confirmations-pending) instead of pasting the full body.
7. On reconciliation completion, re-check the review join gate (Critic `OKAY` plus Architect `CLEAR`/`APPROVE` for the same Planner artifact/pass), mark the plan `pending approval` unless execution is already authorized by the resolved handoff admission, then persist the ADR/final plan via `gjc ralplan --write --worktree-root <repository_binding.worktreeRoot> --stage final --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`. Read the successful receipt's `auto_handoff` object; its ledger-backed `effectiveTarget` is runtime-owned and is the only automatic-routing decision; do not directly edit `.gjc/_session-{sessionid}/plans`. Final plan must include ADR (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups) and, when present, the **## Intent Reconciliation** section.
8. **Final admission and approval gate:** Reconciliation must first reach the successful final receipt from step 7. If that receipt has `auto_handoff.degradationReason: "planning_stuck"`, it is terminal: retain the `pending approval` artifact and **never dispatch**, including for an explicitly named execution skill; do not issue an approval `ask`. Otherwise, if its runtime-owned `auto_handoff.effectiveTarget` is `ultragoal`, that valid non-off receipt is explicit operator admission for same-turn execution through that target; proceed to step 9 without an `ask`. If it is `off`, including ordinary `off`, preserve the ordinary approval flow: if the user already explicitly named an execution skill in the current turn or via the structured approval UI (`ultragoal`, `/skill:ultragoal`, `gjc ultragoal`, or "Approve execution via ultragoal"), that is execution approval — skip the re-ask and proceed to step 9 with that skill. Otherwise, present the finalized plan via the `ask` tool (regardless of `--interactive`) with `workflowGate: { stage: "ralplan", kind: "approval" }` on the final question so RPC/headless clients receive a `ralplan`/`approval` workflow gate, not a deep-interview question gate. Use these options:
   - **Refine further** — re-run the consensus loop / request changes, then return here
   - **Approve execution via ultragoal (Recommended)** — goal-tracked autonomous execution
   - **Stop here** — keep the plan as `pending approval` and make no further changes

   Always include a free-text option for the ordinary `off` approval flow. Do not stop with plain text and no `ask` in that flow; its terminal action is this `ask`.
9. On valid automatic admission or explicit approval, invoke the admitted/approved `/skill:ultragoal` target by default. On **Refine further**, return to the step 5 re-review loop. On **Stop here**, leave the `pending approval` artifact and stop. A `planning_stuck` final receipt never reaches this step. Never implement directly.

   Before invoking `/skill:ultragoal`, mark ralplan ready for handoff so the skill tool's chain guard permits the transition:

   ```
   gjc state ralplan write --input '{"current_phase":"handoff"}' --json
   ```

   The skill tool then dispatches the execution skill same-turn and runs `gjc state ralplan handoff --to ultragoal --json` in-process to atomically demote ralplan, promote the callee, and sync `.gjc/_session-{sessionid}/state/skill-active-state.json`. You do not need to run the handoff verb yourself.

> **Important:** Architect and Critic MAY run in the same parallel batch only for the plan-only Critic lane after Planner persistence (review pass 1). Pass 2+ re-reviews MUST run sequentially Architect -> Critic: await Architect before issuing Critic, pass the current-pass Architect receipt/path to Critic for the rule-5 counter-review, then apply the same review join gate before consensus.

## Consensus iteration cap (operator contract)

- Default max consensus iterations: **5** (`gjc.ralplan.maxIterations`).
- On cap: exit code **3**, marker **`PLANNING-STUCK`** (stdout), no silent re-loop, no automatic or explicit ultragoal dispatch. Opener budget is `max(index.jsonl openers, on-disk stage-*-{planner,revision}.md count)` so a missing/empty/malformed ledger cannot fail open after prior openers.
- Headless/CI: treat `PLANNING-STUCK` / exit 3 as terminal planning failure for orchestration/watchdogs.
- Interactive: retain the best existing plan as a terminal planning result; residual critic findings stay as caveats.
- **Workflow settings precedence** — ralplan reads all of its settings
  (`gjc.ralplan.maxIterations`, `gjc.ralplan.maxReviewPassesPerLane`,
  `gjc.ralplan.autoHandoff`) through one shared resolver in this exact order
  (first valid value wins):
  1. project `.gjc/config.yml`
  2. user `<agentDir>/config.yml` (normally `~/.gjc/agent/config.yml`, honoring
     `GJC_CODING_AGENT_DIR`/`PI_CODING_AGENT_DIR`; XDG applies only to categorized data/state/cache subdirs, never the workflow config path)
  3. built-in default

  `config.yml` uses the nested (schema) form — `gjc: { ralplan: { maxIterations } }`.
  Project configuration beats user configuration. The reported `source` is the
  canonical path of the winning file, or `default`. `config.yml` is the ONLY
  settings surface: the legacy `settings.json` files (project and config-root)
  are retired: the config-root `~/.gjc/settings.json` is migrated once into the
  default global agent `config.yml` and its source removed, while the project
  `.gjc/settings.json` is retained for non-workflow settings (only its workflow
  keys are migrated into project `.gjc/config.yml` and no longer read unless a migration target is absent - a migration that could not publish (e.g. a read-only `.gjc`) leaves the retained legacy value effective as the previously configured override until it can publish). **Malformed or
  invalid explicit settings in any layer exit 2**
  (`invalid ralplan settings at <path>: <reason>`) — including
  `gjc.ralplan.maxIterations`, whose former silent fallback to the default is
  removed.
- Override example (project `.gjc/config.yml`):

```yaml
gjc:
  ralplan:
    maxIterations: 3
```

## Per-lane review budget (operator contract)

- Default: **1** Architect pass and **1** Critic pass per opener iteration.
- Override via `gjc.ralplan.maxReviewPassesPerLane` (integer **1..10**, registered in the public settings schema) using the workflow-settings precedence above; project overrides user.
- On overflow: exit code **3** with the **`PLANNING-STUCK`** marker and lane-specific JSON/stderr detail.
- `post-interview`, `adr`, and `final` are always allowed.
- Identical re-writes dedupe without stuck-signaling — including after a crash between artifact write and ledger append: the identical retry repairs the missing ledger row and returns the dedupe receipt.
- A new `--run-id` starts a fresh budget.
- A rule-2-justified blocker routes through a Planner `revision` opener (new iteration, fresh lane budget), never a second same-iteration review pass.
- Override example (project `.gjc/config.yml`):

```yaml
gjc:
  ralplan:
    maxIterations: 3
    maxReviewPassesPerLane: 2
```


Follow this ralplan-internal consensus workflow for consensus mode details.

### Persisted role agents (consensus loop)

The Planner, Architect, and Critic are **same-session persisted subagents**. Launch the Planner detached once and await it before review fan-out; Architect and Critic are also launched once per run as detached, resumable subagents in the pass-1 fan-out (parallel only for the plan-only Critic lane tied to the same Planner receipt/path/sha/stage_n). On pass 2+, resume the SAME persisted Planner with consolidated feedback and resume the SAME persisted Architect and Critic lane subagents with the mandatory re-review context bundle instead of fresh-spawning. Do NOT modify the subagent control surface; use existing `subagent` resume/steer controls only.

**Persistence boundary:** same-parent, active-session continuity only. Resumability requires retained subagent resume metadata and a persistent parent session (in-memory parent yields `resumable:false`), not just `.gjc` run-state. A terminal subagent can still resume when its retained descriptor points at a saved subagent session; after process restart, missing metadata, or failed/unavailable resume, use the fresh role/lane fallback.

**Resume routing table (for every persisted role: Planner, Architect, and Critic)** (per re-review pass, when resuming that role's persisted id):

| Resume outcome | Action |
|---|---|
| `running` | `steer`/inject that role's follow-up context to the same id, then await — do NOT fresh-spawn |
| `queued` | retain/update the queued message or `await` the same id — do NOT fresh-spawn just because it is queued |
| `context_unavailable`, `not_found`, `no_runner`, `resume_failed` | fresh-spawn fallback for that role/lane on that pass; record the fallback metadata. `not_found` should only mean same-session resume metadata is unavailable, not merely that a terminal live job was evicted. |
| terminal (`completed`/`failed`/`cancelled`) + follow-up message | resume the same id when context is available; otherwise use the fresh-spawn fallback above |

**Ratchet synergy:** a resumed Architect or Critic natively retains prior-pass context, but the re-review context bundle remains mandatory regardless so the fresh-spawn fallback remains fully functional and applies all five rules.

**Recording persisted-role-agent metadata** (audit/routing only — never claim `subagent list` proves resumability, since the snapshot does not expose `resumable`). Ride the matching optional flags on the role's normal `--write` for the pass:

| Role | Normal write stage | Metadata flags |
|---|---|---|
| Planner | `planner` or `revision` | `--planner-id <id> --planner-resumable <true|false>` |
| Architect | `architect` | `--architect-id <id> --architect-resumable <true|false>` |
| Critic | `critic` | `--critic-id <id> --critic-resumable <true|false>` |

The existing fallback flags ride the same role's normal write: `--fallback-reason <context_unavailable|not_found|no_runner|resume_failed|process_restart|missing_record>`, `--fallback-attempted-id <id>`, `--fallback-stage-n <N>`, and optional `--fallback-receipt-path <fresh-role-stage-artifact-path>`. A planner/revision write records Planner fallback metadata, an Architect write records Architect fallback metadata, and a Critic write records Critic fallback metadata. Set the matching `--*-resumable` flag to `true` only when the parent session is provably persistent; set/record `false` after an observed `context_unavailable`; otherwise omit it (unknown). Fallback flags are recorded only when a fresh-spawn fallback actually occurs: a fallback record requires `--fallback-reason` **together with** `--fallback-attempted-id` and `--fallback-stage-n` (the failed id and the pass it failed on), while `--fallback-receipt-path` is optional.

## Pre-Execution Gate

Execution skills (`ultragoal`) implement bounded work; they are not scope-discovery lanes. Vague execution requests are routed through ralplan so scope, acceptance criteria, consensus, and verification exist before code changes.

**Passes the gate** (specific enough for direct execution): file paths, issue/PR numbers, named symbols, explicit tests, numbered steps, acceptance criteria, error references, code blocks, or escape prefixes (`force:` / `!`). Examples: `fix src/hooks/bridge.ts`, `implement #42`, `add validation to processKeywordDetector`, `do:\n1. Add input validation\n2. Write tests`.

**Gated — redirected to ralplan**: `fix this`, `build the app`, `improve performance`, `add authentication`, `make it better`.

Gate auto-pass signals: file path, issue/PR number, camelCase/PascalCase/snake_case symbol, test runner, numbered steps, acceptance criteria, error reference, code block, or escape prefix. If it fires on a well-specified prompt, add one concrete anchor; if you intentionally bypass, prefix `force:` or `!`.

On consensus approval, choose:
- **ultragoal**: goal-tracked autonomous execution with verification (recommended default)

A redirected request proceeds only through the structured approval option or an explicit execution-skill choice; `just do it` / `skip planning` alone leaves the plan `pending approval`.
