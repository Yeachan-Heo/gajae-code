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

- `--interactive`: Enables extra mid-loop user prompts (draft review in step 2 and one-at-a-time reconciliation in step 6c). Regardless of this flag, the workflow always finishes the post-interview gate with an `ask`-tool prompt offering Refine further / Approve ultragoal / Approve team / Stop here, and never auto-executes — execution always requires explicit approval through that prompt.
- `--deliberate`: Forces deliberate mode for high-risk work. Adds pre-mortem (3 scenarios) and expanded test planning (unit/integration/e2e/observability). Without this flag, deliberate mode can still auto-enable when the request explicitly signals high risk (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage).
- `--architect openai-code`: Use OpenAI code for the Architect pass when OpenAI code CLI is available. Otherwise, briefly note the fallback and keep the default GJC Architect review.
- `--critic openai-code`: Use OpenAI code for the Critic pass when OpenAI code CLI is available. Otherwise, briefly note the fallback and keep the default GJC Critic review.
- `--write --stage <type> --stage_n <N> --artifact <markdown file path or markdown string>`: Native artifact write path persisting Planner, Architect, Critic, revision, ADR, and final pending-approval plan markdown under `.gjc/_session-{sessionid}/plans/ralplan/<run-id>/`. Use this instead of editing `.gjc/` files directly.

## Usage with interactive mode

```
/skill:ralplan --interactive "task description"
```

## Corrupt current-session state recovery

When ralplan detects its own current-session state is corrupt, tampered, unreadable, or stale on resume, run `gjc state clear --force --mode ralplan` before reseeding or restarting. Scope the clear to the current session via `--session-id`, the command payload, or `GJC_SESSION_ID`; it clears only ralplan state for that session and never clears other skills or sessions.

## Behavior

## Planning/Execution Boundary

Ralplan is a planning module. It may inspect context and draft or update plan/spec/proposal artifacts, but it MUST mark those artifacts as `pending approval` unless the user has explicitly opted into execution in the current turn or via the structured approval UI. Before explicit execution approval, it MUST NOT run mutation-oriented shell commands, edit source files, commit, push, open PRs, invoke execution skills, or delegate implementation tasks.

Planning artifacts and stage handoffs MUST be persisted through the ralplan CLI artifact writer, not by direct `.gjc/` edits. Every role agent or subagent that produces a durable stage artifact MUST write it with:

```bash
gjc ralplan --write --stage <type> --stage_n <N> --artifact "markdown file path or markdown string"
# restricted role agents use:
gjc ralplan --write --stage <type> --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT
```

Use stage values that match the producer or artifact kind, such as `planner`, `architect`, `critic`, `revision`, `post-interview`, `adr`, or `final`. Increment `--stage_n` for each consensus-loop pass. The `--artifact` value may be either a markdown file path prepared outside `.gjc/` for ingestion or the markdown content string itself. The native `--write` handler also accepts `--artifact-env GJC_RALPLAN_ARTIFACT` to read markdown from that per-command env override. It persists markdown under `.gjc/_session-{sessionid}/plans/ralplan/<run-id>/stage-<NN>-<stage>.md`, maintains an `index.jsonl` audit log, and for `final` stages additionally writes a `pending-approval.md` copy. Direct `write`, `edit`, or `ast_edit` calls against `.gjc/_session-{sessionid}/specs`, `.gjc/_session-{sessionid}/plans`, `.gjc/_session-{sessionid}/state`, or any other `.gjc/` path are forbidden unless an explicit force override is active.

While ralplan is active it is a pre-approval planning phase: product-code mutation tools (`write`/`edit`/`ast_edit`) and product-mutating `bash` (e.g. `tee src/...`, redirects into the project tree) are blocked, exactly like deep-interview. Leaders may pass `--artifact` markdown inline or, when an artifact is too large to pass inline, stage it as a file in a system temp directory (`os.tmpdir()`/`$TMPDIR`, `/tmp`, `/var/tmp`) outside the project tree and pass that path — never write scratch files into the repo or `.gjc/`. Product code is mutated only after the plan is approved and execution begins.

Restricted read-only role agents (`planner`, `architect`, and `critic`) must pass markdown content through the `GJC_RALPLAN_ARTIFACT` env override with `--artifact-env GJC_RALPLAN_ARTIFACT`; their restricted bash environment intentionally disables artifact file-path ingestion so a verdict command cannot persist arbitrary file contents.

After a role agent persists a stage artifact, its model-facing response to the caller SHOULD be receipt-only: return the `gjc ralplan --write --json` receipt (`run_id`, `path`, `stage`, `stage_n`, `sha256`, `created_at`) plus the minimal verdict/status fields the caller needs for routing, and do **not** paste the full persisted markdown back into the parent conversation. Downstream reviewers should receive the artifact path/receipt and read the persisted file themselves when they actually need the body. This preserves the audit trail while preventing Planner/Architect/Critic verdict bodies from being duplicated into the main-agent context.

RECEIPT-ONLY guideline: role agents (`planner`, `architect`, and `critic`) persist durable outputs via `gjc ralplan --write` and return ONLY the receipt fields (`run_id`, `path`, `sha256`) plus verdict/status routing fields; include `stage` and `stage_n` when available, and never return the full persisted body.

This skill runs GJC planning in consensus mode for the provided arguments.

The consensus workflow:
1. **Planner** creates the initial plan and a compact **RALPLAN-DR summary** before review. Launch the Planner ONCE per run as a detached, resumable subagent (await it before the Architect) and record its returned subagent id as the run's persisted Planner id; persist the stage with `gjc ralplan --write --stage planner --stage_n 1 --artifact-env GJC_RALPLAN_ARTIFACT --planner-id <id> --planner-resumable <true|false>` (see **Persisted Planner** below):
   - After persistence, return only the receipt/path plus compact planning status; do not paste the full plan markdown back to the caller unless explicitly requested.
   - Principles (3-5)
   - Decision Drivers (top 3)
   - Viable Options (>=2) with bounded pros/cons
   - If only one viable option remains, explicit invalidation rationale for alternatives
   - Deliberate mode only: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)
2. **User feedback** *(--interactive only)*: If `--interactive` is set, use the `ask` tool to present the draft plan **plus the Principles / Drivers / Options summary** before review (Proceed to review / Request changes / Skip review). Otherwise, automatically proceed to review.
3. **Review fan-out after Planner persistence**: after the Planner stage is persisted, launch fresh Architect and Critic review lanes against the same immutable Planner receipt/path/sha/stage_n when the Critic lane is **plan-only** and does not consume Architect output.
   - **Architect lane**: Architect reviews for architectural soundness and must provide the strongest steelman antithesis, at least one real tradeoff tension, and (when possible) synthesis. In deliberate mode, Architect should explicitly flag principle violations.
   - The Architect agent/subagent must persist its review with `gjc ralplan --write --stage architect --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`, then return the receipt/path plus compact verdict/status (`CLEAR`/`WATCH`/`BLOCK`, `APPROVE`/`COMMENT`/`REQUEST CHANGES`) instead of pasting the full review body.
   - **Plan-only Critic lane**: Critic evaluates the Planner artifact against quality criteria independently of Architect output. It must enforce principle-option consistency, fair alternatives, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. In deliberate mode, Critic must reject missing/weak pre-mortem or expanded test plan.
   - The Critic agent/subagent must persist its evaluation with `gjc ralplan --write --stage critic --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`, then return the receipt/path plus compact verdict/status (`OKAY`/`ITERATE`/`REJECT`) instead of pasting the full evaluation body.
   - **Sequential fallback**: when Critic must evaluate Architect findings, verdict, antithesis, tradeoffs, synthesis, architectural status, or any other Architect-produced artifact, await the Architect result before issuing that Architect-dependent Critic pass.
4. **Review join gate**: before consensus, revision, reconciliation, finalization, or approval, verify both Architect and Critic receipts/verdicts exist for the same Planner artifact/pass (`path`, `sha256`, `stage_n`). A non-`CLEAR` Architect verdict, non-`APPROVE` Architect decision, or any non-`OKAY` Critic verdict routes back to Planner revision; do not finalize from only one review lane.
5. **Re-review loop** (max 5 iterations): Any non-`OKAY` Critic verdict (`ITERATE` or `REJECT`) or Architect result that is not `CLEAR`/`APPROVE` MUST run the same full closed loop:
   a. Collect Architect + Critic feedback
   b. Revise the plan by resuming the SAME persisted Planner subagent with consolidated Architect + Critic feedback (see **Persisted Planner** below); fall back to a fresh Planner spawn only per the fallback routing table
   c. Return to the review fan-out or sequential fallback path above
      - Persist each Planner revision with `gjc ralplan --write --stage revision --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json` before re-review, then pass the receipt/path forward instead of duplicating the full revision markdown in the parent conversation.
   d. Re-join Architect and Critic verdicts for the same revised Planner artifact/pass
   e. Repeat this loop until Critic returns `OKAY` **and** Architect is `CLEAR`/`APPROVE` for the same Planner artifact/pass, or 5 iterations are reached
   f. If 5 iterations are reached without Critic `OKAY` plus Architect `CLEAR`/`APPROVE`, present the best version to the user
6. **Post-ralplan interview** (intent reconciliation gate): After the review join gate has both Critic `OKAY` and Architect `CLEAR`/`APPROVE` for the same Planner artifact/pass, and before the plan is finalized, reconcile the consensus plan against the user's actual intent. The goal is to make sure ralplan did not silently bake in assumptions that conflict with what the user wants.
   a. **Collect open items** from the run: every assumption the Planner/Architect/Critic resolved by assumption rather than by stated fact, every ambiguity flagged during review, and every decision the loop made without explicit user input. Source these from the persisted `planner`/`architect`/`critic`/`revision` stage artifacts, not from memory.
   b. **Cross-check prior context for conflicts**: glob `.gjc/_session-{sessionid}/specs/deep-interview-*.md` and other prior specs/plans/context relevant by topic. For each, list points where the consensus plan contradicts, weakens, or expands beyond a previously crystallized decision, constraint, or non-goal. Cite the conflicting artifact and line/section.
   c. **Reconcile with the user via the `ask` tool (always, regardless of `--interactive`)**: Never stop idle with plain-text prose after the consensus loop. Every reconciliation question MUST go through the `ask` tool with contextual options plus free-text.
      - If open items exist, confirm the open assumptions and conflicts **one at a time** with the `ask` tool, weakest/highest-impact first, polishing intent. If any confirmation reveals that the plan diverges from user intent, route the consolidated correction back into the re-review loop (step 5b Planner revision) and re-run Architect + Critic before returning here. Cap at the same 5-iteration ceiling.
      - If the plan is crystal clear (no open assumptions or prior-context conflicts), skip straight to the step 8 final-options `ask` instead of inventing filler questions.
      - For every confirmed open item, embed the resolved outcome into the final plan under an **## Intent Reconciliation** section so the `pending approval` artifact records each decision; record any item the user explicitly defers as an open confirmation under that same section.
   d. Persist the reconciliation with `gjc ralplan --write --stage post-interview --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`, then return the receipt/path plus a compact status (reconciled-clean / reconciled-with-revision / open-confirmations-pending) instead of pasting the full body.
7. On reconciliation completion, re-check the review join gate (Critic `OKAY` plus Architect `CLEAR`/`APPROVE` for the same Planner artifact/pass), mark the plan `pending approval` unless explicit execution approval has already been captured, persist the ADR/final plan via `gjc ralplan --write --stage final --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT`, and do not directly edit `.gjc/_session-{sessionid}/plans`. Final plan must include ADR (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups) and, when present, the **## Intent Reconciliation** section.
8. **Always** present the finalized plan via the `ask` tool (regardless of `--interactive`) with `workflowGate: { stage: "ralplan", kind: "approval" }` on the final question so RPC/headless clients receive a `ralplan`/`approval` workflow gate, not a deep-interview question gate. Use these options:
   - **Refine further** — re-run the consensus loop / request changes, then return here
   - **Approve execution via ultragoal (Recommended)** — goal-tracked autonomous execution
   - **Approve execution via team** — only when tmux-based interactive worker parallelization is required
   - **Stop here** — keep the plan as `pending approval` and make no further changes

   Always include a free-text option. Do not stop with plain text and no `ask`; the post-interview gate's terminal action is this `ask`.
9. On approval: invoke `/skill:ultragoal` for execution by default; invoke `/skill:team` only when the user explicitly needs tmux-based interactive worker parallelization. On **Refine further**, return to the step 5 re-review loop. On **Stop here**, leave the `pending approval` artifact and stop. Never implement directly.

   Before invoking `/skill:team` or `/skill:ultragoal`, mark ralplan ready for handoff so the skill tool's chain guard permits the transition:

   ```
   gjc state ralplan write --input '{"current_phase":"handoff"}' --json
   ```

   The skill tool then dispatches the execution skill same-turn and runs `gjc state ralplan handoff --to <team|ultragoal> --json` in-process to atomically demote ralplan, promote the callee, and sync `.gjc/_session-{sessionid}/state/skill-active-state.json`. You do not need to run the handoff verb yourself.

> **Important:** Architect and Critic MAY run in the same parallel batch only for the plan-only Critic lane after Planner persistence. Any Architect-dependent Critic pass MUST remain sequential: await Architect before issuing Critic, then apply the same review join gate before consensus.


Follow the Plan skill's full documentation for consensus mode details.

### Persisted Planner (consensus loop)

The Planner is a **same-session persisted subagent**: launched detached once, awaited before review fan-out, then **resumed** with consolidated Architect + Critic feedback on every re-review pass instead of being re-spawned. The Architect and Critic stay **fresh, independent spawns each pass** so their verdicts remain reproducible from their pass artifacts alone; the Critic may run in parallel only when it is plan-only and tied to the same Planner receipt/path/sha/stage_n as Architect. Do NOT modify the subagent control surface; this orchestration uses the existing `subagent` resume/steer controls only.

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
gjc ralplan --write --stage revision --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT \
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
