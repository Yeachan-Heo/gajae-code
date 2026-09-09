# computer

> Supervisor-gated macOS desktop screenshot and input control through the native computer controller.

## Source

- Entry: `packages/coding-agent/src/tools/computer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/computer.md`
- Renderer: `packages/coding-agent/src/tools/computer/render.ts`
- Native controller: `@gajae-code/natives` `ComputerController`

## Availability

`computer` is callable by default on supported Apple Silicon macOS (`process.platform === "darwin"` and `process.arch === "arm64"`).

An explicit `computer.enabled=false` disables it. When `computer.enabled` is unset, `computer.alwaysOn=false` also disables it; `computer.enabled=true` explicitly enables it on a supported host.

When disabled, every action including `screenshot` returns `COMPUTER_DISABLED`. Disabled catalog/listing paths do not construct `ComputerController`, start hotkeys, probe Screen Recording, probe Accessibility, capture screenshots, or expose the callable schema to `search_tool_bm25`.

## Inputs

The model action object uses an exact snake_case discriminated schema. CamelCase fields are rejected.

### Shared fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | see actions below | Yes | Dispatch action. |
| `timeout` | `number` | No | Maximum action time in seconds. |
| `include_screenshot` | `boolean` | No | Request a bounded post-action screenshot when supported. |

### Actions

| Action | Required fields | Optional fields |
| --- | --- | --- |
| `screenshot` | none | shared |
| `click` | `x`, `y` | `button`, shared |
| `double_click` | `x`, `y` | `button`, shared |
| `move` | `x`, `y` | `button`, shared |
| `drag` | `x`, `y`, `to_x`, `to_y` | `button`, shared |
| `scroll` | `x`, `y`, `scroll_x`, `scroll_y` | shared |
| `type` | `text` | shared |
| `keypress` | `keys` | shared |
| `wait` | `ms` | shared |

`button` is one of `left`, `right`, or `middle`.

## Coordinate contract

`x`, `y`, `to_x`, and `to_y` are screenshot pixels in the latest screenshot coordinate frame. They are not CSS pixels and not normalized fractions. The screenshot result records dimensions, scale, origin, display epoch, and capture id when supplied by native code. Coordinate actions must not clamp invalid coordinates; native code returns `COMPUTER_COORD_INVALID` or `COMPUTER_DISPLAY_STALE` before input when the coordinate/display contract cannot be satisfied.

## Scope and limitations

- Capture and coordinates cover only the primary display. The tool has no PID or window target.
- Click, move, drag, scroll, type, and keypress are global, unscoped input; the current focus and macOS determine where they go.
- A side-effecting action captures the global cursor once and restores it after held input is released. A batch containing input owns one native capture-to-restore transaction across all ordered input, wait, and screenshot steps.
- Do not use the desktop manually while a side-effecting action or batch runs; concurrent use is unsafe, and restoration can overwrite cursor movement made during the transaction.
- `screenshot` is read-only, and `wait` posts no input. Screenshot/wait-only batches do not move or restore the cursor.
- The kill switch gates future input, but it does not isolate the desktop or restore application focus. Cursor restoration does not target or reactivate any PID or window.
- Key sequences recheck suspension, hotkey liveness, and heartbeat freshness between complete keys. A key already pressed gets its release attempt before stopping. Keyboard-event creation failures stop the sequence and retain the pressed key for cleanup before cursor restoration; the original failure remains visible even if cleanup succeeds. Persistent backend failure can prevent release: cleanup is best-effort within the transaction, not an acknowledgement of delivery by macOS.

## Errors

Stable computer error codes include:

- `COMPUTER_DISABLED`
- `COMPUTER_SUSPENDED`
- `COMPUTER_SUPERVISOR_NOT_LIVE`
- `COMPUTER_PERMISSION_REQUIRED` (Accessibility or Screen & System Audio Recording)
- `COMPUTER_SCREENSHOT_FAILED` (capture failed after the current-process preflight passed)
- `COMPUTER_DISPLAY_STALE`
- `COMPUTER_COORD_INVALID`
- `COMPUTER_CANCELLED`
- `COMPUTER_KEY_EVENT_FAILED` (native virtual-key event creation failed)
- `COMPUTER_CURSOR_CAPTURE_FAILED`
- `COMPUTER_CURSOR_RESTORE_FAILED`
- `COMPUTER_TRANSACTION_FAILED`

TS handles settings/platform exposure, UX mapping, screenshot persistence, and audit output. Native execution remains the side-effect authority for supervisor state, permissions, display freshness, coordinate validation, cancellation, release-all behavior, and the serialized cursor capture/restore transaction. Whole batches cross the native boundary once; TypeScript does not perform cursor cleanup.

macOS TCC checks apply to the executable that is currently running the tool.
For source-linked GJC this is normally Bun; for a compiled launch it is the
compiled `gjc` binary. Grant the permission to that launcher and fully quit
and relaunch GJC after changing the grant. GJC's macOS development and
single-host release builds use a stable ad-hoc designated requirement so a
rebuild does not silently become a new TCC identity.

## Rendering

The TUI renderer is bounded: it shows action, coordinates, scroll/key/wait summary, screenshot dimensions/byte count/capture id, supervisor status, and error code. It never renders raw screenshot base64.
