---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.

source: "forked from upstream ultragoal skill and rebranded for GJC"
---

# Ultragoal Workflow

Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`, durable multi-goal planning, or sequential execution over GJC goal mode.

## Purpose

`ultragoal` turns a brief into repo-native durable artifacts and then drives execution through the unified `goal` tool as a UX bridge only. `goals.json` is the canonical source of goal identity and state; `ledger.jsonl` is the canonical proof stream for checkpoints, receipts, blockers, steering, and reviews. The inline `goal` tool and goal-mode-request create-bridge exist only to keep the agent's interactive loop focused on the current aggregate or story objective. Completion is verified purely from durable `goals.json` plus fresh `ledger.jsonl` receipts, never from inline goal state. The agent, not the CLI or hooks, calls `goal({"op":"complete"})` or `goal({"op":"drop"})` after durable run completion or cleanup; CLI commands and hooks never mutate goal state.

- `.gjc/_session-{sessionid}/ultragoal/brief.md`
- `.gjc/_session-{sessionid}/ultragoal/goals.json`
- `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl` (checkpoint and structured steering audit events)

Existing aggregate plans with the legacy enumerated objective are migrated to the stable pointer objective on read, persisted to `goals.json`, retained in `gjcObjectiveAliases` for already-active hidden goal reconciliation, and audited with an `aggregate_objective_migrated` ledger entry.
- **Nudge budget setting** — the per-story give-up budget
  (`gjc.ultragoal.nudgeBudget`, default **10**, non-negative integer) is read
  through one shared resolver in this exact order (first valid value wins):
  1. project `.gjc/config.yml`
  2. user `<agentDir>/config.yml` (normally `~/.gjc/agent/config.yml`, honoring
     `GJC_CODING_AGENT_DIR`/`PI_CODING_AGENT_DIR`; XDG applies only to categorized data/state/cache subdirs, never the workflow config path)
  3. built-in default
  `config.yml` uses the nested (schema) form - `gjc: { ultragoal: { nudgeBudget } }`.
  Project configuration beats user configuration. The reported `source` is the
  canonical path of the winning file, or `default`. `config.yml` is the ONLY
  settings surface: the legacy `settings.json` files (project and config-root)
  are retired: the config-root `~/.gjc/settings.json` is migrated once into the
  default global agent `config.yml` and its source removed, while the project
  `.gjc/settings.json` is retained for non-workflow settings (only its workflow
  keys are migrated into project `.gjc/config.yml` and no longer read unless a migration target is absent - a migration that could not publish (e.g. a read-only `.gjc`) leaves the retained legacy value effective as the previously configured override until it can publish). Invalid optional settings
  files continue to the next layer or the default (tolerant).

## Corrupt current-session state recovery

When ultragoal detects its own current-session state is corrupt, tampered, unreadable, or stale on resume, run `gjc state clear --force --mode ultragoal` before reseeding or restarting. Scope the clear to the current session via `--session-id`, the command payload, or `GJC_SESSION_ID`; it clears only ultragoal state for that session and never clears other skills or sessions.

## Always-used command examples

Use these exact `gjc ultragoal` commands before spending tool calls rediscovering syntax:

```sh
gjc ultragoal status
gjc ultragoal status --json
gjc ultragoal create-goals --brief "<brief>"
gjc ultragoal create-goals --brief-file <path>
gjc ultragoal complete-goals
gjc ultragoal complete-goals --retry-failed
gjc ultragoal quality-gate source-hash --json
gjc ultragoal quality-gate validate --quality-gate-json <quality-gate-json-or-path> [--goal-id <id>] [--json]
gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --quality-gate-json <quality-gate-json-or-path>
gjc ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"
gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve final review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>"
```

Use these exact goal-tool calls for the inline goal state:

```json
goal({"op":"get"})
goal({"op":"create","objective":"<printed aggregate or per-story objective>"})
goal({"op":"complete"})
goal({"op":"drop"})
goal({"op":"resume"})
```
`drop` clears the active goal without exiting goal mode; `resume` reactivates a paused goal.

## Create goals

1. Decide on the brief. To produce **multiple** stories, separate them with a reserved `@goal:` delimiter line; the title follows on the same line and the objective is everything beneath it until the next delimiter:

   ```text
   Shared brief constraints / context go here (optional preamble).

   @goal: Parse the intake CSVs
   Ingest reviewer CSVs from the watch dir, validate headers, and reject
   malformed rows with a per-row reason. Objectives can span multiple lines
   and contain `code`, "quotes", or commands — no escaping needed.

   @goal: Normalize records
   Map raw rows onto the canonical schema and dedupe by record id.

   @goal: Export the audit report
   Emit an audit-ready report covering every accepted and rejected row.
   ```

   Delimiter contract:
   - A `@goal` line is a story boundary **only** when it starts at column 0 (no leading whitespace) and the character right after `@goal` is `:`, whitespace (space or tab), or end-of-line. So `@goal: Title`, `@goal Title`, and a bare `@goal` line all open a story.
   - `@goalish`, `@goals:`, `@goal-foo`, `@goal.foo`, `@goal/foo`, and any indented or mid-line `@goal` are ordinary objective text, not delimiters. To keep a literal `@goal` line inside an objective, indent it.
   - A title-only block (no body) uses the title as its objective. An empty title borrows the first body line as the title. A block with **neither** title nor body is rejected — `create-goals` errors instead of writing a placeholder goal.
   - **Preamble** (any text before the first `@goal` delimiter) is global context/constraints only; it is retained in the brief but is **not** turned into a goal. Every executable story needs its own `@goal` block.
   - With **no** `@goal` delimiter anywhere, the whole brief becomes a single goal `G001` (unchanged legacy behavior).

   Stories become `G001`, `G002`, … in order.

2. Run one of:
   - `gjc ultragoal create-goals --brief "<brief>"`
   - `gjc ultragoal create-goals --brief-file <path>`
   - `cat <brief> | gjc ultragoal create-goals --from-stdin`
   - `gjc ultragoal create-goals --gjc-goal-mode per-story --brief "<brief>"` only when one GJC goal context per story is explicitly preferred
3. Inspect `.gjc/_session-{sessionid}/ultragoal/goals.json` and refine if needed.

### Create-goals granularity: merge validation-coupled stories

Before splitting a brief into many thin stories, check whether the candidate stories are **validation-coupled**. Merge validation-coupled stories into one goal and fan out executor slices inside that goal instead of creating one goal per slice. Two stories are validation-coupled when they share any of:

- the same feature stack (one story's code cannot be meaningfully verified without the other's),
- the same acceptance surface,
- the same red-team surface, or
- the same final review boundary (they can only be signed off as a unit).

Fanning out executor slices inside a single merged goal keeps one review/QA boundary while preserving parallel implementation. When validation-coupled stories must stay as separate goals for scheduling reasons, use an aggregate-mode **validation batch** (below) so the coupled review happens once at the final member.

## Complete goals

Loop until `gjc ultragoal status` reports all goals complete:

1. Run `gjc ultragoal complete-goals`.
2. Read the printed handoff.
3. Call `goal({"op":"get"})`.
4. If no active GJC goal exists, call `goal({"op":"create","objective":"<printed payload objective>"})` with the printed payload. In aggregate mode, if the same aggregate objective is already active, continue the current GJC story without creating a new GJC goal. If `goal({"op":"get"})` shows a stale dropped goal (status `"dropped"`) and a new aggregate must start, no extra cleanup is needed — `goal({"op":"create"})` succeeds directly. If a previous aggregate is still active and you genuinely need a fresh start in the same session, call `goal({"op":"drop"})` first, then `goal({"op":"create"})`.
5. Complete the current GJC story only.
6. Run a completion audit against the story objective and real artifacts/tests.
7. Before any `--status complete` checkpoint, run the mandatory final cleanup/review gate below. In aggregate mode, do **not** call `goal({"op":"complete"})` for intermediate stories; checkpoint each story while the aggregate objective is still `active`. On the final story, create the final aggregate receipt first; only after that receipt exists may `goal({"op":"complete"})` run.
8. Checkpoint the durable ledger. Complete checkpoints require `--quality-gate-json` only:
   `gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --quality-gate-json <quality-gate-json-or-path>`
   A successful complete checkpoint is story completion, not automatic run completion. Read the checkpoint output: when it prints `Next ultragoal goal: <id>`, continue that active story under the same aggregate GJC goal; when it prints `All ultragoal goals are complete`, the durable run is terminal. `gjc ultragoal complete-goals` remains the supported manual next-story command if continuation output was missed.
9. If blocked or failed, checkpoint failure:
   `gjc ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
10. For legacy per-story completed-goal blockers, preserve the non-terminal blocker with:
   `gjc ultragoal checkpoint --goal-id <id> --status blocked --evidence "<completed legacy GJC goal blocks goal create in this thread>"`
11. Resume failed goals with `gjc ultragoal complete-goals --retry-failed`.

## Blocker triage and pause discipline

An active Ultragoal run must not give up on a blocker by pausing the goal and asking the user. Classify every blocker before deciding what to do, and default to `resolvable` when unsure:

- **`resolvable`** — anything the agent can act on: failing tests, missing implementation, a dependency to install, an ambiguous-but-inferable detail, investigation. **Never pause.** Exhaust autonomous resolution first: investigate, `gjc ultragoal steer --kind add_subgoal --title "Investigate blocker" --objective "..." --evidence "..." --rationale "..."`, delegate an `executor`, or preserve the blocker durably with `gjc ultragoal checkpoint --status blocked` / `gjc ultragoal record-review-blockers` and keep scheduling the next goal.
- **`human_blocked`** — only the user can act: credentials/secrets, a manual or physical step, an external approval/decision, access the agent lacks. Pause is the last resort and is gated.

`goal({"op":"pause"})` is **blocked at runtime** while an Ultragoal run is active unless the latest `blocker_classified` ledger event is `human_blocked` and a later bound clean pause terminal critic verdict is recorded for it (see [Terminal critic gate](#terminal-critic-gate)). `assertUltragoalPauseAllowed` first consumes a pre-existing give-up nudge (a durable ledger write) before it runs the read-only pause diagnostic; only `isUltragoalPauseBlocked` is a pure reader. To pause, first record the human-only classification and capture its event id, then record the terminal critic's clean bound pause verdict, and only then pause:

```sh
gjc ultragoal classify-blocker --classification human_blocked --evidence "<the specific human-only dependency>" [--goal-id <id>]
gjc ultragoal record-critic-verdict --terminus pause --classification-event-id <eventId> --verdict OKAY --evidence "<terminal critic evidence>"
goal({"op":"pause"})
```

Recording `--classification resolvable` is an audit note only; it never authorizes a pause. The `ask` tool stays blocked during active runs regardless of classification — record unresolved decisions as durable blockers instead of prompting.

## Dynamic steering

Use `gjc ultragoal steer` when real findings or blockers prove the current story decomposition should change while the aggregate objective and constraints stay fixed. Steering is explicit-only and evidence-backed; broad natural-language requests are rejected instead of guessed.

Allowed mutation kinds are:

- `add_subgoal`
- `split_subgoal`
- `reorder_pending`
- `revise_pending_wording`
- `annotate_ledger`
- `mark_blocked_superseded`

Examples:

```sh
gjc ultragoal steer --kind add_subgoal --title "Investigate blocker" --objective "Validate the blocker and report evidence." --evidence "log/test output" --rationale "The blocker changes the safe execution order." --json
gjc ultragoal steer --kind split_subgoal --goal-id G002 --replacements-json '[{"title":"Fix parser","objective":"Resolve parser blocker."},{"title":"Verify parser","objective":"Run focused parser verification."}]' --evidence "Implementation split found two separable risks" --rationale "Splitting keeps each sub-goal independently verifiable." --json
gjc ultragoal steer --kind reorder_pending --order-json '["G003","G002"]' --evidence "Dependency order changed after investigation" --rationale "G003 must land before G002 can proceed safely." --json
gjc ultragoal steer --kind revise_pending_wording --goal-id G002 --title "Clarify blocker story" --evidence "The current title hides the actual blocker" --rationale "Clear wording keeps the ledger auditable." --json
gjc ultragoal steer --kind annotate_ledger --evidence "User changed release ordering at runtime" --rationale "The aggregate objective is unchanged, but the execution history needs an audit note." --json
gjc ultragoal steer --kind mark_blocked_superseded --goal-id G004 --evidence "The blocked work is no longer required because replacement evidence covers it" --rationale "No replacement sub-goal is needed; superseding only the blocked sub-goal unblocks final completion without changing the aggregate objective." --json
```

`--directive-json` and UserPromptSubmit structured steering are planned/deferred routing surfaces, not part of the native typed `--kind` CLI path described above.

Steering invariants:

- Do not edit the aggregate goal objective, original brief constraints, quality gates, or completion status. The aggregate objective is a stable pointer to `.gjc/_session-{sessionid}/ultragoal/goals.json` and `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl`, not an enumeration of initial goal ids.
- Do not hard-delete goals, auto-complete work, weaken verification, or silently mutate `.gjc/_session-{sessionid}/ultragoal`.
- Accepted and rejected attempts append structured audit entries to `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl`.
- Superseded goals remain in `goals.json` with steering metadata and are skipped for scheduling.
- Blocked goals without replacements are skipped for scheduling but still block final completion until later explicit steering replaces or supersedes them.

UserPromptSubmit structured steering directives are a planned/deferred routing surface. Normal prose does not mutate state.

## Role-agent delegation guidance

Ultragoal execution should use GJC's bundled role-agent roster when a durable story is large enough to benefit from delegation:

- Use `executor` for bounded implementation, refactoring, and fix slices.
- Use `planner` for story sequencing or handoff refinement when execution uncovers a missing plan branch.
- Use `architect` for read-only architecture and code-review lanes, including `CLEAR` / `WATCH` / `BLOCK` status.
- Use `critic` for read-only plan or handoff critique before execution proceeds.

### Implementation delegation guidance

Direct inline implementation by the leader is the default. Delegate to `executor` subagents only when the expected diffs land in **genuinely different sub-domains, modules, or systems** — separable surfaces with independent acceptance criteria and no shared-file contention. File count or line count alone does not force delegation; a large change confined to one domain/subsystem is usually better done inline or by a single sequenced `executor`.

Delegation is worth it when:

- The story spans **multiple distinct sub-domains / modules / systems** (e.g. a CLI surface plus an unrelated runtime subsystem plus docs tooling) whose slices can proceed in parallel without coordinating on the same files.
- Each slice can be bounded with explicit targets and acceptance criteria that are verifiable independently of the other slices.
- The leader's checkpoint/verification duties would otherwise be crowded out by juggling unrelated domains inline.

When delegating:

- Give each `executor` bounded targets and explicit acceptance criteria, and keep checkpoint/goal-state ownership in the leader.
- Parallelize only across genuinely different sub-domains/modules/systems; sequence anything with a real dependency or shared-surface overlap.
- Work within a single domain/subsystem stays with the leader as direct edits — do not split one cohesive change across subagents, and do not over-delegate trivial work.
- After integrating delegated slices, you MAY run `architect` / `critic` review lanes for early signal, but treat them as **advisory**: the canonical review is the boundary cohort gate below, and a slice-level lane never substitutes for it or its verdict. Skip slice review entirely when the boundary cohort will cover the same change set shortly. Worker agents never mutate `.gjc/_session-{sessionid}/ultragoal` or call goal tools.

When delegating with native subagents, an await timeout only limits the leader's wait. It is not subagent failure evidence and must not be used as a cancellation reason; inspect or continue independent work, and cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong.

### Subagent reuse and resumption (token efficiency)

Fresh spawns re-pay the full context ramp-up (file reads, domain orientation, contract restatement) on every delegation. When a later slice or lane targets the **same sub-domain/module/system** as a prior subagent of the same role, **resume the prior subagent instead of freshly spawning**:

- Track the subagent id per role + domain as it is created; on the next same-domain `executor` slice or same-scope `architect` review lane, resume that id and inject only the delta (new targets, new acceptance criteria, the updated frozen change set) rather than re-briefing from scratch.
- Reuse is domain-scoped: resume only when the prior context is an asset. A slice in a genuinely different sub-domain/module/system gets a fresh spawn — stale cross-domain context is a liability, not a saving.
- Resumability requires retained subagent resume metadata and a persistent parent session; use existing `subagent` resume/steer controls only. Route per attempt: `running` → steer/inject to the same id and await; `queued` → retain or await the same id; terminal (`completed`/`failed`/`cancelled`) with context available → resume the same id; `context_unavailable`, `not_found`, `no_runner`, or `resume_failed` → fresh spawn fallback for that slice.
- A resumed subagent is still the same worker under the same contract: it must not mutate `.gjc/_session-{sessionid}/ultragoal`, call goal tools, or absorb checkpoint/goal-state ownership, and review lanes (`architect`, `critic`) stay read-only when resumed.
- Resumption never weakens gates: a resumed `architect` review or `executor` QA lane must still evaluate the current frozen change set on its own evidence, not rubber-stamp its earlier verdict.

If an Ultragoal request has no approved plan or consensus artifact **and** the scope genuinely needs one, run `ralplan` first and preserve its PRD, test spec, role roster, and verification guidance in the Ultragoal ledger. Skip `ralplan` for small scope: work that fits a single reviewable PR and is tied to a single domain/subsystem can proceed directly from the brief — record that judgment in the ledger instead of running a planning round. Reach for `ralplan` when the scope spans multiple domains/subsystems, needs cross-cutting sequencing, or would not fit a single PR.

The Ultragoal leader owns `.gjc/_session-{sessionid}/ultragoal/goals.json` and `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl`. Role agents return implementation/review evidence; they do not checkpoint Ultragoal or mutate goal state.

### Native executor parallelism contract

Native subagent parallelism is a contract for bounded `executor` delegation, not a runtime scheduler:

- **Use native `executor` parallelism only** when a story's expected diffs fall in genuinely different sub-domains/modules/systems, each boundable by a per-slice coordination contract.
- **Default to direct leader edits** otherwise; sequence any work with real dependencies, shared-file overlap, or a single-domain footprint, and never parallelize work that lacks a safe contract.
- Worker agents **MUST NOT mutate `.gjc/_session-{sessionid}/ultragoal`**, call goal tools, make checkpoint decisions, own integration, or own final verification. The Ultragoal leader keeps those responsibilities.
- Workers must not run `gjc ultragoal checkpoint`: checkpoint authority stays with the leader after worker tasks are terminal. The leader checkpoints from worker evidence plus the current-session GJC goal snapshot, and performs no hidden goal mutation.

Before workers start, each per-slice coordination contract MUST name the target files/surfaces, independence assumptions, allowed coordination channel, conflict-escalation rule, expected evidence, and terminal status. Conflict or assignment changes remain leader-owned and must be auditable through durable ledger evidence.

For failed, timed-out, or contract-violating slices, record durable ledger evidence; preserve successful terminal slices only when safe; and reassign, retry, or collapse the invalid work to serial execution under an updated contract. Completion after parallel work still requires terminal worker evidence, leader integration, targeted verification, and the existing cleaner + architect + executor QA/red-team gate before checkpoint complete.


## Boundary verification (aggregate default)

Heavyweight review runs **once per boundary**, not once per story. In aggregate mode the whole required-goal set is one implicit boundary by default: every checkpoint before the run's final required goal may present the lightweight `deferredToBatch` gate, and only the final goal carries the full strict gate. Nothing needs to be declared to get this — it is the default.

A deferred gate is just the proof the runtime cannot know: that targeted verification ran. Everything mechanical — `kind`, the batch tuple, `deferredLanes`, and the whole `changeSet` block (`paths`, `changeSetHash`) — is auto-filled from durable state and the computed cumulative git diff. Never hand-compute a hash. The minimal valid gate:

```json
{
  "deferredToBatch": {
    "ranLanes": ["targetedVerification"],
    "targetedVerification": {
      "status": "passed",
      "commands": ["bun test <targeted suite>"],
      "evidence": "what was verified and how it passed"
    }
  }
}
```

`deferredToBatch.ranLanes` lists the lanes you actually ran (`targetedVerification`, plus optionally `aiSlopCleaner` / `iteration`); declaration and evidence must match in both directions. `ranLanes` can never claim `architectReview` or `executorQa`, and a deferred gate can never contain `architectReview`, `executorQa`, or `validationBatchClose` — review always belongs to the boundary, and deferring never manufactures approvals. Any optional field you do supply must match reality; a wrong value fails closed. Check with `gjc ultragoal quality-gate validate` before checkpointing.

### Validation batches (explicit phase/module boundaries)

When one ledger is large enough that a single end-of-run boundary is too coarse, use an explicit validation batch to subdivide it into phase/module boundaries, each with its own final member. Validation batches are **aggregate-only**, **explicit-only**, and **fail-closed**. They are created only through `--validation-batch-json`; there is no inference from brief prose, no per-story batching, and no other batching input path.

Create a batch explicitly:

```sh
gjc ultragoal create-goals --brief-file <path> --validation-batch-json '[{"schemaVersion":1,"batchId":"VB001","memberIds":["G001","G002","G003"],"finalGoalId":"G003"}]'
```

Checkpoint contract summary — the full contract lives in the `validation-batch-contracts` fragment (`skill-fragments/ultragoal/validation-batch-contracts.md`); load it before checkpointing any batch member:

- **Non-final members** checkpoint `complete` with a single top-level `deferredToBatch` quality gate (kind `validation-batch-deferred`) proving targeted verification, a declaration-matched lane set, and a cumulative-since-base change set — never `architectReview`, `executorQa`, or `validationBatchClose`; deferring never manufactures fake review approvals.
- **The final member** (`finalGoalId`) checkpoints `complete` with the normal full strict gate PLUS a top-level `validationBatchClose` proof covering all members; out-of-order close is rejected, close state is append-only proof on the final member only, and batch invalidation is fail-closed. Like the deferred gate, every close field except `coverageEvidence` is auto-filled from durable receipts and the computed diff — the minimal close is `{"validationBatchClose":{"coverageEvidence":"..."}}` alongside the strict gate.

### Intra-goal validation-lane parallelism

Cohort lanes are parallel by construction: the boundary gate freezes one `sourceHash` first, so `cleaner`, `architect`, and `qa` can run concurrently against the identical immutable snapshot and then join. Fall back to **sequential** lanes only when code is still changing (nothing can be frozen yet), when the red-team lane depends on architect fixes, or when architect findings gate the QA scope. Either way the lanes must **join before checkpoint** — no lane checkpoints independently, and repair work starts only after the join.

## Internal Ultragoal sub-skill fragments

The completion-gate cleanup sweep is driven by `ai-slop-cleaner`, an internal Ultragoal sub-skill bundled as a `kind: "skill-fragment"` prompt with parent skill `ultragoal` (installed at `skill-fragments/ultragoal/ai-slop-cleaner.md`). It is analogous to deep-interview's auto-research fragment: loaded on demand for one specific hook, never a user-facing skill.

- It is not slash-command discoverable, has no public skill-listing entry, and is never resolvable through `skill://`.
- It is a read-only detector+reporter over the active story's changed files only: it never edits code, writes files, mutates `.gjc/`, checkpoints, calls goal tools, or spawns workflows.
- It classifies every finding as blocking or advisory across the full taxonomy (fallback-like masking vs. grounded, duplication, dead code, needless abstraction, boundary violations, UI/design slop, missing tests).
- The leader and a leader-spawned `executor` own all fixes; the cleaner reruns until zero blocking findings remain. Advisory findings live in the gate report only.
- Recursion guard: it must not spawn nested `ralplan`/`deep-interview`/`ultragoal`; broad or architectural findings are handed back to the leader as review blockers.

## Boundary completion cohort gate

Every story boundary runs one frozen-snapshot review generation: verify, freeze the change set, run the cohort lanes (ai-slop-cleaner, `architect` review, `executor` QA/red-team) on the frozen snapshot, then join all lane verdicts before any repair. Validate the gate with `gjc ultragoal quality-gate validate` before checkpointing.

The full contract lives in the `boundary-cohort-gate` fragment. Read `embedded:gjc/skill-fragments/ultragoal/boundary-cohort-gate.md` before acting on this section; do not act from this summary alone.

## Terminal critic gate

Both terminal exits (completion and blocked/pause termini) require a read-only `critic` role agent's `OKAY` verdict, once per run terminus. It is additive to the per-story review lanes and fails closed.

The full contract lives in the `terminal-critic-gate` fragment. Read `embedded:gjc/skill-fragments/ultragoal/terminal-critic-gate.md` before acting on this section; do not act from this summary alone.

## Review mode

`gjc ultragoal review` runs the same hardened gate against an already implemented PR, branch, or worktree. Use `--pr <number>` for a PR, `--branch <ref>` for a branch diff, omit both for the current worktree, and pass `--spec <path>` when a real contract exists. `--mode review-only` emits the verdict/findings without creating fix work; `--mode review-start` records review blockers for follow-up. Review mode validates the same `executorQa` shape and live-surface artifacts as `checkpoint --status complete`. A thin or derived-only contract can never clean-pass: the verdict is capped at `inconclusive: weak-contract` until a supplied spec or equivalent strong acceptance criteria are available.

Receipts are freshness-scoped:
- Per-goal receipts remain fresh for their target goal unless that goal, its blocker metadata, or its supersession metadata changes.
- Normal later `goal_started` or clean receipt-backed `goal_checkpointed` events for other goals do not stale older per-goal receipts.
- Appending required goals or changing final required-goal state stales final aggregate receipts. Final aggregate completion requires a fresh final aggregate receipt proving no incomplete, blocked, or `review_blocked` required goals remain.
- Deferred per-goal receipts (validation-batch members) are incomplete until a matching fresh batch-close receipt exists on the batch's `finalGoalId`; a story-scope query for a deferred member stays blocked until that close, and mutating a member after close stales the batch-close and final aggregate receipts.

## Cross-repository succession

When approved work belongs in another repository, never edit `repositoryBinding` or copy the runtime directory; use `gjc ultragoal succession offer|adopt|status` instead.

The full contract lives in the `cross-repository-succession` fragment. Read `embedded:gjc/skill-fragments/ultragoal/cross-repository-succession.md` before acting on this section; do not act from this summary alone.

## Handoff back to planning

When the aggregate ultragoal is complete OR the user requests return to planning/clarification, mark ultragoal ready for handoff so the skill tool's chain guard permits the backward transition:

```
gjc state ultragoal write --input '{"current_phase":"handoff"}' --json
```

The skill tool then dispatches `/skill:ralplan` or `/skill:deep-interview` same-turn and runs `gjc state ultragoal handoff --to <ralplan|deep-interview> --json` in-process to atomically demote ultragoal, promote the callee, and sync both `.gjc/_session-{sessionid}/state/skill-active-state.json` files. You do not need to run the handoff verb yourself.

## Constraints

- The shell command emits a model-facing handoff for the active GJC agent; it does not invoke any `/goal` slash-command and the agent loop must not depend on any `/goal` subcommand.
- Use only the unified goal-tool surface from the agent loop: `goal({"op":"get"})`, `goal({"op":"create"})`, `goal({"op":"complete"})`, `goal({"op":"drop"})`, `goal({"op":"resume"})`. `drop` clears the active goal without exiting goal mode so the next `goal({"op":"create"})` works in-session. No slash-command cleanup exists or is required; Ultragoal never calls any `/goal` subcommand.
- For back-to-back ultragoal runs in the same session/thread, when `goal({"op":"get"})` still reports an active aggregate, call `goal({"op":"drop"})` before `goal({"op":"create"})`; when no active goal exists or the prior aggregate is already complete or dropped, call `goal({"op":"create"})` directly. The goal tool remains callable across drop; no slash-command cleanup exists or is required.
- Never call `goal({"op":"create"})` when `goal({"op":"get"})` reports a different active goal.
- Never call `goal({"op":"complete"})` unless the aggregate run or legacy per-story goal is actually complete.
- In aggregate mode, intermediate and final story checkpoints update durable `goals.json` state and append receipt proof to `ledger.jsonl`; the final story checkpoint creates the final aggregate receipt before the agent may call `goal({"op":"complete"})`.
- Completion checkpoints require `--quality-gate-json` only. Shell commands and hooks must not mutate goal state; the agent reconciles inline goal-tool state after durable completion.
- Final-aggregate completion additionally requires a `criticReview` `OKAY`; a `human_blocked` pause additionally requires a fresh `OKAY` `critic_verdict` receipt.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
