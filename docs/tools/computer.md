# computer

> Explicitly enabled macOS desktop screenshot and input control through the native supervisor-gated computer controller.

## Source

- Entry: `packages/coding-agent/src/tools/computer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/computer.md`
- Renderer: `packages/coding-agent/src/tools/computer/render.ts`
- Native controller: `@gajae-code/natives` `ComputerController`

## Availability

`computer` is first-class in the product catalog and documentation, but it is not a callable tool by default.

Callable activation requires all of:

1. macOS (`process.platform === "darwin"`), and
2. `computer.enabled` or `computer.alwaysOn` set to `true`.

When disabled, every action including `screenshot` returns `COMPUTER_DISABLED`. Disabled catalog/listing paths do not construct `ComputerController`, start hotkeys, probe Screen Recording, probe Accessibility, capture screenshots, or expose the callable schema to `search_tool_bm25`.

## Managed tmux ownership

On Apple Silicon macOS, a new GJC-managed tmux session starts a private packaged computer-owner helper before tmux is created. A packaged GJC launched inside an existing tmux session starts the same helper during root startup. The inner GJC process holds an authenticated Unix-socket lease and routes normal `computer` actions through that helper, so Screen Recording and Accessibility/PostEvent authority remain attached to the packaged GJC identity across tmux detach and reattach.

The broker is local-only, hidden from public CLI help, and fail-closed. Its socket lives in a mode-`0700` temporary directory, requires a random per-launch token, accepts one leased client, serializes actions, and exits when the inner GJC lease closes. Screenshot bytes are transported in memory and are never persisted by the broker. Native supervisor, kill-switch, permission, display-epoch, coordinate, and release-all enforcement remain authoritative in the helper process.

Direct launches without managed broker metadata keep the existing in-process native controller. A managed session marked as broker-required never silently falls back to the in-process controller when its helper is missing, unclaimed, disconnected, or unavailable; only computer actions fail closed while the rest of the session remains usable.

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

## Errors

Stable computer error codes include:

- `COMPUTER_DISABLED`
- `COMPUTER_SUSPENDED`
- `COMPUTER_SUPERVISOR_NOT_LIVE`
- `COMPUTER_PERMISSION_REQUIRED`
- `COMPUTER_DISPLAY_STALE`
- `COMPUTER_COORD_INVALID`
- `COMPUTER_CANCELLED`
- `COMPUTER_BROKER_UNAVAILABLE` — the required packaged owner could not be started, claimed, or reached; a managed session never falls back to an inner native controller.
- `COMPUTER_BROKER_TIMEOUT` — the broker lease or action exceeded its bounded deadline.

Broker authentication and framing failures are internal transport errors and are not public configuration surfaces.

TS handles settings/platform exposure and UX mapping. Native `execute_action` remains the side-effect authority for supervisor state, permissions, display freshness, coordinate validation, cancellation, and release-all behavior.

## Rendering

The TUI renderer is bounded: it shows action, coordinates, scroll/key/wait summary, screenshot dimensions/byte count/capture id, supervisor status, and error code. It never renders raw screenshot base64.
