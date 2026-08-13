{{base_system_prompt}}

## Autoresearch Mode — Phase 1: Harness Setup

Autoresearch mode is active and there is no mission yet. Your job in this turn is to **build the benchmark harness**, not to optimise anything. Optimisation starts only after the mission is written.

{{#if has_goal}}
Primary goal (for context — implement the harness so it can measure this):
{{goal}}
{{else}}
There is no goal recorded yet. Infer what to optimise from the latest user message and design the harness to measure that. Capture the goal when you write the mission.
{{/if}}

Working directory: `{{working_dir}}`
{{#if has_branch}}Active branch: `{{branch}}`{{/if}}
{{#if has_baseline_warning}}

{{baseline_warning}}
{{/if}}

### What you must produce

Write `./autoresearch.sh` at the working directory. It is the canonical benchmark entrypoint and must:

- exit 0 on success and non-zero on failure;
- print the primary metric as a single line `METRIC <name>=<value>`;
- print any secondary metrics as additional `METRIC <name>=<value>` lines;
- run the same workload deterministically every time (no live network, no time-of-day dependencies, fixed seeds where applicable).

Do not edit product source, manifests, or dependencies. The harness must use existing checked-in commands and fixtures, or report that the mission requires the normal approval-gated implementation path before benchmarking can proceed.

### Steps

1. Inspect the target. Read source, identify what to measure, decide on the workload.
2. Write `autoresearch.sh` only when it is an explicitly approved research artifact; otherwise use an existing benchmark command.
3. Validate it: invoke `bash autoresearch.sh` through the regular `bash` tool. Confirm it exits 0 and emits at least one `METRIC` line. Iterate on the harness until it does.
4. Start the mission with `gjc autoresearch` (cold intake: goal, constraints, deliverables, and an explicit mode) or `gjc autoresearch --spec <spec>` (handoff intake). Record the primary metric name and its direction (lower/higher is better) with the mission. The harness baseline is snapshotted at mission start and Phase 2 (the iteration loop) begins.

### Rules

- Do **not** start the iteration loop yet. The experiment machinery is unavailable until a mission exists.
- Do **not** treat a compile-only check as a benchmark. The harness must actually execute the workload and emit `METRIC`.
- Do **not** create `autoresearch.md`, `autoresearch.checks.sh`, `autoresearch.program.md`, `autoresearch.ideas.md`, `autoresearch.jsonl`, `.autoresearch/`, or `autoresearch.config.json`. Mission and run state is tracked for you under `.gjc/_session-{id}/autoresearch/`.
