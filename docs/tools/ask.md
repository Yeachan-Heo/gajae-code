# ask

> Prompts the interactive user for one or more choices or free-form answers.

## Source
- Entry: `packages/coding-agent/src/tools/ask.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ask.md`
- Key collaborators:
  - `packages/coding-agent/src/config/settings-schema.ts` — `ask.timeout` / `ask.notify` defaults
  - `packages/coding-agent/src/modes/theme/theme.ts` — checkbox and tree glyphs for TUI rendering
  - `packages/coding-agent/src/tui.ts` — status-line rendering

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `questions` | `Question[]` | Yes | One or more questions. Empty arrays are rejected by schema and also guarded at runtime. |

### `Question`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Stable identifier used in multi-question results. |
| `question` | `string` | Yes | Prompt text shown to the user. |
| `options` | `{ label: string }[]` | Yes | Explicit options. The UI always appends `Other (type your own)`; callers must not include it. |
| `multi` | `boolean` | No | Enables multi-select mode. Default: `false`. |
| `recommended` | `number` | No | Zero-based recommended option index. In single-select mode the label gets ` (Recommended)` appended in the UI. |

## Outputs
- Single-shot result.
- `content[0].text` is plain text:
  - single question: `User selected: ...` and/or `User provided custom input: ...`
  - multiple questions: `User answers:` followed by one line per `id`
- `details`:
  - single question: `{ question, options, multi, selectedOptions, customInput? }`
  - multiple questions: `{ results: QuestionResult[] }`, where each item includes `id`, `question`, `options`, `multi`, `selectedOptions`, and optional `customInput`
- Cancellation and headless cases throw instead of returning a structured success result.

## Flow
1. `AskTool.createIf()` registers the tool when the session has a UI, is workflow-gate eligible, or exposes a workflow-gate emitter; a plain headless session without any answer surface never gets it.
2. `execute()` prefers a local interactive UI (`context.ui`) when one exists. Otherwise it uses a registered ask answer source (e.g. an SDK/ACP client) or, without one, the durable workflow gate (`packages/coding-agent/src/tools/ask.ts`).
3. It reads `ask.timeout` from settings, converts seconds to milliseconds, and disables timeout entirely while plan mode is enabled (`packages/coding-agent/src/tools/ask.ts`).
4. If `ask.notify` is not `off`, it sends a terminal notification: `Waiting for input`.
5. For each question, `askSingleQuestion()` drives either:
   - single-select list + optional editor for `Other`
   - multi-select checkbox loop + `Done selecting` sentinel + optional editor for `Other`
6. In multi-question mode, left/right arrow handlers enable back/forward navigation between questions and preserve prior selections.
7. If a timeout fires before any selection/custom input, the tool auto-selects the recommended option, or the first option when no valid `recommended` index exists.
8. If the user cancels without timeout, `execute()` aborts the tool context and throws `ToolAbortError("Ask tool was cancelled by the user")`.
9. On success it formats human-readable text plus structured `details`; the TUI renderer uses `details` for rich display.

## Modes / Variants
- Single question: returns flattened `details` fields for one question.
- Multiple questions: returns `details.results[]` and allows back/forward navigation across questions.
- Single-select: one option or custom input.
- Multi-select: toggled checkbox list, `Done selecting` sentinel only when forward navigation is not active.

## Side Effects
- User-visible prompts / interactive UI
  - Opens a selection dialog via `context.ui.select(...)`.
  - Opens a text editor dialog via `context.ui.editor(...)` for `Other`.
  - Sends a terminal notification unless `ask.notify=off`.
- Session state
  - Reads plan-mode state to disable timeouts.
  - Calls `context.abort()` on headless use or user cancellation.
- Background work / cancellation
  - Wraps UI waits in `untilAborted(...)` so abort signals interrupt pending dialogs.

## Limits & Caps
- `questions` must contain at least 1 item (`askSchema` in `packages/coding-agent/src/tools/ask.ts`).
- `ask.timeout` default is `0` (disabled); a positive value auto-selects the recommended option after that many seconds (`packages/coding-agent/src/config/settings-schema.ts`).
- `GJC_ASK_ACK_TIMEOUT_MS` bounds how long a **headless** ask waits for an answer source to take the question, in milliseconds. Unset, empty, `0`, negative, or non-integer values disable the bound, which is the default. On expiry the ask logs `ask_answer_source_ack_timeout`, aborts the enclosing turn, and throws `ToolAbortError("Ask was aborted: no answer source acknowledged the question within Ns")`. It is deliberately separate from `ask.timeout`: `ask.timeout` auto-selects an answer, while this window exists to end a wait that no answer source ever acknowledged, and a remote responder may legitimately answer later than `ask.timeout`.
- Prompt guidance says provide 2-5 options, but code does not enforce that (`packages/coding-agent/src/prompts/tools/ask.md`).
- Timeout only applies to the option picker; once the user chooses `Other`, the editor has no timeout (`packages/coding-agent/src/prompts/tools/ask.md`).

## Errors
- Missing interactive UI: throws `ToolAbortError("Ask tool requires interactive mode")`.
- User cancels picker/editor without timeout: throws `ToolAbortError("Ask tool was cancelled by the user")`.
- Abort signal during input: converted to `ToolAbortError("Ask input was cancelled")`.
- Remote answer source closes the ask: throws `ToolAbortError("Ask was cancelled by the remote client")`.
- `GJC_ASK_ACK_TIMEOUT_MS` expires with no answer source: throws `ToolAbortError("Ask was aborted: no answer source acknowledged the question within Ns")`.
- Empty `questions` at runtime returns a text error payload instead of throwing: `Error: questions must not be empty`.

## Notes
- `recommended` is only a UI hint; invalid indexes are ignored.
- In single-select mode the returned `selectedOptions` value strips the appended ` (Recommended)` suffix.
- Multi-select results preserve selection order by `Set` insertion order, not original option order after arbitrary toggles.
- Option labels and prompt text are returned verbatim in `details`; the tool does not interpret them beyond UI affordances like `Other` and ` (Recommended)`.
