# task

> Launch subagents for parallel, optionally isolated work.

## Source
- Entry: `packages/coding-agent/src/task/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/task.md`
- Key collaborators:
  - `packages/coding-agent/src/task/types.ts` — dynamic schema, progress/result types, output caps.
  - `packages/coding-agent/src/task/discovery.ts` — resolve bundled GJC agents.
  - `packages/coding-agent/src/task/agents.ts` — bundled agent definitions and frontmatter parsing.
  - `packages/coding-agent/src/task/executor.ts` — create child sessions, run subagents, collect output.
  - `packages/coding-agent/src/task/parallel.ts` — concurrency-limited scheduling and async semaphore.
  - `packages/coding-agent/src/task/isolation-backend.ts` — isolation backend resolution and platform fallback.
  - `packages/coding-agent/src/task/worktree.ts` — worktree / FUSE / ProjFS setup, patch capture, branch merge.
  - `packages/coding-agent/src/task/output-manager.ts` — session-scoped `agent://` id allocation.
  - `packages/coding-agent/src/task/simple-mode.ts` — `default` / `schema-free` / `independent` field gating.
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts` — resolve `agent://<id>` to saved subagent output.
  - `packages/coding-agent/src/tools/index.ts` — tool registration and recursion-depth gating.
  - `packages/coding-agent/src/sdk/session.ts` — child-session router/tool wiring and per-subagent `AgentOutputManager`.
  - `docs/task-agent-discovery.md` — deeper discovery and precedence notes.
  - `docs/handoff-generation-pipeline.md` — session artifact/handoff persistence patterns used by the wider session layer.

## Inputs

### Default mode (`task.simple = "default"`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | `string` | Yes | Exact agent name for every task item. Resolved at execution time through `discoverAgents(...)`. |
| `tasks` | `Array<{ id: string; description: string; assignment: string; tier?: "fast" \| "balanced" \| "strong" }>` | Yes | Batch of small, self-contained task items. `id` max length 48 in schema; duplicate ids are rejected case-insensitively at runtime. `tier` is advisory unless autorouting is enabled. |
| `context` | `string` | No | Shared background prepended to every subagent system prompt. Trimmed before use. |
| `schema` | `string` | No | JSON-encoded JTD schema. Overrides agent/session output schema when this mode allows task-level schemas. |
| `isolated` | `boolean` | No | Only present when the tool is created with isolation enabled. Requests isolated execution for the whole batch. |

`tasks[].description` is UI-only. `tasks[].assignment` is the actual per-task instruction.

`tasks[].tier` is inert while `task.autorouting.enabled` is `false`. When autorouting is active it selects the model chain for that item, an omitted `tier` routes as `balanced`, and the routed pin overrides the manual model chain. See [Autorouting](#autorouting).

### Schema-free mode (`task.simple = "schema-free"`)

Same as default, except `schema` is rejected by `validateTaskModeParams(...)` in `packages/coding-agent/src/task/index.ts`.

### Independent mode (`task.simple = "independent"`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | `string` | Yes | Exact agent name. |
| `tasks` | `Array<{ id: string; description: string; assignment: string }>` | Yes | Same item shape, but each `assignment` must carry all required background because shared `context` is disabled. |
| `isolated` | `boolean` | No | Same conditional field as above. |

In this mode both `context` and `schema` are rejected.

## Outputs
The tool returns one text block plus `details: TaskToolDetails`.

`details` fields:
- `projectAgentsDir: string | null` — nearest discovered project `agents/` dir.
- `results: TaskResultReceipt[]` — receipt-safe per-task results; async launch responses start empty and later updates/final jobs carry receipts.
- `totalDurationMs: number`
- `usage?: Usage` — sum of per-subagent assistant-message usage.
- raw output/patch filesystem paths are internal and are not exposed; readable artifacts use `agent://` / `local://` references.
- `progress?: AgentProgress[]` — live or final per-task progress snapshots.
- `async?: { state: "running" | "completed" | "failed"; jobId: string; type: "task" }` — present for background execution updates/results.

`TaskResultReceipt` includes:
- identity and status: `index`, `id`, `agent`, `agentSource`, `description`, `status`, `exitCode`
- bounded output metadata: `preview`, `outputRef?`, duration/tokens/usage, retry/setup/abort summaries
- isolated persistence: `persistence?: { outcome: "applied" | "no_changes" | "recovery_available"; ownerWorktreeApplied; recoveryRef? }`
- recovery identity: `recoveryRef` uses a unique session-scoped `local://subagents/<id>-<snowflake>.patch` URI plus byte size and SHA-256; nested/error bundles are JSON-encoded in that artifact
- branch/review/fork-context/repository-binding metadata that passed the receipt sanitizer

Artifacts and side channels:
- Every subagent with an artifacts dir writes `<id>.md`; `agent://<id>` resolves to that file.
- If the output file is JSON, `agent://<id>/<path>` and `agent://<id>?q=<query>` perform JSON extraction in `packages/coding-agent/src/internal-urls/agent-protocol.ts`.
- When the parent session persists artifacts, each subagent also gets `<id>.jsonl` session history.
- Isolated execution writes a unique recovery artifact before cleanup whenever root changes, nested changes, or incomplete-capture evidence exists, including failed/paused/aborted tasks.
- Async mode returns immediately after job registration, then emits `onUpdate(...)` progress snapshots and later hands completion to the session async-job pipeline.

## Flow
1. `TaskTool.create(...)` in `packages/coding-agent/src/task/index.ts` calls `discoverAgents(session.cwd)` once to build the dynamic prompt description from current agents and `task.simple` capabilities.
2. `execute(...)` validates mode-gated fields with `validateTaskModeParams(...)`.
3. It decides async vs sync:
   - sync when `async.enabled` is false
   - sync when the selected cached agent has `blocking === true`
   - sync when `tasks.length === 0`
   - otherwise async job scheduling
4. Async path:
   - allocate unique output ids with `AgentOutputManager.allocateBatch(...)`
   - create one async job per task through `session.asyncJobManager.register(...)`
   - limit concurrent job bodies with `Semaphore(task.maxConcurrency)` from `packages/coding-agent/src/task/parallel.ts`
   - each job body calls `#executeSync(...)` with a one-task batch and the preallocated id
   - `onUpdate(...)` emits aggregate `progress` snapshots and `details.async`
5. Sync path (`#executeSync(...)`) rediscovers agents from disk via `discoverAgents(...)`, so runtime resolution can differ from the earlier prompt description.
6. It resolves the requested agent with `getAgent(...)`, rejects unknown or disabled agents, and enforces parent spawn policy plus `GJC_BLOCKED_AGENT` self-recursion prevention.
7. It derives the effective output schema in priority order: task call `schema` (if allowed) → agent frontmatter `output` → inherited parent session schema.
8. It validates task ids: missing ids and case-insensitive duplicates are immediate errors.
9. If `isolated` was requested, it requires a git repo (`getRepoRoot(...)` / `captureBaseline(...)`) and resolves the actual backend through `resolveIsolationBackendForTaskExecution(...)`.
10. It chooses an artifacts dir from the parent session when available, otherwise a temp dir, and writes `context.md` there when `session.getCompactContext?.()` returns content.
11. It allocates unique ids again if the caller did not preallocate them, then builds `tasksWithUniqueIds`.
12. For each task, it seeds an `AgentProgress` entry and runs `runTask(...)` through `mapWithConcurrencyLimit(...)` using `task.maxConcurrency`.
13. Non-isolated `runTask(...)` calls `runSubprocess(...)` directly with parent cwd.
14. Isolated `runTask(...)`:
   - creates an isolation workspace through the PAL backend
   - binds the managed child session cwd to that execution workspace
   - runs `runSubprocess(...)` inside the workspace
   - captures root/nested deltas for every outcome before cleanup; incomplete nested capture preserves the root delta plus capture errors
   - in branch mode, only successful task branches are merge candidates; in patch mode, only successful root patches are apply candidates
   - always cleans up the isolation workspace/backend after the recovery artifact is durable
15. `runSubprocess(...)` in `packages/coding-agent/src/task/executor.ts` creates a child agent session with:
   - isolated settings snapshot via `Settings.isolated(...)`, forcing `async.enabled = false` and `bash.autoBackground.enabled = false`
   - child `agentId` / `parentTaskPrefix` equal to the allocated task id
   - child internal URL router and `AgentOutputManager` from `packages/coding-agent/src/sdk/session.ts`
   - the shared `context`, optional `context.md` reference, optional isolation worktree path, output schema, and IRC peer roster in the system prompt template
16. Child tool availability is derived from the agent definition plus runtime guards:
   - explicit `agent.tools` if provided
   - auto-add `task` when the agent has `spawns` and recursion depth allows it
   - remove `task` at or past `task.maxRecursionDepth`
   - expand `exec` to `eval` and `bash`
   - strip parent-owned `todo_write` after session creation
17. `runSubprocess(...)` subscribes to child agent events, coalesces progress updates every 150 ms, forwards lifecycle/progress events on the parent event bus, and extracts tool data through `subprocessToolRegistry`.
18. The child must finish through the hidden `yield` tool. If it does not, `runSubprocess(...)` sends up to 3 reminder prompts; the last reminder forces `toolChoice = yield` when supported.
19. Finalization uses `finalizeSubprocessOutput(...)` to reconcile raw assistant text, `yield` payloads, structured schemas, `report_finding` data, and abort states. Output is truncated with `MAX_OUTPUT_BYTES` / `MAX_OUTPUT_LINES` before returning to the parent, but the full raw output is still written to `<id>.md`.
20. After sync task work finishes, `#executeSync(...)` aggregates receipts and reconciles isolation:
   - branch mode records per-branch applied/recovery truth from the actual merged set, including partial merges
   - patch mode dry-checks successful root patches, applies them, then proves the complete owner worktree against the captured baseline plus all applied patches
   - merge/proof exceptions downgrade affected receipts to `recovery_available`
   - nested repo patches apply without staging or committing unrelated owner state; missing/conflicting nested repos downgrade affected receipts
21. The final summary renders receipt-safe `agent://` output and `local://` recovery handles; exit-zero `merge_failed` receipts make both batch and individual async jobs fail.

## Modes / Variants
- Execution mode
  - Sync inline execution — default path.
  - Async background execution — one async job per task item when `async.enabled` is on and the chosen agent is not marked `blocking`.
- Simple mode
  - `default` — accepts shared `context` and per-call `schema`.
  - `schema-free` — accepts `context`, rejects `schema`.
  - `independent` — rejects `context` and `schema`; each assignment stands alone.
- Isolation backend
  - `none` — no isolation.
  - `worktree` — detached git worktree plus baseline replay.
  - `fuse-overlay` — Unix FUSE overlay mount.
  - `fuse-projfs` — Windows ProjFS overlay.
- Isolation merge strategy
  - Patch mode — capture/apply root patches, keep patch artifacts when application fails.
  - Branch mode — commit each task onto `gjc/task/<id>` branch, cherry-pick into parent, preserve failed branches for manual resolution.
- Agent source
  - Project/user agents discovered from configured agent directories.
  - Bundled GJC role agents — the retained canonical four-agent surface from `packages/coding-agent/src/task/agents.ts`.
- Bundled agent types
  - `executor` — bounded implementation, fixes, and refactors.
  - `architect` — read-only architecture and code-review assessment.
  - `planner` — read-only sequencing and acceptance criteria.
  - `critic` — read-only plan critique and actionability review.

## Autorouting

Off by default. When `task.autorouting.enabled` is `true`, each task item is routed by its `tier` instead of the manual model chain.

- Tier map source: `task.autorouting.tiers` (generated from `task.autorouting.setup`; provider order is seeded from `modelProviderOrder` and the model catalog). The removed `task.autorouting.preset` setting no longer participates in routing; enablement without usable tiers falls back to manual model resolution and reports a diagnostic. Contract in `packages/coding-agent/src/config/autorouting-contract.ts`.
- Selectors are exact `provider/modelId` strings with an optional `:minimal|low|medium|high|xhigh` suffix. Globs, bare model ids, and `pi/<role>` aliases are rejected by the generated config schema.
- An omitted `tier` routes as `balanced`. A tier with no usable chain falls back to manual resolution for that item alone, with a bounded reason recorded.
- Preflight tries at most three unique candidates and only advances on transient failures observed before the run starts; there is no mid-run failover. Failed attempts run in staged sessions and attempt-scoped artifacts, so they leave no durable residue.
- Resolved routing evidence (skips, attempts, terminal outcome) is attached to the task result, receipt, renderer, and task-summary prompt.
- Setup: `/routing` opens the smart-routing panel (declare providers in priority order; chains are generated deterministically from the curated tier map and the model catalog, never from credentials). `/routing on|off|status` manages the toggle and prints effective chains.

With autorouting disabled, model resolution is byte-for-byte unchanged.

## Side Effects
- Filesystem
  - Writes `context.md`, `<id>.jsonl`, and `<id>.md` under the session artifacts dir or a temp task dir.
  - In isolated mode writes unique session-scoped recovery artifacts containing root patches or JSON root/nested/capture-error bundles.
  - Creates/removes worktrees or overlay mount directories.
  - In branch mode creates temporary worktrees and task branches.
- Network
  - Child sessions may use whichever networked tools/models their active tool set permits.
- Subprocesses / native bindings
  - `fuse-overlayfs` and `fusermount`/`fusermount3` for FUSE isolation.
  - ProjFS native bindings via `@gajae-code/natives` on Windows.
  - Git operations for baseline capture, patch apply/proof, worktrees, branches, stash, and cherry-pick; nested patches are left as working-tree changes rather than committing owner state.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Creates child `AgentSession` instances with isolated settings snapshots.
  - Registers async jobs in `session.asyncJobManager` for background task mode.
  - Emits `task:subagent:event`, `task:subagent:progress`, and `task:subagent:lifecycle` on the parent event bus.
  - Allocates session-scoped output ids through `AgentOutputManager` so `agent://` remains unique across invocations and resumes.
  - Shares the parent `local://` root with subagents by passing `localProtocolOptions` through `createAgentSession(...)`.
- User-visible prompts / interactive UI
  - Async mode streams aggregate progress updates.
  - Missing-`yield` recovery sends up to three internal reminder prompts to the child session.
  - Final summaries include `<system-notification>` blocks for isolation fallbacks or merge failures.
- Background work / cancellation
  - Parent abort stops scheduling new work, aborts active child sessions, and marks unscheduled tasks as skipped.
  - Async jobs keep their own cancellation via `AsyncJobManager`.
  - Await timeouts are observation windows only: they do not stop, fail, or make a subagent stale. Inspect/list and continue work; cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong.

## Limits & Caps
- Per-subagent output truncation: `MAX_OUTPUT_BYTES = 500_000` and `MAX_OUTPUT_LINES = 5000` in `packages/coding-agent/src/task/types.ts`. Full raw output is still written to `<id>.md` before truncation is returned to the caller.
- Progress coalescing in child execution: `PROGRESS_COALESCE_MS = 150` in `packages/coding-agent/src/task/executor.ts`.
- Recent output tail for progress: `RECENT_OUTPUT_TAIL_BYTES = 8 * 1024` and `recentOutput` keeps the last 8 non-empty lines in `packages/coding-agent/src/task/executor.ts`.
- Missing-`yield` reminder retries: `MAX_YIELD_RETRIES = 3` in `packages/coding-agent/src/task/executor.ts`.
- Task id schema cap: `tasks[].id` `maxLength: 48` in `packages/coding-agent/src/task/types.ts`.
- Prompt text says ids should be `≤32` chars, but the runtime schema allows 48; this mismatch is real.
- Async/full sync parallelism both use `task.maxConcurrency` from settings:
  - sync path: `mapWithConcurrencyLimit(...)`
  - async path: `Semaphore(...)` around job bodies
- Recursion depth gate: `task.maxRecursionDepth` from settings; `packages/coding-agent/src/tools/index.ts` hides the `task` tool at or beyond the limit, and `runSubprocess(...)` also strips child `task` access at max depth.
- Final inline summary preview per task uses `fullOutputThreshold = 5000` chars in `packages/coding-agent/src/task/index.ts`; longer outputs are summarized while `agent://<id>` points to the full artifact.

## Errors
- Most validation failures are returned as normal tool text with empty `results`, not thrown:
  - invalid simple-mode fields
  - unknown/disabled agent
  - missing tasks
  - missing/duplicate task ids
  - spawn-policy denial
  - requesting `isolated` while isolation mode is `none`
- Isolated execution without a git repo returns `Isolated task execution requires a git repository. ...`.
- Backend resolution can return a hard error (`ProjFS isolation initialization failed...`) or a non-fatal warning with fallback to `worktree`.
- `mapWithConcurrencyLimit(...)` fails fast on non-abort worker exceptions; already completed results are preserved only in the thrown path’s local state, not surfaced unless the caller catches and converts them.
- Child-session failures retain failed/paused/aborted status; captured isolated changes remain recovery-only and are never auto-applied.
- If the child omits `yield`, `finalizeSubprocessOutput(...)` injects warnings such as `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.`
- Async scheduling failures are accumulated per task; if no jobs start, the tool returns `Failed to start background task jobs: ...`.
- An async child with no receipt, or any receipt whose status is not `completed`, terminates its individual async job as failed (paused remains paused).
- `agent://<id>` resolution errors are model-visible when another tool reads them: no session, no artifacts dir, missing id, conflicting extraction syntax, or invalid JSON for extraction.

## Notes
- Bundled agent definitions are embedded in `packages/coding-agent/src/task/agents.ts`.
- `TaskTool.create(...)` caches discovered agents only for description rendering and the async blocking-agent decision. `#executeSync(...)` rediscovers agents each call.
- Custom agent frontmatter can override bundled agents by name. Bundled definitions are embedded at build time in `packages/coding-agent/src/task/agents.ts`.
- Child sessions do not inherit conversation history automatically. The only built-in carry-over is shared `context`, optional `context.md`, workspace tree/context files, and shared `local://` root.
- `Settings.isolated(...)` gives each child a session-isolated settings snapshot; tool enablement is recomputed inside the child session rather than sharing mutable parent tool state.
- Plan mode mutates an `effectiveAgent` with a read-only tool subset and plan-mode prompt text, but `runSubprocess(...)` is still invoked with `agent` rather than `effectiveAgent`. Model/thinking/schema overrides use the effective agent; prompt/tool/spawn restrictions do not fully flow through this call path.
- Branch-mode merge temporarily stashes the parent repo before cherry-picking task branches. Partial/failed merges preserve per-branch applied truth and recovery handles.
- Patch mode applies only successful root patches and requires exact owner-worktree proof before reporting `applied`.
- Nested git repos are diffed independently. Recovery bundles include nested patches and capture errors; application never stages or commits pre-existing nested owner changes.
- `agent://` ids are numeric-prefixed (`0-Task`, `1-Task`, nested like `0-Parent.0-Child`) by `AgentOutputManager`; this is what prevents artifact collisions across repeated or nested task invocations.
