# computer

> macOS desktop screenshot and input control through the native supervisor-gated computer controller; available by default on supported Apple Silicon macOS.

## Source

- Entry: `packages/coding-agent/src/tools/computer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/computer.md`
- Renderer: `packages/coding-agent/src/tools/computer/render.ts`
- Native controller: `@gajae-code/natives` `ComputerController`

## Availability

`computer` is first-class in the product catalog and documentation. On supported Apple Silicon macOS it is callable by default; on unsupported platforms it is listed but not callable.

Callable activation requires all of:

1. Apple Silicon macOS (`process.platform === "darwin"` and `process.arch === "arm64"`), and
2. `computer.alwaysOn` (default `true`) or `computer.enabled` set to `true`.

On supported Apple Silicon macOS the tool is available by default because `computer.alwaysOn` defaults to `true`. Set `computer.alwaysOn=false` to disable default availability; `computer.enabled=true` remains a manual per-session enable path on supported hosts.

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

## Errors

Stable computer error codes include:

- `COMPUTER_DISABLED`
- `COMPUTER_SUSPENDED`
- `COMPUTER_SUPERVISOR_NOT_LIVE`
- `COMPUTER_PERMISSION_REQUIRED`
- `COMPUTER_DISPLAY_STALE`
- `COMPUTER_COORD_INVALID`
- `COMPUTER_CANCELLED`

TS handles settings/platform exposure and UX mapping. Native `execute_action` remains the side-effect authority for supervisor state, permissions, display freshness, coordinate validation, cancellation, and release-all behavior.

## Rendering

The TUI renderer is bounded: it shows action, coordinates, scroll/key/wait summary, screenshot dimensions/byte count/capture id, supervisor status, and error code. It never renders raw screenshot base64.
