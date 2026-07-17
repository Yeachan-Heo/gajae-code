Launches subagents to parallelize workflows.

- Results are delivered automatically when complete.
- The tool result lists the assigned task ids (e.g. `0-AuthLoader`) — those are the live agent ids.
{{#if ircEnabled}}
- Coordinate with running tasks via `irc` using those ids. `subagent` cancel terminates a task and **cannot carry a message**.
{{else}}
- Use `subagent` action `inspect` or `list` to snapshot manager state.
{{/if}}
- To wait or cancel, use the `subagent` tool; its await/cancel doctrine is authoritative.

{{#if ircEnabled}}
Subagents have no conversation history, but they can reach you and their siblings live via the `irc` tool. Front-load every fact, file path, and direction they need in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{else}}
Subagents have no conversation history. Every fact, file path, and direction they need MUST be explicit in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{/if}}

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
{{#if isolationEnabled}}- `isolated`: run in isolated env; use when tasks edit overlapping files{{/if}}
</parameters>

<rules>
- HARD runtime gate: calls with more than 4 tasks are rejected before any child launches unless `spawnPlan` is complete.
- NEVER assign tasks to run project-wide build/test/lint. Caller verifies after the batch.
- **Subagents do not verify, lint, or format.** Every assignment MUST instruct the subagent to skip all gates and formatters. You run them once at the end across the union of changed files — avoids redundant runs and racing formatter passes.
{{#if ircEnabled}}
- Each task: ≤3–5 explicit files. Overlapping file sets are tolerable when peers can coordinate via `irc`, but still fan out to a cluster when the scopes are cleanly separable.
- No globs, no "update all", no package-wide scope.
{{else}}
- Each task: ≤3–5 explicit files. No globs, no "update all", no package-wide scope. Fan out to a cluster instead.
{{/if}}
- Pass large payloads via `local://<path>` URIs, not inline.
{{#if contextEnabled}}- Put shared constraints in `context` once; do not duplicate across assignments.{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin a read-only discovery step when affected files are genuinely unknown.
</rules>

<parallelization>
{{#if ircEnabled}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B — **unless** B can reasonably ask A for the missing piece over `irc`. Live coordination beats a serial waterfall when the contract is small and easy to describe in a DM.
Still sequence when one task produces a large, evolving contract (generated types, schema migration, core module API) the other consumes wholesale — IRC round-trips do not replace a finished artifact.
Parallel when tasks touch disjoint files, are independent refactors/tests, or only need occasional clarification that can be resolved peer-to-peer.
{{else}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B.
Sequential when one task produces a contract (types, API, schema, core module) the other consumes.
Parallel when tasks touch disjoint files or are independent refactors/tests.
{{/if}}
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
{{#list agents join="\n"}}
# {{name}}
{{description}}
{{/list}}
{{/if}}
</agents>
