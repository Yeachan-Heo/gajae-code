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

- `--interactive`: Adds draft-review prompts and one-at-a-time reconciliation; final approval always uses an `ask` workflow gate and never auto-executes.
- `--deliberate`: Forces high-risk deliberation: pre-mortem plus expanded test planning. It may also auto-enable for explicit auth/security, migration, destructive, incident, compliance/PII, or public-API-breakage risk.
- `--architect openai-code` / `--critic openai-code`: Use OpenAI code for that review pass when available; otherwise note the fallback and use default GJC review.
- `--write --stage <type> --stage_n <N> --artifact <markdown file path or markdown string>`: Native writer for Planner/Architect/Critic/revision/ADR/final pending-approval markdown under `.gjc/_session-{sessionid}/plans/ralplan/<run-id>/`; do not edit `.gjc/` directly.

## Usage with interactive mode

```
/skill:ralplan --interactive "task description"
```

## Corrupt current-session state recovery

For corrupt, tampered, unreadable, or stale current-session ralplan state, run `gjc state clear --force --mode ralplan` scoped by `--session-id`, command payload, or `GJC_SESSION_ID`; it clears only ralplan state for that session.

## Behavior

## Planning/Execution Boundary

Ralplan is planning only. It may inspect context and draft plan/spec/proposal artifacts, but those remain `pending approval` until explicit current-turn or structured-UI execution approval. Before that approval, do not mutate product source, run mutation-oriented shell, commit, push, open PRs, invoke execution skills, or delegate implementation.

Persist planning artifacts and handoffs through the ralplan CLI writer, never direct `.gjc/` edits:
Direct `write`, `edit`, or `ast_edit` calls against `.gjc/_session-{sessionid}/specs`, `.gjc/_session-{sessionid}/plans`, `.gjc/_session-{sessionid}/state`, or any other `.gjc/` path are forbidden unless an explicit force override is active.

```bash
gjc ralplan --write --stage <type> --stage_n <N> --artifact "markdown file path or markdown string"
# restricted role agents use:
gjc ralplan --write --stage <type> --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT
```

Use stages `planner`, `architect`, `critic`, `revision`, `post-interview`, `adr`, or `final`; increment `--stage_n` each consensus pass. The writer accepts inline markdown, an artifact path prepared outside `.gjc/`, or `--artifact-env GJC_RALPLAN_ARTIFACT`, persists `stage-<NN>-<stage>.md` plus `index.jsonl` under `.gjc/_session-{sessionid}/plans/ralplan/<run-id>/`, and copies `final` to `pending-approval.md`. Ralplan mutation blocking is enforced in code; use temp directories (`os.tmpdir()`/`$TMPDIR`, `/tmp`, `/var/tmp`) only for oversized scratch artifacts, never the repo or `.gjc/`.

Restricted read-only role agents (`planner`, `architect`, `critic`) must pass markdown through `GJC_RALPLAN_ARTIFACT` with `--artifact-env GJC_RALPLAN_ARTIFACT`; their restricted bash environment disables artifact file-path ingestion.

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
3. **Review fan-out after Planner persistence**: launch fresh Architect and Critic review lanes against the same immutable Planner receipt/path/sha/stage_n when Critic is **plan-only** and does not consume Architect output.
   - **Architect lane**: challenge architecture, surface tradeoff tensions, and enrich thin plans with synthesis or missed sub-scope. Persist with `gjc ralplan --write --stage architect --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`, then return receipt/path plus `CLEAR`/`WATCH`/`BLOCK` and `APPROVE`/`COMMENT`/`REQUEST CHANGES`.
   - **Plan-only Critic lane**: independently check quality, principle-option consistency, alternatives, risks, acceptance criteria, and verification; when the plan is thin, request concrete expansion rather than only defects. Persist with `gjc ralplan --write --stage critic --stage_n <N> --artifact-env GJC_RALPLAN_ARTIFACT --json`, then return receipt/path plus `OKAY`/`ITERATE`/`REJECT`.
   - **Sequential fallback**: if Critic must evaluate Architect findings, verdict, antithesis, tradeoffs, synthesis, status, or any Architect-produced artifact, await the Architect result before issuing that Architect-dependent Critic pass.
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

The Planner is a **same-session persisted subagent**: launched detached once, awaited before review fan-out, then **resumed** with consolidated Architect + Critic challenge and enrichment on each re-review pass. Architect and Critic are fresh independent spawns each pass; Critic may run in parallel only when plan-only and tied to the same Planner receipt/path/sha/stage_n. Do NOT modify the subagent control surface; use existing `subagent` resume/steer controls only.

**Persistence boundary:** same-parent, active-session continuity only. Resumability requires retained subagent resume metadata and a persistent parent session (in-memory parent yields `resumable:false`), not just `.gjc` run-state. A terminal subagent can still resume when its retained descriptor points at a saved subagent session; after process restart, missing metadata, or failed/unavailable resume, use fresh Planner fallback.

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

Execution skills (`ultragoal`, `team`) implement bounded work; they are not scope-discovery lanes. Vague execution requests such as `team improve the app` are routed through ralplan so scope, acceptance criteria, consensus, and verification exist before code changes.

**Passes the gate** (specific enough for direct execution): file paths, issue/PR numbers, named symbols, explicit tests, numbered steps, acceptance criteria, error references, code blocks, or escape prefixes (`force:` / `!`). Examples: `team fix src/hooks/bridge.ts`, `team implement #42`, `team add validation to processKeywordDetector`, `team do:\n1. Add input validation\n2. Write tests`.

**Gated — redirected to ralplan**: `team fix this`, `team build the app`, `team improve performance`, `team add authentication`, `team make it better`.

Gate auto-pass signals: file path, issue/PR number, camelCase/PascalCase/snake_case symbol, test runner, numbered steps, acceptance criteria, error reference, code block, or escape prefix. If it fires on a well-specified prompt, add one concrete anchor; if you intentionally bypass, prefix `force:` or `!`.

On consensus approval, choose:
- **ultragoal**: goal-tracked autonomous execution with verification (recommended default)
- **team**: tmux-based coordinated workers only when interactive worker parallelization is required

A redirected request proceeds only through the structured approval option or an explicit execution-skill choice; `just do it` / `skip planning` alone leaves the plan `pending approval`.
