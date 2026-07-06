# TUI runtime internals

This document maps the non-theme runtime path from terminal input to rendered output in interactive mode. It focuses on behavior in `packages/tui` and its integration from `packages/coding-agent` controllers.

## Runtime layers and ownership

- **`packages/tui` engine**: terminal lifecycle, stdin normalization, focus routing, render scheduling, differential painting, overlay composition, hardware cursor placement.
- **`packages/coding-agent` interactive mode**: builds component tree, binds editor callbacks and keymaps, reacts to agent/session events, and translates domain state (streaming, tool execution, retries, plan mode) into UI components.

Boundary rule: the TUI engine is message-agnostic. It only knows `Component.render(width)`, `handleInput(data)`, focus, and overlays. Agent semantics stay in interactive controllers.

## Implementation files

- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`../src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`../src/modes/components/custom-editor.ts`](../packages/coding-agent/src/modes/components/custom-editor.ts)
- [`../../tui/src/tui.ts`](../packages/tui/src/tui.ts)
- [`../../tui/src/terminal.ts`](../packages/tui/src/terminal.ts)
- [`../../tui/src/editor-component.ts`](../packages/tui/src/editor-component.ts)
- [`../../tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts)
- [`../../tui/src/components/loader.ts`](../packages/tui/src/components/loader.ts)

## Boot and component tree assembly

`InteractiveMode` constructs `TUI(new ProcessTerminal(), settings.get("showHardwareCursor"))`, applies `settings.get("clearOnShrink")`, and creates persistent containers:

- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `todoContainer`
- `btwContainer`
- `statusLine`
- `hookWidgetContainerAbove`
- `editorContainer` (holds `CustomEditor`)
- `hookWidgetContainerBelow`

`init()` wires the tree in that order, focuses the editor, registers input handlers via `InputController`, subscribes terminal appearance changes into theme auto-detection, starts TUI, and requests a forced render.
A forced render (`requestRender(true)`) resets previous-line caches and cursor bookkeeping before repainting.

## Terminal lifecycle and stdin normalization

`ProcessTerminal.start()`:

1. Enables raw mode and bracketed paste.
2. Attaches resize handler.
3. Creates a `StdinBuffer` to split partial escape chunks into complete sequences.
4. Queries Kitty keyboard protocol support (`CSI ? u`), then enables protocol flags if supported; otherwise enables modifyOtherKeys fallback after a short timeout.
5. Queries OSC 11 background color and enables Mode 2031 appearance notifications for dark/light theme detection.
6. On Windows, attempts VT input enablement via `kernel32` mode flags.
   `StdinBuffer` behavior:

- Buffers fragmented escape sequences (CSI/OSC/DCS/APC/SS3).
- Emits `data` only when a sequence is complete or timeout-flushed.
- Detects bracketed paste and emits a `paste` event with raw pasted text.

This prevents partial escape chunks from being misinterpreted as normal keypresses.

## Input routing and focus model

Input path:

`stdin -> ProcessTerminal -> StdinBuffer -> TUI.#handleInput -> focusedComponent.handleInput`

Routing details:

1. TUI runs registered input listeners first (`addInputListener`), allowing consume/transform behavior.
2. TUI handles global debug shortcut (`shift+ctrl+d`) before component dispatch.
3. If focused component belongs to an overlay that is now hidden/invisible, TUI reassigns focus to next visible overlay or saved pre-overlay focus.
4. Key release events are filtered unless focused component sets `wantsKeyRelease = true`.
5. After dispatch, TUI schedules render.

`setFocus()` also toggles `Focusable.focused`, which controls whether components emit `CURSOR_MARKER` for hardware cursor placement.

## Key handling split: editor vs controller

`CustomEditor` intercepts high-priority combos first (escape, ctrl-c/d/z, ctrl-v, ctrl-p variants, ctrl-t, alt-up, extension custom keys) and delegates the rest to base `Editor` behavior (text editing, history, autocomplete, cursor movement).

`InputController.setupKeyHandlers()` then binds editor callbacks to mode actions:

- cancellation / mode exits on `Escape`
- shutdown on double `Ctrl+C` or empty-editor `Ctrl+D`
- suspend/resume on `Ctrl+Z`
- slash-command and selector hotkeys
- follow-up/dequeue toggles and expansion toggles

This keeps key parsing/editor mechanics in `packages/tui` and mode semantics in coding-agent controllers.

## Render loop and diffing strategy

`TUI.requestRender()` is debounced to one render per tick using `process.nextTick`. Multiple state changes in the same turn coalesce.

`#doRender()` pipeline:

1. Render root component tree to `newLines`.
2. Composite visible overlays (if any).
3. Extract and strip `CURSOR_MARKER` from visible viewport lines.
4. Append segment reset suffixes for non-image lines.
5. Choose full repaint vs differential patch:
   - first frame
   - width change
   - shrink with `clearOnShrink` enabled and no overlays
   - edits above previous viewport
6. For differential updates, patch only changed line range and clear stale trailing lines when needed.
7. Reposition hardware cursor for IME support.

Render writes use synchronized output mode (`CSI ? 2026 h/l`) to reduce flicker/tearing.

## Render safety constraints

Critical safety checks in `TUI`:

- Non-image rendered lines are expected to fit terminal width; the differential path truncates overwide lines as a last-resort guard and can write debug diagnostics when redraw debugging is enabled.
- Overlay compositing includes defensive truncation and post-composite width guarding.
- Width changes force full redraw because wrapping semantics change.
- Cursor position is clamped before movement.

These constraints are runtime guards plus component conventions; renderers should still return width-safe lines rather than rely on truncation.

## Virtual viewport (default-on, `PI_TUI_VIRTUAL_VIEWPORT`)

By default `#doRender` reuses the previous normalized off-screen prefix and only normalizes/diffs the visible window (terminal rows + a small overscan) when the terminal width is unchanged and the off-screen raw prefix is unchanged from the previous frame. This bounds steady-state append/edit work on very long sessions / weak hardware while preserving byte-identical output.

Set `PI_TUI_VIRTUAL_VIEWPORT=0` (or `false`) to opt out and restore the legacy path that normalizes/truncates and diffs the full rendered transcript every frame (`O(total lines)`). The fast path compares the off-screen raw prefix by raw value equality per line, which short-circuits to a fast reference check when components return stable string instances for unchanged lines; reused entries are deterministic normalizations of identical raw lines. Any width change, off-screen edit, forced render (`requestRender(true)`), or first frame transparently falls back to the full path. `PI_TUI_METRICS` exposes `lineCounts` gauges (`rendered`, `normalized`, `measured`, `diffed`, and `offscreenScan`) to observe the bound.

## Resize handling

Resize events are event-driven from `ProcessTerminal` to `TUI.requestRender()`.

Effects:

- Width changes trigger full redraw.
- Height changes trigger full redraw except in Termux and terminal multiplexers, where the renderer avoids scrollback-hostile full replays.
- Viewport/top tracking (`#previousViewportTop`, `#maxLinesRendered`) avoids invalid relative cursor math when content or terminal size changes.
- Overlay visibility can depend on terminal dimensions (`OverlayOptions.visible`); focus is corrected when overlays become non-visible after resize.

## Streaming and incremental UI updates

`EventController` subscribes to `AgentSessionEvent` and updates UI incrementally:

- `agent_start`: starts loader in `statusContainer`.
- `message_start` assistant: creates `streamingComponent` and mounts it.
- `message_update`: updates streaming assistant content; creates/updates tool execution components as tool calls appear.
- `tool_execution_update/end`: updates tool result components and completion state.
- `message_end`: finalizes assistant stream, handles aborted/error annotations, marks pending tool args complete on normal stop.
- `agent_end`: stops loaders, clears transient stream state, flushes deferred model switch, issues terminal completion notification if backgrounded, and runs the user-level completion command hook when configured.

Read-tool grouping is intentionally stateful (`#lastReadGroup`) to coalesce consecutive read tool calls into one visual block until a non-read break occurs.

## Status and loader orchestration

Status lane ownership:

- `statusContainer` holds transient loaders (`loadingAnimation`, `autoCompactionLoader`, `retryLoader`).
- `statusLine` renders persistent status/hooks/plan indicators and drives editor top border updates.

Loader behavior:

- `Loader` updates every 80ms via interval and requests render each frame.
- Escape handlers are temporarily overridden during auto-compaction and auto-retry to cancel those operations.
- On end/cancel paths, controllers restore prior escape handlers and stop/clear loader components.

## Mode transitions and backgrounding

### Bash/Python input modes

Input text prefixes toggle editor border mode flags:

- `!` -> bash mode
- `$` (non-template literal prefix) -> python mode

Escape exits inactive mode by clearing editor text and restoring border color; when execution is active, escape aborts the running task instead.

### Plan mode

`InteractiveMode` tracks plan mode flags, status-line state, active tools, and model switching. Enter/exit updates session mode entries and status/UI state, including deferred model switch if streaming is active.

### Suspend/resume (`Ctrl+Z`)

`InputController.handleCtrlZ()`:

1. Registers one-shot `SIGCONT` handler to restart TUI and force render.
2. Stops TUI before suspend.
3. Sends `SIGTSTP` to process group.

### Background mode (`/background` or `/bg`)

`handleBackgroundCommand()`:

- Rejects when idle.
- Switches tool UI context to non-interactive (`hasUI=false`) so interactive UI tools fail fast.
- Stops loaders/status line and unsubscribes foreground event handler.
- Subscribes background event handler (primarily waits for `agent_end`).
- Stops TUI and sends `SIGTSTP` (POSIX job control path).

On `agent_end` in background with no queued work, controller sends the terminal completion notification and shuts down. The configured `completion.notifyCommand` hook is not limited to background mode; it runs on completed agent turns so local tools such as cmux can receive foreground and background completion events.

## Cancellation paths

Primary cancellation inputs:

- `Escape` during active stream loader: restores queued messages to editor and aborts agent.
- `Escape` during bash/python execution: aborts running command.
- `Escape` during auto-compaction/retry: invokes dedicated abort methods through temporary escape handlers.
- `Ctrl+C` single press: clear editor; double press within 500ms: shutdown.

Cancellation is state-conditional; same key can mean abort, mode-exit, selector trigger, or no-op depending on runtime state.

## Event-driven vs throttled behavior

Event-driven updates:

- Agent session events (`EventController`)
- Key input callbacks (`InputController`)
- terminal resize callback
- terminal appearance callbacks, SIGWINCH theme reevaluation, and git branch watchers in `InteractiveMode`

Throttled/debounced paths:

- TUI rendering is tick-debounced (`requestRender` coalescing).
- Loader animation is fixed-interval (80ms), each frame requesting render.
- Editor autocomplete updates (inside `Editor`) use debounce timers, reducing recompute churn during typing.

The runtime therefore mixes event-driven state transitions with bounded render cadence to keep interactivity responsive without repaint storms.
