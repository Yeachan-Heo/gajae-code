---
name: autoresearch
description: Goal-directed research missions that interleave web research with data experimentation and end on a structured best-effort verdict
argument-hint: "[--spec <path>] [--json] <goal>"
source: "GJC-native workflow skill rebuilt from the deprecated autoresearch extension"
---

# Autoresearch Workflow

Use when the user asks for `autoresearch`, or gives a bounded research goal whose deliverable is a defensible verdict rather than code ("find out", "investigate", "benchmark and draw a conclusion").

## Usage

```
/skill:autoresearch "<research goal>"
/skill:autoresearch --spec .gjc/_session-{sessionid}/specs/deep-interview-<slug>.md
```

Invoke this workflow as `/skill:autoresearch`; the durable state behind it is driven by the `gjc autoresearch` runtime command.

## Purpose

`autoresearch` runs one goal-directed research mission: it interleaves web research with data/environment experimentation and ends on a single structured, best-effort verdict. The verdict receipt carries a structured `status`, `evidence[]`, `caveats[]`, and the `evaluator` identity that issued it. The mission is research, NOT implementation: its durable outputs are findings, evidence, run records, and a verdict — never product code.

All mission state persists per session under `.gjc/_session-{sessionid}/autoresearch/` and survives across `gjc autoresearch` invocations. The global `~/.gjc/autoresearch` store is never written.

## Always-used command examples

Use these exact `gjc autoresearch` commands before spending tool calls rediscovering syntax:

```sh
gjc autoresearch --spec <deep-interview-spec-path>
gjc autoresearch "<goal>"
gjc autoresearch
gjc autoresearch read --json
gjc autoresearch clear
```

- `intake --spec <path>` (or the bare `--spec` flag) — spec intake from a persisted deep-interview spec; the runtime asks zero questions, while the skill checks for material ambiguity before writing.
- `"<goal>"` or bare invocation — cold intake; goal, constraints, and deliverables must be clarified before research begins.
- `read --json` — current mission artifact plus the append-only ledger snapshot.
- `clear` — retire the mission artifact and its working set, recording `mission_cleared` in the ledger. This never touches the session `python` REPL kernel; reset that with the `python` tool's own `clear` action.

## Use when

> **Use when** the user wants a bounded research mission whose output is a defensible verdict: a question that needs evidence from the web, local data, or both before any conclusion is drawn ("does X hold for this dataset?", "which approach benchmarks best?", "what changed between these two releases?"); an explicit request to run `autoresearch`; or a goal whose acceptance is a structured verdict with evidence and caveats.

## Do not use when

- Ordinary pre-planning lookup that will be followed by a planning pass — route that through `ralplan`/`deep-interview` instead of opening a research mission.
- Implementing anything — autoresearch produces findings and a verdict, never code. Downstream implementation goes through the normal approval-gated path.
- A quick single answer that one `read`/`search` resolves directly.

## Two intakes

Both intakes write the same mission artifact (`objective`, `mode`, `deliverables`, `constraints`, `assumptions`, `slug`).

### Spec intake

`gjc autoresearch intake --spec <path>` (or the bare `--spec` flag) reads a persisted deep-interview spec and starts the mission without runtime clarification. Before invoking it, inspect whether its research question, success criterion, or scope is materially ambiguous and follow the intake clarification step below. The spec MUST declare its mission mode explicitly (a line like `autoresearch-mode: web`); a missing or invalid declaration is a hard fail. The consumed spec path and handoff time are recorded on the mission artifact.

### Cold intake

`gjc autoresearch "<goal>"` (or a bare `gjc autoresearch`) signals cold intake. Establish the **goal, success criterion, scope, constraints, and deliverables BEFORE any research tool fires** — no web search, no `python` kernel, no harness build — then write the mission with an explicit mode.

### Intake clarification (ask point 1)

Before writing the mission artifact for either intake, check whether the research question, success criterion, or scope is ambiguous. Do not run `gjc autoresearch intake --spec` or `gjc autoresearch write`, and do not create the inline goal, until this check is complete.

- A listed `ask` tool alone is not enough: call it only when its runtime description explicitly says an interactive or remote answer channel is available. Otherwise treat it as unavailable.
- If an answer channel is available and those three items are clear, proceed without an ask.
- If any is materially ambiguous and an answer channel is available, call `ask` exactly once with one question naming the ambiguity and these two options: `Refine the spec` and `Proceed with stated assumptions`. Use any custom text supplied with the answer. If the user chooses refinement but supplies no missing detail, stop before writing the mission rather than asking a second time.
- If no answer channel is available (including headless/non-interactive sessions), do not call or simulate `ask`. Continue only when a bounded research question can be stated from the request; make the smallest explicit assumptions needed and persist each one in the mission's `assumptions` array using repeated `--assumption <text>` flags on `gjc autoresearch write` or `gjc autoresearch intake --spec`. Also record `No downstream handoff requested; stop after the verdict` when no handoff preference was stated. If no research question can be grounded in the request, stop without inventing one or writing a mission.

When a mission is written from a spec, the runtime also imports bullets under its `## Assumptions` section into `mission.assumptions`. Read the persisted mission receipt and verify those assumptions before research begins.

## Mode

Every mission carries an explicit mode: `web`, `mixed`, or `data`. The mode is stated at intake and persisted in the mission artifact. It is NEVER inferred from the presence of a data file: a data file in the workspace without an explicit mode is a rejection, not a default. Data-context loading is gated to `data`/`mixed` mode only; `web` mode never attaches data context.

## Goal mode (nudge until verdict)

Autoresearch uses the inline goal to keep research moving until its structured verdict receipt exists. This is a cooperative, instruction-only integration, not an autoresearch runtime enforcement boundary: the agent calls the unified `goal` tool itself; `gjc autoresearch` commands and hooks never mutate goal state. Generic goal-runtime guards, abort behavior, and handoff behavior still apply; surface or retry failures rather than treating them as completed lifecycle steps.

Lifecycle:

- **Create** — right after the mission artifact is written (both spec and cold intake), call `goal({"op":"get"})`; create only when it returns no goal or a terminal `complete`/`dropped` goal. Use `goal({"op":"create","objective":"Drive the autoresearch mission '<mission objective>' to a persisted structured verdict receipt"})`. Intake clarification happens before the artifact and before goal creation.
- **Collision rule** — an `active` **or `paused`** goal is a collision, not an invitation to call `create`: never replace, resume, complete, or drop a different goal. If the existing goal has this mission's exact objective, continue its lifecycle; otherwise run the mission without goal mode and leave the other goal untouched. This matters because the goal runtime rejects `create` over any nonterminal goal, including a paused one.
- **Resume rule** — when re-entering a mission (`gjc autoresearch read --json`), inspect both the latest persisted verdict and `goal({"op":"get"})`. With no verdict or an explicit `status.disposition: "inconclusive"`, create a goal only when no goal or a terminal goal exists; resume a matching paused goal with `goal({"op":"resume"})`, continue a matching active goal, and honor any different active/paused goal as a collision. With `status.disposition: "conclusive"`, never create or resume a new goal. If the conversation has no answer to the verdict handoff ask, continue at that ask before completing the matching goal or clearing the mission; an existing paused goal stays paused while waiting. If a handoff answer is already present, do not ask again. A missing or different disposition is treated as open rather than auto-cleared.
- **Verdict handoff (ask point 2)** — only after the native verdict command has returned and the structured receipt is persisted, and only when the `ask` tool description reports an interactive or remote answer channel, call `ask` exactly once to ask the user how to proceed. If this mission has a matching active inline goal, first call `goal({"op":"pause"})` and verify `goal({"op":"get"})` reports it paused; this existing paused-goal state is the human-wait state, so the continuation loop will not nudge while the ask is pending. Never pause a different goal. If pause fails and the matching goal remains active, do not issue the ask; surface the failure rather than leave a live continuation running during the wait. Set `requireExplicitAnswer: true` so an `ask.timeout` cannot choose for the user. Ask exactly these choices:
  - `ralplan` — plan follow-up research or a decision from the findings; do not start implementation.
  - `deep-interview` — clarify or refine the research scope.
  - `Implementation plan (approval required)` — pass the findings as an implementation target to `/skill:ralplan`, which must stop at its explicit execution-approval boundary.
  - `stop` — end without another workflow.

  Do not choose a handoff silently.
- If no answer channel is available at verdict time, do not call or simulate `ask`; follow any explicit handoff preference already in the request, or use the recorded no-handoff assumption, then complete the goal. Conclusive missions follow the no-ask auto-clear rule below; inconclusive missions stay open.
- **Complete** — after the handoff answer (or immediately when `ask` is unavailable), call `goal({"op":"complete"})` exactly once for this mission's matching nonterminal goal, including one paused for the ask. Do not resume it just to complete it. Any verdict completes the goal-tracking pass, including best-effort and inconclusive verdicts; an inconclusive mission stays open for follow-up, but its current goal pass is complete. Verdict writes are append-only and not idempotent: after an uncertain verdict command, read the latest ledger/receipt before retrying and do not issue a duplicate verdict merely because the first response was lost.
- **After the handoff answer** — for `ralplan` or `deep-interview`, pass the mission objective and persisted verdict evidence into the selected skill through the canonical `skill` tool. `ralplan` plans follow-up research or a decision; it is not the implementation choice. `Implementation plan (approval required)` passes the findings as a concrete implementation objective to `/skill:ralplan` and waits for its explicit execution approval before product-code changes; it does not authorize implementation by itself. For `stop`, do not start another workflow. Only `status.disposition: "conclusive"` is terminal for mission cleanup: clear it after the stop choice, or after a conclusive no-ask run; keep an inconclusive mission for follow-up. Do not clear before a selected skill handoff. If clear fails, retain durable state and retry cleanup on re-entry without completing the goal twice.
- **Drop** — call `goal({"op":"drop"})` only for this mission's matching nonterminal goal on a manual pre-verdict clear or user cancel. After a verdict, complete the matching goal instead; never drop a different goal or a completed goal.

The runtime does not make these transitions transactional: canonical skill handoff does not complete an inline goal for the agent, and user cancellation can preserve an active or paused goal. After cancellation or a failed handoff, re-enter, inspect `goal({"op":"get"})`, and clean up only a matching nonterminal goal. An unrelated or unreadable Ultragoal state can also reject generic goal operations; do not bypass that guard or clear mission state early.

Goal mode never authorizes implementation: the mission remains research-only (findings, evidence, run records, verdict), and the nudge loop must never be used to start product-code changes.

## Evidence sources interleave

Web research and data/environment experimentation are not separately gated tracks. Inside one mission they mix freely: a web finding motivates an experiment, an experiment's result triggers the next web search, and both land in the same mission ledger and the same final verdict. The mode decides which evidence sources exist, not when they may be used.

## The loop

The mission runs in two phases.

### Phase 1 — build the harness

Use an existing benchmark command or a research-only harness artifact explicitly approved for the mission. It must:

- exit 0 on success and non-zero on failure;
- print the primary metric as a single line `METRIC <name>=<value>`, and any secondary metrics as additional `METRIC <name>=<value>` lines;
- run the same workload deterministically (no live network, no time-of-day dependencies, fixed seeds where applicable).

Do not edit product source, manifests, dependencies, or benchmark binaries. When a useful benchmark requires a code or harness change, record that limitation as a caveat and route the change through the normal approval-gated implementation path. Validate the existing command by running it and confirming it exits 0 and emits at least one `METRIC` line. Output may also carry `ASI key=value` learning lines.

### Phase 2 — iterate

Iterate existing experiments with baseline/keep/discard discipline. Log every run: `keep` when the primary metric improves, `discard` when it regresses or stays flat, `crash` when the run fails, `checks_failed` when validation fails. Flag suspect runs (reward-hacked or invalid) so they are excluded from baseline and best-metric math. This workflow does not create branches, commit changes, or revert files because it never changes product code.

## Persistent Python

The `python` tool provides a persistent session REPL: variables, imports, and loaded data survive across calls. It is available without an active mission, uses the distinct `python:<session-id>` kernel owner, and appends every execution to the session JSONL transcript. Clearing its kernel is an action on the same tool (`action: "clear"`); session cleanup also disposes it.

## Completion

The mission ends on one mission-level structured verdict: `status` (structured data, not a pinned enum), `evidence[]`, `caveats[]`, and the `evaluator` identity. The verdict is self-issued by default. An optional critic pass records a separate evaluator identity on the verdict (`critic_receipt`), distinct from the mission agent's. The verdict is best-effort, not a rigid per-lane checklist: missing lanes surface as caveats, not automatic failure. Use `status.disposition: "inconclusive"` for an explicitly non-terminal verdict; the mission stays open for follow-up rather than being closed as finished. Only `status.disposition: "conclusive"` is terminal for the mission artifact; after the handoff choice, clear it only when the user stops or when no ask is available.

## Artifacts

- `.gjc/_session-{sessionid}/autoresearch/` — mission artifact, append-only JSONL ledger, session-scoped run records (plus the TUI run-table dashboard).
- The ledger appends `mission_created`, `mode_set`, `run_logged`, `verdict_issued`, `critic_recorded`, and `mission_cleared` events; verdict and critic receipts ride on their events as structured data.
- Persist everything through `gjc autoresearch`; never hand-edit `.gjc/` (no direct `write`/`edit`/`ast_edit` against `.gjc/` paths without an explicit force override).
- On interruption, resume via `gjc autoresearch read --json`; do not read or edit `.gjc/_session-{sessionid}/autoresearch/` files directly.

## Boundary

Autoresearch produces research findings and a verdict; it never implements. Downstream implementation goes through the normal approval-gated path (planning → pending approval → explicitly approved execution).

## Ending a mission

Two exits remain available before the verdict; after it, use the handoff ask above.

- **Hand off to planning/clarification**: before the verdict, drop this mission's matching nonterminal goal first, then invoke `/skill:ralplan`, `/skill:deep-interview`, or `/skill:ultragoal` — autoresearch is handoff-ready at any phase (`intake`/`research`/`verdict`), and the skill tool performs the atomic workflow-state handoff itself, not an atomic goal-state cleanup. No `gjc state` preparation is needed.
- **Finalize only**: `gjc autoresearch clear` retires the mission artifact and its working set, appends `mission_cleared` to the ledger, and marks the workflow complete — no handoff target required.

Neither command or handoff automatically cleans up an inline goal: before-verdict exits drop this mission's matching nonterminal goal; after a verdict, complete its matching goal after the handoff ask. After cancellation or failed cleanup, re-enter and reconcile it. Never clear a conclusive mission before a selected skill handoff.
