---
name: ralplan
description: Consensus planning entrypoint that auto-gates vague team/ultragoal requests before execution
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

- `--interactive`: Enables user prompts at key decision points (draft review in step 2 and final approval in step 6). Without this flag the workflow runs fully automated — Planner → Architect → Critic loop — marks the final plan `pending approval`, outputs it, and stops without asking for confirmation or executing changes.
- `--deliberate`: Forces deliberate mode for high-risk work. Adds pre-mortem (3 scenarios) and expanded test planning (unit/integration/e2e/observability). Without this flag, deliberate mode can still auto-enable when the request explicitly signals high risk (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage).
- `--architect openai-code`: Use OpenAI code for the Architect pass when OpenAI code CLI is available. Otherwise, briefly note the fallback and keep the default GJC Architect review.
- `--critic openai-code`: Use OpenAI code for the Critic pass when OpenAI code CLI is available. Otherwise, briefly note the fallback and keep the default GJC Critic review.
- `--write --stage <type> --stage_n <N> --artifact <markdown file path or markdown string>`: Native artifact write path persisting Planner, Architect, Critic, revision, ADR, and final pending-approval plan markdown under `.gjc/plans/ralplan/<run-id>/`. Use this instead of editing `.gjc/` files directly.

## Usage with interactive mode

```
/skill:ralplan --interactive "task description"
```

## Behavior

## Planning/Execution Boundary

Ralplan is a planning module. It may inspect context and draft or update plan/spec/proposal artifacts, but it MUST mark those artifacts as `pending approval` unless the user has explicitly opted into execution in the current turn or via the structured approval UI. Before explicit execution approval, it MUST NOT run mutation-oriented shell commands, edit source files, commit, push, open PRs, invoke execution skills, or delegate implementation tasks.

Planning artifacts and stage handoffs MUST be persisted through the ralplan CLI artifact writer, not by direct `.gjc/` edits. Every role agent or subagent that produces a durable stage artifact MUST write it with:

```bash
gjc ralplan --write --stage <type> --stage_n <N> --artifact "markdown file path or markdown string"
```

Use stage values that match the producer or artifact kind, such as `planner`, `architect`, `critic`, `revision`, `adr`, or `final`. Increment `--stage_n` for each consensus-loop pass. The `--artifact` value may be either a markdown file path prepared outside `.gjc/` for ingestion or the markdown content string itself. The native `--write` handler persists markdown under `.gjc/plans/ralplan/<run-id>/stage-<NN>-<stage>.md`, maintains an `index.jsonl` audit log, and for `final` stages additionally writes a `pending-approval.md` copy. Direct `write`, `edit`, or `ast_edit` calls against `.gjc/specs`, `.gjc/plans`, `.gjc/state`, or any other `.gjc/` path are forbidden unless an explicit force override is active.

Restricted read-only role agents (`planner`, `architect`, and `critic`) must pass markdown content directly in `--artifact`; their restricted bash environment intentionally disables artifact file-path ingestion so a verdict command cannot persist arbitrary file contents.

After a role agent persists a stage artifact, its model-facing response to the caller SHOULD be receipt-only: return the `gjc ralplan --write --json` receipt (`run_id`, `path`, `stage`, `stage_n`, `sha256`, `created_at`) plus the minimal verdict/status fields the caller needs for routing, and do **not** paste the full persisted markdown back into the parent conversation. Downstream reviewers should receive the artifact path/receipt and read the persisted file themselves when they actually need the body. This preserves the audit trail while preventing Planner/Architect/Critic verdict bodies from being duplicated into the main-agent context.

RECEIPT-ONLY guideline: role agents (`planner`, `architect`, and `critic`) persist durable outputs via `gjc ralplan --write` and return ONLY the receipt fields (`run_id`, `path`, `sha256`) plus verdict/status routing fields; include `stage` and `stage_n` when available, and never return the full persisted body.

This skill runs GJC planning in consensus mode for the provided arguments.

The consensus workflow:
1. **Planner** creates the initial plan and a compact **RALPLAN-DR summary** before review. Launch the Planner ONCE per run as a detached, resumable subagent (await it before the Architect) and record its returned subagent id as the run's persisted Planner id; persist the stage with `gjc ralplan --write --stage planner --stage_n 1 --artifact "..." --planner-id <id> --planner-resumable <true|false>` (see **Persisted Planner** below):
   - After persistence, return only the receipt/path plus compact planning status; do not paste the full plan markdown back to the caller unless explicitly requested.
   - Principles (3-5)
   - Decision Drivers (top 3)
   - Viable Options (>=2) with bounded pros/cons
   - If only one viable option remains, explicit invalidation rationale for alternatives
   - Deliberate mode only: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)
2. **User feedback** *(--interactive only)*: If `--interactive` is set, use the `ask` tool to present the draft plan **plus the Principles / Drivers / Options summary** before review (Proceed to review / Request changes / Skip review). Otherwise, automatically proceed to review.
3. **Architect** reviews for architectural soundness and must provide the strongest steelman antithesis, at least one real tradeoff tension, and (when possible) synthesis — **await completion before step 4**. In deliberate mode, Architect should explicitly flag principle violations.
   - The Architect agent/subagent must persist its review with `gjc ralplan --write --stage architect --stage_n <N> --artifact "..." --json`, then return the receipt/path plus compact verdict/status (`CLEAR`/`WATCH`/`BLOCK`, `APPROVE`/`COMMENT`/`REQUEST CHANGES`) instead of pasting the full review body.
4. **Critic** evaluates against quality criteria — run only after step 3 completes. Critic must enforce principle-option consistency, fair alternatives, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. In deliberate mode, Critic must reject missing/weak pre-mortem or expanded test plan.
   - The Critic agent/subagent must persist its evaluation with `gjc ralplan --write --stage critic --stage_n <N> --artifact "..." --json`, then return the receipt/path plus compact verdict/status (`OKAY`/`ITERATE`/`REJECT`) instead of pasting the full evaluation body.
5. **Re-review loop** (max 5 iterations): Any non-`APPROVE` Critic verdict (`ITERATE` or `REJECT`) MUST run the same full closed loop:
   a. Collect Architect + Critic feedback
   b. Revise the plan by resuming the SAME persisted Planner subagent with consolidated Architect + Critic feedback (see **Persisted Planner** below); fall back to a fresh Planner spawn only per the fallback routing table
   c. Return to Architect review
      - Persist each Planner revision with `gjc ralplan --write --stage revision --stage_n <N> --artifact "..." --json` before re-review, then pass the receipt/path forward instead of duplicating the full revision markdown in the parent conversation.
   d. Return to Critic evaluation
   e. Repeat this loop until Critic returns `APPROVE` or 5 iterations are reached
   f. If 5 iterations are reached without `APPROVE`, present the best version to the user
6. On Critic approval, mark the plan `pending approval` unless explicit execution approval has already been captured, persist the ADR/final plan via `gjc ralplan --write --stage final --stage_n <N> --artifact "..."`, and do not directly edit `.gjc/plans`. *(--interactive only)* If `--interactive` is set, use the `ask` tool to present the plan with approval options (Approve execution via ultragoal (Recommended) / Approve execution via team (only when tmux-based interactive worker parallelization is required) / Compact then return for execution approval / Request changes / Reject). Final plan must include ADR (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups). Otherwise, output the final plan and stop before any mutation or delegation.
7. *(--interactive only)* User chooses: Approve ultragoal execution (recommended), Approve team execution (tmux parallelization only), Request changes, or Reject
8. *(--interactive only)* On approval: invoke `/skill:ultragoal` for execution by default; invoke `/skill:team` only when the user explicitly needs tmux-based interactive worker parallelization -- never implement directly

   Before invoking `/skill:team` or `/skill:ultragoal`, mark ralplan ready for handoff so the skill tool's chain guard permits the transition:

   ```
   gjc state ralplan write --input '{"current_phase":"handoff"}' --json
   ```

   The skill tool then dispatches the execution skill same-turn and runs `gjc state ralplan handoff --to <team|ultragoal> --json` in-process to atomically demote ralplan, promote the callee, and sync both `skill-active-state.json` files. You do not need to run the handoff verb yourself.

> **Important:** Steps 3 and 4 MUST run sequentially. Do NOT issue both agent Task calls in the same parallel batch. Always await the Architect result before issuing the Critic Task.

Follow the Plan skill's full documentation for consensus mode details.

### Persisted Planner (consensus loop)

The Planner is a **same-session persisted subagent**: launched detached once, awaited before the Architect, then **resumed** with consolidated Architect + Critic feedback on every re-review pass instead of being re-spawned. The Architect and Critic stay **fresh, independent spawns each pass** so their verdicts remain reproducible from their pass artifacts alone. Do NOT modify the subagent control surface; this orchestration uses the existing `subagent` resume/steer controls only.

**Persistence boundary:** this is same-parent, active-session continuity only. Resumability depends on the manager's retained subagent resume metadata and a persistent parent session (an in-memory parent yields `resumable:false`), not just the `.gjc` run-state record. A terminal subagent whose live job record was evicted can still be resumed when its retained resume descriptor points at a saved subagent session file. After a process restart, missing resume metadata, or any unavailable/failed resume, use the fresh Planner fallback.

**Resume routing table** (per re-review pass, when resuming the persisted Planner id):

| Resume outcome | Action |
|---|---|
| `running` | `steer`/inject the consolidated feedback to the same id, then await — do NOT fresh-spawn |
| `queued` | retain/update the queued message or await the same id — do NOT fresh-spawn just because it is queued |
| `context_unavailable`, `not_found`, `no_runner`, `resume_failed` | fresh Planner spawn for that pass; record the fallback metadata. `not_found` should only mean same-session resume metadata is unavailable, not merely that a terminal live job was evicted. |
| terminal (`completed`/`failed`/`cancelled`) + revision message | resume the same id when context is available; otherwise use the fresh fallback above |

**Recording persisted-Planner metadata** (audit/routing only — never claim `subagent list` proves resumability, since the snapshot does not expose `resumable`). Ride these optional flags on the normal `--write` for the planner/revision stage of the pass:

```
gjc ralplan --write --stage revision --stage_n <N> --artifact "..." \
  --planner-id <id> --planner-resumable <true|false> \
  --fallback-reason <context_unavailable|not_found|no_runner|resume_failed|process_restart|missing_record> \
  --fallback-attempted-id <id> --fallback-stage-n <N> \
  --fallback-receipt-path <fresh-planner-stage-artifact-path> --json
```

Set `--planner-resumable true` only when the parent session is provably persistent; set/record `false` after an observed `context_unavailable`; otherwise omit it (unknown). Fallback flags are recorded only when a fresh-spawn fallback actually occurs: a fallback record requires `--fallback-reason` **together with** `--fallback-attempted-id` and `--fallback-stage-n` (the failed id and the pass it failed on), while `--fallback-receipt-path` (the fresh Planner's stage artifact) is optional.

## Pre-Execution Gate

### Why the Gate Exists

Execution skills (`ultragoal` and `team`) drive implementation rather than scope discovery. When launched on a vague request like "team improve the app", agents have no clear target — they waste cycles on scope discovery that should happen during planning, often delivering partial or misaligned work that requires rework.

The ralplan-first gate intercepts underspecified execution requests and redirects them through the ralplan consensus planning workflow. This ensures:
- **Explicit scope**: A PRD defines exactly what will be built
- **Test specification**: Acceptance criteria are testable before code is written
- **Consensus**: Planner, Architect, and Critic agree on the approach
- **No wasted execution**: Agents start with a clear, bounded task

### Good vs Bad Prompts

**Passes the gate** (specific enough for direct execution):
- `team fix the null check in src/hooks/bridge.ts:326`
- `team implement issue #42`
- `team add validation to function processKeywordDetector`
- `team do:\n1. Add input validation\n2. Write tests\n3. Update README`
- `team add the user model in src/models/user.ts`

**Gated — redirected to ralplan** (needs scoping first):
- `team fix this`
- `team build the app`
- `team improve performance`
- `team add authentication`
- `team make it better`

**Bypass the gate** (when you know what you want):
- `force: team refactor the auth module`
- `! team optimize everything`

### When the Gate Does NOT Trigger

The gate auto-passes when it detects **any** concrete signal. You do not need all of them — one is enough:

| Signal Type | Example prompt | Why it passes |
|---|---|---|
| File path | `team fix src/hooks/bridge.ts` | References a specific file |
| Issue/PR number | `team implement #42` | Has a concrete work item |
| camelCase symbol | `team fix processKeywordDetector` | Names a specific function |
| PascalCase symbol | `team update UserModel` | Names a specific class |
| snake_case symbol | `team fix user_model` | Names a specific identifier |
| Test runner | `team npm test && fix failures` | Has an explicit test target |
| Numbered steps | `team do:\n1. Add X\n2. Test Y` | Structured deliverables |
| Acceptance criteria | `team add login - acceptance criteria: ...` | Explicit success definition |
| Error reference | `team fix TypeError in auth` | Specific error to address |
| Code block | `team add: \`\`\`ts ... \`\`\`` | Concrete code provided |
| Escape prefix | `force: team do it` or `! team do it` | Explicit user override |

### End-to-End Flow Example

1. User types: `team add user authentication`
2. Gate detects: execution keyword (`team`) + underspecified prompt (no files, functions, or test spec)
3. Gate redirects to **ralplan** with message explaining the redirect
4. Ralplan consensus runs:
   - **Planner** creates initial plan (which files, what auth method, what tests)
   - **Architect** reviews for soundness
   - **Critic** validates quality and testability
5. On consensus approval, user chooses execution path:
   - **ultragoal**: goal-tracked autonomous execution with verification (recommended default)
   - **team**: N coordinated parallel agents in tmux — only when tmux-based interactive worker parallelization is required
6. Execution begins with a clear, bounded plan

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Gate fires on a well-specified prompt | Add a file reference, function name, or issue number to anchor the request |
| Want to bypass the gate | Prefix with `force:` or `!` (e.g., `force: team fix it`) |
| Gate does not fire on a vague prompt | The gate only catches prompts with <=15 effective words and no concrete anchors; add more detail or use `/skill:ralplan` explicitly |
| Redirected to ralplan but want execution | Use the structured approval option or explicitly say which execution skill should proceed; `just do it` / `skip planning` alone only ends planning with a `pending approval` artifact |
