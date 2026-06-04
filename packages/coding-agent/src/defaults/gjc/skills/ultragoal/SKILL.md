---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.

source: "forked from upstream ultragoal skill and rebranded for GJC"
---

# Ultragoal Workflow

Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`, durable multi-goal planning, or sequential execution over GJC goal mode.

## Purpose

`ultragoal` turns a brief into repo-native artifacts and then drives a GJC goal safely through the unified `goal` tool. New plans default to a stable pointer-style aggregate GJC goal for the whole durable plan in `.gjc/ultragoal/goals.json`, including later accepted/appended stories under the original brief constraints, while GJC tracks G001/G002 story progress in the ledger. Ultragoal does not require any `/goal` slash-command between runs. For back-to-back ultragoal runs in one session/thread, call `goal({"op":"drop"})` only when `goal({"op":"get"})` still reports an active aggregate; then call `goal({"op":"create"})`. The goal tool stays armed across drop so the next create works in-session, and no slash-command cleanup exists or is required.

- `.gjc/ultragoal/brief.md`
- `.gjc/ultragoal/goals.json`
- `.gjc/ultragoal/ledger.jsonl` (checkpoint and structured steering audit events)

Existing aggregate plans with the legacy enumerated objective are migrated to the stable pointer objective on read, persisted to `goals.json`, retained in `gjcObjectiveAliases` for already-active hidden goal reconciliation, and audited with an `aggregate_objective_migrated` ledger entry.

## Always-used command examples

Use these exact `gjc ultragoal` commands before spending tool calls rediscovering syntax:

```sh
gjc ultragoal status
gjc ultragoal status --json
gjc ultragoal create-goals --brief "<brief>"
gjc ultragoal create-goals --brief-file <path>
gjc ultragoal complete-goals
gjc ultragoal complete-goals --retry-failed
gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --gjc-goal-json <goal-get-json-or-path> --quality-gate-json <quality-gate-json-or-path>
gjc ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"
gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve final review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --gjc-goal-json <active-goal-get-json-or-path>
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

Use `goal({"op":"get"})` snapshots inside Ultragoal for ledger reconciliation. The unified `goal` tool is the only agent-facing surface for goal state; no `/goal` subcommand is required.

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
3. Inspect `.gjc/ultragoal/goals.json` and refine if needed.

## Complete goals

Loop until `gjc ultragoal status` reports all goals complete:

1. Run `gjc ultragoal complete-goals`.
2. Read the printed handoff.
3. Call `goal({"op":"get"})`.
4. If no active GJC goal exists, call `goal({"op":"create","objective":"<printed payload objective>"})` with the printed payload. In aggregate mode, if the same aggregate objective is already active, continue the current GJC story without creating a new GJC goal. If `goal({"op":"get"})` shows a stale dropped goal (status `"dropped"`) and a new aggregate must start, no extra cleanup is needed — `goal({"op":"create"})` succeeds directly. If a previous aggregate is still active and you genuinely need a fresh start in the same session, call `goal({"op":"drop"})` first, then `goal({"op":"create"})`.
5. Complete the current GJC story only.
6. Run a completion audit against the story objective and real artifacts/tests.
7. Before any `--status complete` checkpoint, run the mandatory final cleanup/review gate below. In aggregate mode, do **not** call `goal({"op":"complete"})` for intermediate stories; checkpoint each story with a fresh `goal({"op":"get"})` snapshot whose aggregate objective is still `active`. On the final story, use the same fresh active snapshot to create the final aggregate receipt first; only after that receipt exists may `goal({"op":"complete"})` run.
8. Checkpoint the durable ledger with that fresh active snapshot. Complete checkpoints require `--quality-gate-json`; the runtime hook rejects closure without a clean architect review:
   `gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --gjc-goal-json <goal-get-json-or-path> --quality-gate-json <quality-gate-json-or-path>`
9. If blocked or failed, checkpoint failure:
   `gjc ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
11. For legacy per-story completed-goal blockers, preserve the non-terminal blocker with:
   `gjc ultragoal checkpoint --goal-id <id> --status blocked --evidence "<completed legacy GJC goal blocks goal create in this thread>" --gjc-goal-json <goal-get-json-or-path>`
12. Resume failed goals with `gjc ultragoal complete-goals --retry-failed`.

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
gjc ultragoal steer --directive-json ./steering.json --json
```

Steering invariants:

- Do not edit the aggregate goal objective, original brief constraints, quality gates, or completion status. The aggregate objective is a stable pointer to `.gjc/ultragoal/goals.json` and `.gjc/ultragoal/ledger.jsonl`, not an enumeration of initial goal ids.
- Do not hard-delete goals, auto-complete work, weaken verification, or silently mutate `.gjc/ultragoal`.
- Accepted and rejected attempts append structured audit entries to `.gjc/ultragoal/ledger.jsonl`.
- Superseded goals remain in `goals.json` with steering metadata and are skipped for scheduling.
- Blocked goals without replacements are skipped for scheduling but still block final completion until later explicit steering replaces or supersedes them.

UserPromptSubmit uses the same steering API only for structured directives such as `GJC_ULTRAGOAL_STEER: { ... }`, `gjc.ultragoal.steer: { ... }`, or `gjc ultragoal steer: { ... }`. Normal prose does not mutate state, and repeated prompt-submit directives dedupe by prompt signature or idempotency key.

## Role-agent delegation guidance

Ultragoal execution should use GJC's bundled role-agent roster when a durable story is large enough to benefit from delegation:

- Use `executor` for bounded implementation, refactoring, and fix slices.
- Use `planner` for story sequencing or handoff refinement when execution uncovers a missing plan branch.
- Use `architect` for read-only architecture and code-review lanes, including `CLEAR` / `WATCH` / `BLOCK` status.
- Use `critic` for read-only plan or handoff critique before execution proceeds.

When delegating with native subagents, an await timeout only limits the leader's wait. It is not subagent failure evidence and must not be used as a cancellation reason; inspect or continue independent work, and cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong.

If an Ultragoal request has no approved plan or consensus artifact, run `ralplan` first and preserve its PRD, test spec, role roster, and verification guidance in the Ultragoal ledger. Do not silently substitute ad-hoc execution for missing planning.

The Ultragoal leader owns `.gjc/ultragoal/goals.json` and `.gjc/ultragoal/ledger.jsonl`. Role agents return implementation/review evidence; they do not checkpoint Ultragoal or mutate goal state.

For large subgoals with independent slices, the Ultragoal leader must spawn parallel `executor` subagents instead of doing serial solo work. Split only cleanly separable files/surfaces, give each executor bounded targets and acceptance criteria, and keep checkpoint ownership in the leader. Use `architect` / `critic` review lanes after integration; do not let worker agents mutate `.gjc/ultragoal` or call goal tools.

## Use Ultragoal and Team together

Use ultragoal and team together for a durable Ultragoal story that benefits from one visible tmux worker session. Ultragoal remains leader-owned: `.gjc/ultragoal/goals.json` stores the story plan and `.gjc/ultragoal/ledger.jsonl` stores checkpoints. Team is the single-worker tmux execution engine and returns task/evidence status to the leader.

The leader checkpoints Ultragoal from Team evidence with a fresh `goal({"op":"get"})` snapshot:

```sh
gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .gjc/ultragoal and <id>>" --gjc-goal-json <fresh-goal-get-json-or-path> --quality-gate-json <quality-gate-json-or-path>
```

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Workers must not run `gjc ultragoal checkpoint`; checkpoint authority stays with the leader after worker tasks are terminal. Team launch remains explicit; Ultragoal does not auto-launch Team and performs no hidden goal mutation.

## Mandatory completion cleanup and review gate

An ultragoal story cannot be checkpointed `complete` until the active agent has run the quality gate. The gate is plan-first, contract-driven, and surface-based:

1. Run targeted implementation verification for the story.
2. Run a cleanup/refactor review pass on changed files only; if there are no relevant edits, the cleaner still runs and records a passed/no-op report.
3. Rerun verification after the cleaner pass.
4. Delegate an `architect` review covering all three lanes:
   - architecture-side: system boundaries, layering, data/control flow, operational risks.
   - product-side: user-visible behavior, acceptance criteria, edge cases, regressions.
   - code-side: maintainability, tests, integration points, and unsafe shortcuts.
5. Delegate an `executor` QA/red-team lane to build and run the e2e/read-teaming QA suite appropriate for the story. This lane must try to break the change, not just confirm the happy path. It must start from the approved plan/spec/acceptance criteria, then user-facing contracts, and only then implementation code as supporting evidence. Plan/code mismatches are blockers, not items to paper over with implementation intent.
6. The executor QA/red-team lane must prove evidence by the real surface under test:
   - GUI/web surfaces require browser automation plus a screenshot or image verdict.
   - CLI surfaces require logs or terminal transcripts from real invocation.
   - API/package surfaces require external consumer or black-box tests through the public interface.
   - Algorithm/math surfaces require boundary, property, adversarial, and failure-mode cases.
7. The executor QA/red-team lane must report a matrix using `executorQa.contractCoverage`, `executorQa.surfaceEvidence`, `executorQa.adversarialCases`, and `executorQa.artifactRefs`. Not-applicable rows are allowed only in `contractCoverage` and `surfaceEvidence`; each `status: "not_applicable"` row requires `contractRef` plus `reason`. `adversarialCases` rows cannot be not-applicable.
8. Run a final code review pass and fold it into the strict quality gate. Clean means `architectReview.architectureStatus`, `architectReview.productStatus`, and `architectReview.codeStatus` are all `"CLEAR"`, `architectReview.recommendation` is `"APPROVE"`, executor QA statuses are `"passed"`, iteration is `"passed"` with `fullRerun: true`, every evidence field is non-empty, every required matrix row is present, and every blockers array is empty. `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, missing evidence, missing or shallow matrix rows, plan/code mismatches, or non-empty blockers are non-clean.
9. If any lane finds an issue, do **not** checkpoint `complete` and do **not** call `goal({"op":"complete"})`. Record durable blocker work instead:
   ```sh
   gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve verification blockers" --objective "<blocker-resolution objective>" --evidence "<architect/executor findings>" --gjc-goal-json <active-goal-get-json-or-path>
   ```
10. Complete or steer through the blocker story, then rerun the full blocking verification loop. Repeat until all verifier lanes are clean.
11. Only after the loop is clean, checkpoint the story as complete with a structured quality gate and a fresh active `goal({"op":"get"})` snapshot. The checkpoint creates a receipt; `goals.json.status` alone is not proof. In aggregate mode, the final aggregate receipt must exist before `goal({"op":"complete"})` is allowed.

The native `checkpoint --status complete` command rejects missing or shallow gates. `--quality-gate-json` must include:

```json
{
  "architectReview": {
    "architectureStatus": "CLEAR",
    "productStatus": "CLEAR",
    "codeStatus": "CLEAR",
    "recommendation": "APPROVE",
    "evidence": "architect review synthesis with architecture/product/code coverage",
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
      {
        "id": "browser-run",
        "kind": "browser-automation",
        "path": "artifacts/browser-run.json",
        "description": "browser automation transcript invoking the approved user-facing flow"
      },
      {
        "id": "gui-screenshot",
        "kind": "screenshot",
        "path": "artifacts/gui-screenshot.png",
        "description": "screenshot or image-verdict evidence for the GUI/web result"
      },
      {
        "id": "adversarial-report",
        "kind": "failure-mode-test",
        "path": "artifacts/adversarial-report.txt",
        "description": "boundary, property, adversarial, or failure-mode result"
      }
    ],
    "contractCoverage": [
      {
        "id": "contract-goal",
        "contractRef": "approved plan/spec/acceptance criterion or user-facing contract id",
        "obligation": "required behavior from the approved contract",
        "status": "covered",
        "surfaceEvidenceRefs": ["surface-gui"],
        "adversarialCaseRefs": ["case-invalid-input"]
      },
      {
        "id": "contract-out-of-scope",
        "contractRef": "contract intentionally outside this story",
        "obligation": "explicitly omitted approved-contract surface",
        "status": "not_applicable",
        "reason": "why this contract does not apply to the current story"
      }
    ],
    "surfaceEvidence": [
      {
        "id": "surface-gui",
        "contractRef": "user-facing surface or public interface under test",
        "surface": "gui|web|cli|api|package|algorithm|math",
        "invocation": "real browser action, CLI command, API/package consumer call, or algorithm/property check",
        "verdict": "passed",
        "artifactRefs": ["browser-run", "gui-screenshot"]
      },
      {
        "id": "surface-out-of-scope",
        "contractRef": "surface intentionally outside this story",
        "surface": "gui|web|cli|api|package|algorithm|math",
        "status": "not_applicable",
        "reason": "why this surface does not apply to the current story"
      }
    ],
    "adversarialCases": [
      {
        "id": "case-invalid-input",
        "contractRef": "approved plan/spec/acceptance criterion or user-facing contract id",
        "scenario": "boundary/property/adversarial/failure-mode input or user action",
        "expectedBehavior": "contract-required rejection, handling, or invariant preservation",
        "verdict": "passed",
        "artifactRefs": ["adversarial-report"]
      }
    ],
    "blockers": []
  },
  "iteration": {
    "status": "passed",
    "evidence": "blockers were absent or resolved and the full verification loop was rerun cleanly",
    "fullRerun": true,
    "rerunCommands": ["bun test:e2e", "bun test:red-team"],
    "blockers": []
  }
}
```

Receipts are freshness-scoped:
- Per-goal receipts remain fresh for their target goal unless that goal, its blocker metadata, or its supersession metadata changes.
- Normal later `goal_started` or clean receipt-backed `goal_checkpointed` events for other goals do not stale older per-goal receipts.
- Appending required goals or changing final required-goal state stales final aggregate receipts. Final aggregate completion requires a fresh final aggregate receipt proving no incomplete, blocked, or `review_blocked` required goals remain.

## Handoff back to planning

When the aggregate ultragoal is complete OR the user requests return to planning/clarification, mark ultragoal ready for handoff so the skill tool's chain guard permits the backward transition:

```
gjc state ultragoal write --input '{"current_phase":"handoff"}' --json
```

The skill tool then dispatches `/skill:ralplan` or `/skill:deep-interview` same-turn and runs `gjc state ultragoal handoff --to <ralplan|deep-interview> --json` in-process to atomically demote ultragoal, promote the callee, and sync both `skill-active-state.json` files. You do not need to run the handoff verb yourself.

## Constraints

- The shell command emits a model-facing handoff for the active GJC agent; it does not invoke any `/goal` slash-command and the agent loop must not depend on any `/goal` subcommand.
- Use only the unified goal-tool surface from the agent loop: `goal({"op":"get"})`, `goal({"op":"create"})`, `goal({"op":"complete"})`, `goal({"op":"drop"})`, `goal({"op":"resume"})`. `drop` clears the active goal without exiting goal mode so the next `goal({"op":"create"})` works in-session. No slash-command cleanup exists or is required; Ultragoal never calls any `/goal` subcommand.
- For back-to-back ultragoal runs in the same session/thread, when `goal({"op":"get"})` still reports an active aggregate, call `goal({"op":"drop"})` before `goal({"op":"create"})`; when no active goal exists or the prior aggregate is already complete or dropped, call `goal({"op":"create"})` directly. The goal tool remains callable across drop; no slash-command cleanup exists or is required.
- Never call `goal({"op":"create"})` when `goal({"op":"get"})` reports a different active goal.
- Never call `goal({"op":"complete"})` unless the aggregate run or legacy per-story goal is actually complete.
- In aggregate mode, intermediate and final story checkpoints require a matching `active` GJC goal snapshot; the final story checkpoint creates the final aggregate receipt before `goal({"op":"complete"})` may reconcile the inline goal state.
- Completion checkpoints require read-only goal snapshot reconciliation: pass fresh `goal({"op":"get"})` JSON/path with `--gjc-goal-json`; shell commands and hooks must not mutate goal state.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
