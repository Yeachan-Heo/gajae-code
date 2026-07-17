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

Durable completion is single-source: `goals.json` defines which goals exist and their required state, while `ledger.jsonl` provides the receipt proof used to verify completion. Inline goal state is UX-only and is reconciled by the agent after durable completion, not by CLI checkpoints or hooks.

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

`goal({"op":"pause"})` is **blocked at runtime** while an Ultragoal run is active unless the latest durable ledger event classifies the current blocker as `human_blocked`. To pause, record the classification immediately before pausing and cite the human-only dependency as evidence:

```sh
gjc ultragoal classify-blocker --classification human_blocked --evidence "<the specific human-only dependency>" [--goal-id <id>]
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

### Mandatory implementation delegation on big scope

When a story's implementation scope is **big enough**, the Ultragoal leader MUST delegate the implementation to one or more `executor` subagents instead of writing the code inline itself. This is a hard requirement, not a preference: solo inline implementation of a big-scope story is a gate violation, and the completion cleanup/review gate must treat missing delegation on a big-scope story as a blocker.

A story's implementation scope is **big enough** to force delegation when any of the following hold:

- It spans **3+ files** or **2+ cleanly separable surfaces/modules** that can be implemented against bounded, independent acceptance criteria.
- It is estimated at **~200+ lines of net implementation change**, or is otherwise large enough that a single inline pass would crowd out the leader's checkpoint/verification duties.
- It decomposes into **independent slices** that can proceed in parallel without shared-file contention.
- The leader has already made **2+ inline edit passes** on the same story and implementation is still materially incomplete.

Forced-delegation rules:

- Split the story into cleanly separable slices, give each `executor` bounded targets and explicit acceptance criteria, and keep checkpoint/goal-state ownership in the leader.
- Prefer **parallel** `executor` subagents for independent slices; sequence only slices with a real dependency.
- If a big-scope story cannot be cleanly split, record the reason as a durable ledger note and delegate the whole implementation to a single `executor` rather than doing it inline; the leader still owns verification.
- Small, atomic, single-file changes below these thresholds stay with the leader — do not over-delegate trivial work.
- After integrating delegated slices, run `architect` / `critic` review lanes; worker agents never mutate `.gjc/_session-{sessionid}/ultragoal` or call goal tools.

When delegating with native subagents, an await timeout only limits the leader's wait. It is not subagent failure evidence and must not be used as a cancellation reason; inspect or continue independent work, and cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong.

If an Ultragoal request has no approved plan or consensus artifact, run `ralplan` first and preserve its PRD, test spec, role roster, and verification guidance in the Ultragoal ledger. Do not silently substitute ad-hoc execution for missing planning.

The Ultragoal leader owns `.gjc/_session-{sessionid}/ultragoal/goals.json` and `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl`. Role agents return implementation/review evidence; they do not checkpoint Ultragoal or mutate goal state.

### Native executor parallelism contract

Native subagent parallelism is a contract for bounded `executor` delegation, not a runtime scheduler and not a Team-mode rule:

- **MUST use native `executor` parallelism** when a story meets the big-scope delegation threshold above and decomposes into independent implementation slices that can be bounded by per-slice coordination contracts.
- **SHOULD prefer parallel `executor` subagents** for independent files/surfaces, and sequence only real dependencies, unsafe shared-file overlap, sub-threshold trivial work, or work that lacks a safe contract.
- Worker agents **MUST NOT mutate `.gjc/_session-{sessionid}/ultragoal`**, call goal tools, make checkpoint decisions, own integration, or own final verification. The Ultragoal leader keeps those responsibilities.

Before workers start, each per-slice coordination contract MUST name the target files/surfaces, independence assumptions, allowed coordination channel, conflict-escalation rule, expected evidence, and terminal status. Conflict or assignment changes remain leader-owned and must be auditable through durable ledger evidence.

For failed, timed-out, or contract-violating slices, record durable ledger evidence; preserve successful terminal slices only when safe; and reassign, retry, or collapse the invalid work to serial execution under an updated contract. Completion after parallel work still requires terminal worker evidence, leader integration, targeted verification, and the existing cleaner + architect + executor QA/red-team gate before checkpoint complete.

### Runtime-backed pipelined scheduling

Sequential execution remains the default. Ultragoal may use runtime-backed pipelined scheduling only when `goals.json` metadata proves original-plan independence and disjoint target files/surfaces for the prior and next goals. This is a leader-owned Ultragoal runtime contract, not hidden Team scheduling and not a substitute for the native executor parallelism contract above.

Pipeline metadata is explicit-only: create eligible goals with `gjc ultragoal create-goals --goal-metadata-json '<json>'` or the equivalent runtime `createUltragoalPlan({ goalMetadata })` input. Brief-only or missing metadata remains valid but non-eligible and falls back to ordinary sequential scheduling. The initial pipeline contract is **aggregate mode only**; per-story mode remains sequential until a separate UX/state contract exists.

The full lifecycle commands (`start-pipeline-overlap`, `join-pipeline-overlap`, `rebaseline-pipeline-overlap`) and the fail-closed overlap rules — at most one eligible next goal per join window, G(N) remains active until a clean join, quarantine and re-baseline on dirty joins or lost handles, complete checkpoints fail closed on open overlaps or unattributable change-set paths — are specified in the internal `pipeline-validation-contracts` fragment (`skill-fragments/ultragoal/pipeline-validation-contracts.md`). Load that fragment before operating an overlap; the runtime enforces its rules verbatim.

Team remains explicit and separate: Team is not auto-launched, not a hidden pipeline scheduler, and never owns Ultragoal goals, checkpoints, or ledger state.

## Validation batches (aggregate-only)

Validation batches let several aggregate-mode goals that share one review/QA boundary defer their heavyweight architect + executor QA/red-team review to a single **final member**, while each non-final member still proves targeted verification and cleanup. Validation batches are **aggregate-only**, **explicit-only**, and **fail-closed**. They are created only through `--validation-batch-json`; there is no inference from brief prose and no per-story batching.

Batches and #1701 pipeline metadata/overlap are **mutually exclusive**: `--validation-batch-json` and `--goal-metadata-json` cannot be combined, and a goal may not carry both `validationBatch` and eligible `pipelineMetadata`. There is no batch/pipeline mixing.

Create a batch explicitly:

```sh
gjc ultragoal create-goals --brief-file <path> --validation-batch-json '[{"schemaVersion":1,"batchId":"VB001","memberIds":["G001","G002","G003"],"finalGoalId":"G003"}]'
```

Checkpoint contract summary — the full contract lives in the `pipeline-validation-contracts` fragment (`skill-fragments/ultragoal/pipeline-validation-contracts.md`); load it before checkpointing any batch member:

- **Non-final members** checkpoint `complete` with a single top-level `deferredToBatch` quality gate (kind `validation-batch-deferred`) proving targeted verification, an ai-slop-cleaner pass, a rerun iteration, and a cumulative-since-base change set — never `architectReview`, `executorQa`, or `validationBatchClose`; deferring never manufactures fake review approvals.
- **The final member** (`finalGoalId`) checkpoints `complete` with the normal full strict gate PLUS a top-level `validationBatchClose` proof covering all members; out-of-order close is rejected, close state is append-only proof on the final member only, and batch invalidation is fail-closed.

### Intra-goal validation-lane parallelism

Within a single goal (including a single-goal run or one validation-batch member), architect review and the executor QA/red-team lane MAY run in parallel, but only on the same **frozen post-cleaner change set**: run the ai-slop-cleaner to a zero-blocker pass and rerun verification first, then hand both lanes the identical frozen change-set summary. Parallel architect + executor QA/red-team lanes must **join before checkpoint** — neither lane may checkpoint independently. Fall back to **sequential** lanes when code is still changing, when the two lanes would see divergent snapshots, when the red-team lane depends on architect fixes, or when architect findings gate the QA scope.

## Use Ultragoal and Team together

Use ultragoal and team together for a durable Ultragoal story that benefits from one visible tmux worker session. Ultragoal remains leader-owned: `.gjc/_session-{sessionid}/ultragoal/goals.json` stores the story plan and `.gjc/_session-{sessionid}/ultragoal/ledger.jsonl` stores checkpoints. Team is the single-worker tmux execution engine and returns task/evidence status to the leader.

The leader checkpoints Ultragoal from Team evidence plus the current-session GJC goal snapshot; durable state remains leader-owned in `goals.json` and `ledger.jsonl`:

```sh
gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .gjc/_session-{sessionid}/ultragoal and <id>>" --quality-gate-json <quality-gate-json-or-path>
```

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Workers must not run `gjc ultragoal checkpoint`; checkpoint authority stays with the leader after worker tasks are terminal. Team launch remains explicit; Ultragoal does not auto-launch Team and performs no hidden goal mutation.

## Internal Ultragoal sub-skill fragments

The completion-gate cleanup sweep is driven by `ai-slop-cleaner`, an internal Ultragoal sub-skill bundled as a `kind: "skill-fragment"` prompt with parent skill `ultragoal` (installed at `skill-fragments/ultragoal/ai-slop-cleaner.md`). It is analogous to deep-interview's auto-research fragment: loaded on demand for one specific hook, never a user-facing skill.

- It is not slash-command discoverable, has no public skill-listing entry, and is never resolvable through `skill://`.
- It is a read-only detector+reporter over the active story's changed files only: it never edits code, writes files, mutates `.gjc/`, checkpoints, calls goal tools, or spawns workflows.
- It classifies every finding as blocking or advisory across the full taxonomy (fallback-like masking vs. grounded, duplication, dead code, needless abstraction, boundary violations, UI/design slop, missing tests).
- The leader and a leader-spawned `executor` own all fixes; the cleaner reruns until zero blocking findings remain. Advisory findings live in the gate report only.
- Recursion guard: it must not spawn nested `ralplan`/`team`/`deep-interview`/`ultragoal`; broad or architectural findings are handed back to the leader as review blockers.

## Mandatory completion cleanup and review gate

An ultragoal story cannot be checkpointed `complete` until the active agent has run the quality gate. The gate is plan-first, contract-driven, and surface-based:

1. Run targeted implementation verification for the story.
2. Run the internal ai-slop-cleaner skill fragment as the cleanup sweep on the story's changed files only, so only clean code reaches the review and red-team lanes. It is a read-only detector that emits an `AI SLOP CLEANUP REPORT`; if there are no relevant edits it still runs and records a passed/no-op report. Every BLOCKING cleaner finding is a completion blocker: the leader spawns an `executor` to fix blocking findings only, then reruns the cleaner until blocking findings are zero. Advisory findings are included in the gate report only and are not written to the Ultragoal ledger. Carry the report through the existing `qualityGate.iteration.evidence` field; do not add a new top-level quality-gate key.
3. Rerun verification after the cleaner pass so reviewed evidence covers the cleaned code.
4. Delegate an `architect` review covering all three lanes:
   - architecture-side: system boundaries, layering, data/control flow, operational risks.
   - product-side: user-visible behavior, acceptance criteria, edge cases, regressions.
   - code-side: maintainability, tests, integration points, and unsafe shortcuts.
5. Delegate an `executor` QA/red-team lane to build and run the e2e/read-teaming QA suite appropriate for the story. This lane must try to break the change, not just confirm the happy path. It must start from the approved plan/spec/acceptance criteria, then user-facing contracts, and only then implementation code as supporting evidence. Plan/code mismatches are blockers, not items to paper over with implementation intent.
6. The executor QA/red-team lane must prove evidence by the real surface under test:
   - GUI/web surfaces require a valid automation transcript plus a non-uniform screenshot. Bare `inlineEvidence` text or typed receipts never prove live GUI/web execution.
   - CLI surfaces require runtime argv replay: `schemaVersion: 1`, `kind: "cli-replay"`, `replaySafe: true`, an allowlisted argv `command`, and replayed output validation. The complete field-by-field replay schema, command allowlist, and `replayExempt` audit contract are specified once in the "For CLI replay artifacts" paragraph below the quality-gate JSON; follow it exactly.
   - Native/desktop/tui surfaces require a structurally valid screenshot, PTY capture with terminal control codes, or app-automation transcript.
   - API/package surfaces require a real artifact file or typed receipt whose artifact `kind` contains one of `api`, `package`, `consumer`, `black-box`, or `test-report`; examples: `api-package-test-report`, `package-consumer-report`, `black-box-api-receipt`. Algorithm/math surfaces require a real artifact file or typed receipt whose artifact `kind` contains one of `property`, `boundary`, `edge`, `adversarial`, `failure`, `math`, `algorithm`, or `test-report`; examples: `property-test-report`, `algorithm-boundary-report`. Bare `inlineEvidence` text alone is not sufficient for any surface.
   - The mandatory **computer-use** red-team suite (`kill-switch-bypass`, `suspended-enforcement`, `permission-revoked`, …) is conditional, not universal: require it only when computer/desktop control is genuinely part of the product surface being dogfooded. For every other product type, prove the change through the matching live surface instead — browser-use automation for web/GUI, bash/CLI live invocation or argv replay for CLI, and real artifacts or typed receipts for API/package/algorithm/math. Editing docs, prompts, or skills that merely mention computer-use does not by itself make the computer-use suite applicable; pick the red-team surface that matches what the change actually ships.
7. The executor QA/red-team lane must report a matrix using `executorQa.contractCoverage`, `executorQa.surfaceEvidence`, `executorQa.adversarialCases`, and `executorQa.artifactRefs`. Not-applicable rows are allowed only in `contractCoverage` and `surfaceEvidence`; each `status: "not_applicable"` row requires `contractRef` plus `reason`. `adversarialCases` rows cannot be not-applicable.
8. Run a final code review pass and fold it into the strict quality gate. Clean means `architectReview.architectureStatus`, `architectReview.productStatus`, and `architectReview.codeStatus` are all `"CLEAR"`, `architectReview.recommendation` is `"APPROVE"`, executor QA statuses are `"passed"`, iteration is `"passed"` with `fullRerun: true`, every evidence field is non-empty, every required matrix row is present, and every blockers array is empty. `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, missing evidence, missing or shallow matrix rows, plan/code mismatches, or non-empty blockers are non-clean.
9. If any lane finds an issue, do **not** checkpoint `complete` and do **not** call `goal({"op":"complete"})`. Record durable blocker work instead:
   ```sh
   gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve verification blockers" --objective "<blocker-resolution objective>" --evidence "<architect/executor findings>"
   ```
10. Complete or steer through the blocker story, then rerun the full blocking verification loop. Repeat until all verifier lanes are clean.
11. Only after the loop is clean, checkpoint the story as complete with a structured quality gate. The checkpoint creates a receipt in `ledger.jsonl`; `goals.json.status` alone is not proof. In aggregate mode, the final aggregate receipt must exist before the agent calls `goal({"op":"complete"})` to reconcile the inline UX goal state.

While an Ultragoal run is active, the `ask` tool is blocked for all agents. Record unresolved review decisions as durable blockers with `gjc ultragoal record-review-blockers` instead of prompting interactively.

The native `checkpoint --status complete` command rejects missing or shallow gates. `--quality-gate-json` must include:

```json
{
  "architectReview": {
    "architectureStatus": "CLEAR",
    "productStatus": "CLEAR",
    "codeStatus": "CLEAR",
    "recommendation": "APPROVE",
    "evidence": "architect review synthesis across architecture/product/code",
    "commands": ["architect review command or agent evidence id"],
    "blockers": []
  },
  "executorQa": {
    "status": "passed",
    "e2eStatus": "passed",
    "redTeamStatus": "passed",
    "evidence": "executor-built e2e and red-team QA commands/results",
    "e2eCommands": ["bun test:e2e"],
    "redTeamCommands": ["bun test:red-team"],
    "artifactRefs": [
      { "id": "<ref-id>", "kind": "<surface-appropriate kind; see step 6>", "path": "artifacts/<file>", "description": "live-surface evidence" }
    ],
    "contractCoverage": [
      { "id": "<id>", "contractRef": "<approved contract id>", "obligation": "<required behavior>", "status": "covered", "surfaceEvidenceRefs": ["<surface-id>"], "adversarialCaseRefs": ["<case-id>"] }
    ],
    "surfaceEvidence": [
      { "id": "<surface-id>", "contractRef": "<surface under test>", "surface": "gui|web|cli|api|package|algorithm|math|native|desktop|tui", "invocation": "<real invocation>", "verdict": "passed", "artifactRefs": ["<ref-id>"] }
    ],
    "adversarialCases": [
      { "id": "<case-id>", "contractRef": "<approved contract id>", "scenario": "<boundary/adversarial input>", "expectedBehavior": "<required handling>", "verdict": "passed", "artifactRefs": ["<ref-id>"] }
    ],
    "blockers": []
  },
  "iteration": {
    "status": "passed",
    "evidence": "blockers absent or resolved and the full loop was rerun cleanly",
    "fullRerun": true,
    "rerunCommands": ["bun test:e2e", "bun test:red-team"],
    "blockers": []
  }
}
```

Provide one `artifactRefs` entry per live surface actually exercised, using the surface-appropriate `kind` and evidence rules from steps 6–7 above; the CLI rejects missing or shallow gates. `status: "not_applicable"` rows are allowed only in `contractCoverage` and `surfaceEvidence` and each requires `contractRef` plus `reason`.

For CLI replay artifacts, the JSON at `path` must be an object like `{"schemaVersion":1,"kind":"cli-replay","replaySafe":true,"command":["bun","-e","console.log(\"ultragoal-cli-ok\")"],"cwd":".","env":{"LC_ALL":"C"},"timeoutMs":30000,"expectedExitCode":0,"recordedStdout":"ultragoal-cli-ok\n","recordedStderr":"","invariants":[{"type":"substring","value":"ultragoal-cli-ok"},{"type":"not-substring","value":"error"}]}`. Accepted replay fields are `command` (string array), optional `cwd`, safe `env`, `timeoutMs`, `expectedExitCode`, `recordedStdout`, `recordedStderr`, `normalization`, and `invariants`. The conservative command allowlist is intentionally small: `bun --version`, `node --version`, deterministic `bun/node -e "console.log(...)"`, `npm|pnpm|yarn --version`, `npm|pnpm|yarn list`, read-only `git status|rev-parse|merge-base|diff|show|log` with safe args, and `gjc read|status`. `env` must contain only safe deterministic variables, never credentials or machine/user-specific secrets. `normalization` is optional and, when provided, must be exactly the string `"default"` (the built-in normalizer already strips ANSI codes, normalizes line endings, scrubs paths, and trims trailing whitespace); object-shaped normalization is rejected. Invariants may be substring, regex, or not-substring checks; when present, they replace exact `recordedStdout` equality — without `invariants`, replayed normalized stdout must match `recordedStdout` exactly. Unsafe, non-deterministic, credentialed, interactive, or otherwise unallowlisted commands require audited `replayExempt` metadata with exact fields `reasonCode`, `reason`, `approvedBy`, and `fallbackArtifactRefs` plus a structurally valid same-surface fallback artifact. `reason` must be substantive and audited, and `approvedBy` must identify the verifier. Allowed `reasonCode` values are exactly `unsafe_side_effect`, `requires_credentials`, `requires_network`, `non_deterministic_external`, `destructive`, `interactive_only`, and `platform_unavailable`.

## Review mode

`gjc ultragoal review` runs the same hardened gate against an already implemented PR, branch, or worktree. Use `--pr <number>` for a PR, `--branch <ref>` for a branch diff, omit both for the current worktree, and pass `--spec <path>` when a real contract exists. `--mode review-only` emits the verdict/findings without creating fix work; `--mode review-start` records review blockers for follow-up. Review mode validates the same `executorQa` shape and live-surface artifacts as `checkpoint --status complete`. A thin or derived-only contract can never clean-pass: the verdict is capped at `inconclusive: weak-contract` until a supplied spec or equivalent strong acceptance criteria are available.

Receipts are freshness-scoped:
- Per-goal receipts remain fresh for their target goal unless that goal, its blocker metadata, or its supersession metadata changes.
- Normal later `goal_started` or clean receipt-backed `goal_checkpointed` events for other goals do not stale older per-goal receipts.
- Appending required goals or changing final required-goal state stales final aggregate receipts. Final aggregate completion requires a fresh final aggregate receipt proving no incomplete, blocked, or `review_blocked` required goals remain.
- Deferred per-goal receipts (validation-batch members) are incomplete until a matching fresh batch-close receipt exists on the batch's `finalGoalId`; a story-scope query for a deferred member stays blocked until that close, and mutating a member after close stales the batch-close and final aggregate receipts.

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
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
