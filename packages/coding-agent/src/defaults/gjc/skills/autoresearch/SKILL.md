---
name: autoresearch
description: Goal-directed research missions that interleave web research with data experimentation and end on a structured best-effort verdict
argument-hint: "[--spec <path>] [--json] <goal>"
source: "GJC-native workflow skill rebuilt from the deprecated autoresearch extension"
---

# Autoresearch Workflow

Use when the user asks for `autoresearch`, or gives a bounded research goal whose deliverable is a defensible verdict rather than code ("find out", "investigate", "benchmark and report").

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

- `--spec <path>` — handoff intake from a persisted deep-interview spec; asks zero questions.
- `"<goal>"` or bare invocation — cold intake; goal, constraints, and deliverables must be clarified before research begins.
- `read --json` — current mission artifact plus the append-only ledger snapshot.
- `clear` — remove the mission artifact and record the kernel clear in the ledger.

## Use when

> **Use when** the user wants a bounded research mission whose output is a defensible verdict: a question that needs evidence from the web, local data, or both before any conclusion is drawn ("does X hold for this dataset?", "which approach benchmarks best?", "what changed between these two releases?"); an explicit request to run `autoresearch`; or a goal whose acceptance is a structured verdict with evidence and caveats.

## Do not use when

- Ordinary pre-planning lookup that will be followed by a planning pass — route that through `ralplan`/`deep-interview` instead of opening a research mission.
- Implementing anything — autoresearch produces findings and a verdict, never code. Downstream implementation goes through the normal approval-gated path.
- A quick single answer that one `read`/`search` resolves directly.

## Two intakes

Both intakes write the same mission artifact (`objective`, `mode`, `deliverables`, `constraints`, `slug`).

### Handoff intake

`gjc autoresearch --spec <path>` reads a persisted deep-interview spec and starts the mission with **zero clarification questions**. The spec MUST declare its mission mode explicitly (a line like `autoresearch-mode: web`); a missing or invalid declaration is a hard fail. The consumed spec path and handoff time are recorded on the mission artifact.

### Cold intake

`gjc autoresearch "<goal>"` (or a bare `gjc autoresearch`) signals cold intake. Clarify the **goal, constraints, and deliverables BEFORE any research tool fires** — no web search, no `python` kernel, no harness build — then write the mission with an explicit mode.

## Mode

Every mission carries an explicit mode: `web`, `mixed`, or `data`. The mode is stated at intake and persisted in the mission artifact. It is NEVER inferred from the presence of a data file: a data file in the workspace without an explicit mode is a rejection, not a default. Data-context loading is gated to `data`/`mixed` mode only; `web` mode never attaches data context.

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

The mission `python` tool holds a persistent kernel across calls: variables, imports, and loaded data survive from call to call like notebook cells, and every call is recorded as a cell in the mission notebook. The tool is inactive until a mission is active, and its kernel is owned by the mission (`autoresearch:<mission-id>`). Clearing the kernel is an action on that same tool (`action: "clear"`); the mission clears it when the mission ends.

## Completion

The mission ends on one mission-level structured verdict: `status` (structured data, not a pinned enum), `evidence[]`, `caveats[]`, and the `evaluator` identity. The verdict is self-issued by default. An optional critic pass records a separate evaluator identity on the verdict (`critic_receipt`), distinct from the mission agent's. The verdict is best-effort, not a rigid per-lane checklist: missing lanes surface as caveats, not automatic failure. An inconclusive verdict is explicitly non-terminal — the mission stays open for follow-up rather than being closed as finished.

## Artifacts

- `.gjc/_session-{sessionid}/autoresearch/` — mission artifact, append-only JSONL ledger, session-scoped run records, mission notebook, and synthesized report (plus the TUI run-table dashboard).
- The ledger appends `mission_created`, `mode_set`, `run_logged`, `verdict_issued`, `critic_recorded`, and `kernel_cleared` events; verdict and critic receipts ride on their events as structured data.
- Persist everything through `gjc autoresearch`; never hand-edit `.gjc/` (no direct `write`/`edit`/`ast_edit` against `.gjc/` paths without an explicit force override).
- On interruption, resume via `gjc autoresearch read --json`; do not read or edit `.gjc/_session-{sessionid}/autoresearch/` files directly.

## Boundary

Autoresearch produces research findings and a verdict; it never implements. Downstream implementation goes through the normal approval-gated path (planning → pending approval → explicitly approved execution).
