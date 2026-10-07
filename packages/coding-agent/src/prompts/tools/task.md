Launches subagents to parallelize workflows.

- Results are delivered automatically when complete.
- The tool result lists the assigned task ids (e.g. `0-AuthLoader`) — those are the live agent ids.
- Coordinate with running tasks via `irc` when available, using those ids. `subagent` cancel terminates a task and **cannot carry a message**.
- Use `subagent` action `inspect` or `list` to snapshot manager state.
- To wait or cancel, use the `subagent` tool; its await/cancel doctrine is authoritative.

Subagents have no conversation history. Every fact, file path, and direction they need MUST be explicit in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
Use `irc` for live coordination when it is available.

<parameters>
- `agent`: agent type for all tasks
- `tasks`: tasks to execute in parallel
 - `.id`: filesystem-safe, ≤48 chars, matching `[A-Za-z0-9][A-Za-z0-9_-]*`; prefer CamelCase
 - `.description`: UI label only — subagent never sees it
 - `.assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
{{#if contextEnabled}}- `context`: shared background prepended to every assignment; session-specific only{{/if}}
{{#if contextEnabled}}
- `.inheritContext` (optional): fork-context mode for seeding the subagent with sanitized parent conversation. Omit it or set `"none"` for no copied context. `"receipt"` copies a minimal receipt-sized snapshot, `"last-turn"` copies only the latest exchange, `"bounded"` copies the bounded default snapshot, and `"full"` copies a larger snapshot up to the configured/model token cap. Non-`none` modes work only when global `task.forkContext.enabled` is true and the target agent declares `forkContext: allowed`; otherwise the call is rejected. Bundled agents that support it: `executor`, `architect`. Use inherited context only when the subagent's value depends on parent context; cloned tokens are billed to the child as fresh input and surfaced in task receipts as fork-context cloned-token accounting.
{{/if}}
{{#if independentMode}}- `.inheritContext`: independent mode cannot inherit parent conversation. Omit it or set `"none"`; any non-`none` value is rejected before scheduling.{{/if}}
{{#if customSchemaEnabled}}- `schema`: JTD schema for expected structured output (do not put format rules in assignments){{/if}}
- `spawnPlan` (optional): required before any batch with more than 4 tasks; include whyParallel, whyNotLocal, independence, expectedReceiptShape, and maxInlineTokens.
{{#if isolationEnabled}}- `isolated`: run in an isolated environment; REQUIRED when the user explicitly requests a worktree (for example, "use worktree"), and use when tasks edit overlapping files{{/if}}
- `repositoryBinding`: optional authoritative repository/worktree identity. It must match the active session and cannot authorize a foreign repository from this session. For another approved repository, start a fresh session rooted there (for example, `gjc --cwd <approved-worktree>`); do not use `/move` because materialized tasks retain their original binding.
</parameters>

<rules>
- HARD runtime gate: calls with more than 4 tasks are rejected before any child launches unless `spawnPlan` is complete.
- NEVER assign tasks to run project-wide build/test/lint. Caller verifies after the batch.
- **Subagents do not verify, lint, or format.** Every assignment MUST instruct the subagent to skip all gates and formatters. You run them once at the end across the union of changed files — avoids redundant runs and racing formatter passes.
- Each task: ≤3–5 explicit files. No globs, no "update all", no package-wide scope. Use `irc` to coordinate overlapping work when it is available; otherwise keep file sets independent.
- Pass large payloads via `local://<path>` URIs, not inline.
{{#if contextEnabled}}- Put shared constraints in `context` once; do not duplicate across assignments.{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin a read-only discovery step when affected files are genuinely unknown.
</rules>

<parallelization>
Test: can task B run correctly without seeing A's output? If no, sequence A → B, unless `irc` is available and A can answer a small clarification.
Still sequence when one task produces a large, evolving contract (generated types, schema migration, core module API); live coordination is not a substitute for a finished contract.
Parallel when tasks touch disjoint files, are independent refactors/tests, or need only occasional peer clarification.
</parallelization>

{{#if contextEnabled}}
<context-fmt>
# Goal         ← one sentence: what the batch accomplishes
# Constraints  ← MUST/NEVER rules and session decisions
# Contract     ← exact types/signatures if tasks share an interface
</context-fmt>
{{/if}}

<assignment-fmt>
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands
</assignment-fmt>

<agents>
{{#if spawningDisabled}}
Agent spawning is disabled for this context.
{{else}}
Bundled role names: {{#list agents join=", "}}{{name}}{{/list}}. A configured agent may override a bundled role name and takes precedence.
Other configured agents (project, user, plugin) may also be available; calling with an unknown `agent` lists the agents callable in this session.
{{/if}}
</agents>

{{#if autoroutingActive}}
<autorouting-guidance>
Choose a tier by agent role/type, per-call complexity, and cost intent: fast for mechanical/lookup/high-volume work where cheap tokens are the point; balanced (default) for ordinary implementation/review lanes; strong for deep design, hard debugging, or high-stakes review where the cost is justified. Provider availability/auth is enforced by deterministic code and is never an input to tier choice. Omitting tier is fine and routes as balanced.
</autorouting-guidance>
{{/if}}
