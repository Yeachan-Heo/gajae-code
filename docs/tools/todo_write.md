# todo_write

> Applies ordered mutations to the session todo list and returns a text summary plus the full phase/task state.

## Source
- Entry: `packages/coding-agent/src/tools/todo-write.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/todo-write.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers tool, exposes session hooks, gates availability.
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` — updates the visible todo UI on tool completion.
  - `packages/coding-agent/src/session/agent-session.ts` — stores cached phases, auto-clears done/dropped tasks, emits failure reminders.
  - `packages/coding-agent/src/modes/controllers/todo-command-controller.ts` — `/todo` command path, custom-entry persistence, transcript reminder injection.
  - `packages/coding-agent/src/tools/render-utils.ts` — collapsed-preview cap for renderer trees.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ops` | `TodoOpEntry[]` | Yes | Ordered operations to apply. `minItems: 1`.

### `TodoOpEntry`

| Op | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `init` | `list` | None of the other fields are used | Replaces the entire list with `list`; every new task starts `pending` before normalization. |
| `start` | `task` | None | Marks one task `in_progress`; any other `in_progress` task is demoted to `pending`. |
| `done` | `task` or `phase` | None | Marks the target task or phase `completed`. |
| `drop` | `task` or `phase` | None | Marks the target task or phase `abandoned`. |
| `rm` | `task` or `phase` or neither | None | Removes the target task, clears the phase's task list, or clears all task lists. |
| `append` | `phase`, `items` | None | Appends new `pending` tasks to a phase; creates the phase if missing. |
| `note` | `task`, `text` | None | Appends one trimmed note string to the task's `notes` array. |

### Fields used inside ops

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"init" | "start" | "done" | "rm" | "drop" | "append" | "note"` | Yes | Operation discriminator. |
| `list` | `{ phase: string; items: string[] }[]` | For `init` | Full replacement payload. Each `items` array has `minItems: 1`. |
| `task` | `string` | For `start`; for task-targeted `done`/`drop`/`rm`/`note` | Exact task content match. |
| `phase` | `string` | For `append`; for phase-targeted `done`/`drop`/`rm`; required when `done`/`drop` omit `task` | Exact phase name match, except `append` lazily creates a missing phase. |
| `items` | `string[]` | For `append` | Tasks to append. `minItems: 1`. |
| `text` | `string` | For `note` | Note text; trailing whitespace is stripped before storing. Empty-after-trim is rejected. |

## Outputs
The tool returns a single-shot `AgentToolResult`:

- `content`: one text part containing the summary from `formatSummary(...)`.
  - Empty final state with no errors: `Todo list cleared.`
  - Non-empty final state: remaining-item list, current phase progress, then a per-phase tree.
  - If the active `in_progress` task has notes, the summary includes the note bodies inline.
  - If any op produced validation/runtime errors, the summary starts with `Errors: ...` but still returns the mutated state.
- `details`:
  - `phases: TodoPhase[]`
  - `storage: "session" | "memory"`

`TodoPhase` / `TodoItem` state model:

- `TodoPhase`: `{ name: string, tasks: TodoItem[] }`
- `TodoItem`: `{ content: string, status: "pending" | "in_progress" | "completed" | "abandoned", notes?: string[] }`

The TUI renderer (`todoWriteToolRenderer`) merges call and result into one transcript block, renders phases as a tree, shows note counts as superscripts, and renders the note bodies only for the current `in_progress` task. Collapsed transcript previews cap tree items at `PREVIEW_LIMITS.COLLAPSED_ITEMS` (`8`).

## Flow
1. `TodoWriteTool.execute(...)` clones the current cached phases from `session.getTodoPhases?.() ?? []` (`packages/coding-agent/src/tools/todo-write.ts`).
2. `applyParams(...)` walks `params.ops` in order and applies each entry with `applyEntry(...)`.
3. Each op mutates the working phase array:
   - `initPhases(...)` rebuilds the list from scratch.
   - `start` resolves a task by exact `content`, demotes every other `in_progress` task to `pending`, then marks the target `in_progress`.
   - `done` / `drop` use `getTaskTargets(...)` to target one task or one phase; raw validation rejects either operation when both targets are absent.
   - `rm` removes one task, clears one phase's `tasks`, or clears all phases' task arrays.
   - `appendItems(...)` resolves or creates the target phase and pushes new `pending` tasks unless the same task content already exists anywhere.
   - `note` trims trailing whitespace, rejects empty text, and appends the note to `task.notes`.
4. Missing task/phase references are recorded in an `errors` array by `resolveTaskOrError(...)` / `resolvePhaseOrError(...)`; execution continues through the rest of the batch.
5. After the full batch, `normalizeInProgressTask(...)` enforces the single-active-task invariant:
   - if multiple tasks are `in_progress`, only the first stays active and the rest become `pending`;
   - if none are `in_progress`, the first `pending` task in phase/task order is auto-promoted to `in_progress`.
6. `execute(...)` stores the normalized phases with `session.setTodoPhases?.(...)` and reports `storage` as `"session"` when `session.getSessionFile()` exists, else `"memory"`.
7. The agent runtime also watches `todo_write` tool results in `packages/coding-agent/src/session/agent-session.ts`; successful results refresh cached todos, failed results inject a hidden next-turn reminder telling the model that todo progress is not visible until it retries.
8. The event controller updates the visible todo UI from `result.details.phases` on success, or shows a warning on error (`packages/coding-agent/src/modes/controllers/event-controller.ts`).

## Modes / Variants
### State transitions

| Current status | `start` | `done` | `drop` | `rm` | `append` | `note` |
| --- | --- | --- | --- | --- | --- | --- |
| `pending` | `in_progress` on target | `completed` | `abandoned` | Removed | New tasks enter as `pending` | No status change |
| `in_progress` | Target stays `in_progress`; non-target active tasks become `pending` | `completed` | `abandoned` | Removed | No status change | No status change |
| `completed` | Can be set back to `in_progress` if targeted | Stays `completed` | Becomes `abandoned` if targeted | Removed | No status change | No status change |
| `abandoned` | Can be set back to `in_progress` if targeted | Becomes `completed` if targeted | Stays `abandoned` | Removed | No status change | No status change |

Normalization then re-applies the single-active-task rule after the full op batch.

### Op targeting rules
- `done`, `drop`:
  - `task` set: affect one exact-content task.
  - else `phase` must be set: affect every task in that exact-name phase.
- `rm`:
  - `task` set: remove one exact-content task.
  - else `phase` set: clear every task in that exact-name phase.
  - else: clear every task in every phase.
- `append` is the only op that creates a missing phase.
- `note` only targets a single task.
- `init` discards previous phases entirely.

### Markdown round-trip helpers
The same file also exposes non-tool helpers used by `/todo`:
- `phasesToMarkdown(...)` serializes phases as headings plus checklist items (`[ ]`, `[/]`, `[x]`, `[-]`) with blockquote note bodies.
- `markdownToPhases(...)` parses that format, defaults orphan tasks into a `Todos` phase, accepts `>` as an `in_progress` marker and `~` as `abandoned`, and runs the same normalization step.

## Side Effects
- Filesystem
  - None in the tool itself.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Mutates the session todo cache through `setTodoPhases`.
  - `storage` reports whether the session has a backing session file, but the tool does not append a custom session entry itself.
  - Successful tool-result messages carry `details.phases`; `getLatestTodoPhasesFromEntries(...)` can reconstruct state later from those transcript entries.
  - Failed `todo_write` results cause `agent-session` to enqueue a hidden next-turn reminder (`customType: "todo-write-error-reminder"`).
- User-visible prompts / interactive UI
  - Transcript block is rendered by `todoWriteToolRenderer` and merged with the call line.
  - `event-controller` updates the visible todo panel from successful results.
  - On error, `event-controller` shows `Todo update failed...`; the visible panel may stay stale until a later successful call.
- Background work / cancellation
  - `AgentSession.setTodoPhases(...)` schedules auto-clear timers for `completed` / `abandoned` tasks via `tasks.todoClearDelay`.

## Limits & Caps
- `ops` array: `minItems: 1` (`todoWriteSchema`).
- `init.list[*].items`: `minItems: 1`.
- `append.items`: `minItems: 1`.
- Renderer collapsed preview: `PREVIEW_LIMITS.COLLAPSED_ITEMS = 8` (`packages/coding-agent/src/tools/render-utils.ts`).
- Auto-clear delay: `tasks.todoClearDelay` default `60` seconds; `< 0` disables auto-clear, `0` clears on the next microtask (`packages/coding-agent/src/session/agent-session.ts`).
- Tool execution mode: `concurrency = "exclusive"`, `strict = true`, `loadMode = "discoverable"`.

## Errors
- The tool does not throw for ordinary bad op payloads; it accumulates human-readable strings in `errors` and still returns success with the mutated state.
- Error strings come from the helpers in `packages/coding-agent/src/tools/todo-write.ts`, including:
  - `Missing list for init operation`
  - `Missing task content`
  - `Task "..." not found` with an extra empty-list hint when applicable
  - `Missing phase name`
  - `Phase "..." not found`
  - `Missing phase name for append operation`
  - `Missing items for append operation`
  - `Task "..." already exists`
  - `Missing text for note operation`
- Because ops are processed in order, earlier errors do not roll back later ops.
- Runtime-level tool failure is handled outside the tool body: `agent-session` injects a hidden reminder and the event controller warns the user that visible progress may be stale.
- Idempotency is op-specific:
  - `init` is a full replacement; replaying the same payload yields the same state.
  - `start`, `done`, and `drop` are effectively idempotent on an existing target state, but `start` also demotes any other active task.
  - `rm` is not idempotent for targeted removals: the second call errors because the task or phase is gone.
  - `append` is not idempotent: duplicate task content is rejected with `Task "..." already exists`.
  - `note` is append-only and never idempotent; replaying it adds another note entry.

## Notes
- Task lookup is exact string equality inside the tool. The model-facing prompt says task content and phase names are identifiers and should stay unique; `append` enforces task uniqueness globally, but `init` does not validate duplicate task or phase names.
- `findTaskByContent(...)` returns the first matching task across phases. Duplicate task contents make later targeted ops ambiguous.
- `normalizeInProgressTask(...)` runs after the whole batch, not after each op. A single call can intentionally build an intermediate invalid state and rely on final normalization.
- `storage: "session"` means the session has a session-file backing; it does not mean this tool wrote a durable custom entry.
- Reload persistence differs by path:
  - plain `todo_write` calls survive in transcript tool-result details;
  - `/todo` command edits additionally append `customType: "user_todo_edit"` entries and inject a visible-to-model `<system-reminder>` developer message describing the manual edit.
- On session resume, `AgentSession.#syncTodoPhasesFromBranch()` strips `completed` and `abandoned` tasks before restoring the cached list. The `/todo` command works around that by reading the latest transcript/custom-entry state so historical done/dropped tasks still appear to the user.
- Tool availability is gated by `todo.enabled`, and the registry excludes it when `includeYield` is enabled (`packages/coding-agent/src/tools/index.ts`).
- Subagents do not inherit `todo_write`; `packages/coding-agent/src/task/executor.ts` filters it out as a parent-owned tool.
