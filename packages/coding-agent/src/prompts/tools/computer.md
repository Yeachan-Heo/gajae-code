# computer

`computer` is available by default on supported Apple Silicon macOS. It controls the real desktop, so use it only when the task genuinely needs real desktop screenshot or input control.

## Safety contract

- Disabled means disabled: when the tool is disabled (`computer.alwaysOn=false` with `computer.enabled` unset/false) or the platform is unsupported, every action including `screenshot` fails with `COMPUTER_DISABLED` and captures nothing.
- Callable only on Apple Silicon macOS (`arm64` darwin); available by default there, with `computer.alwaysOn=false` as the off-switch and `computer.enabled=true` as the manual enable path.
- Native execution remains supervisor-gated. If the stop/suspend supervisor is unavailable, stale, suspended, permissioned off, display-stale, or cancelled, the action fails closed with a `COMPUTER_*` code. Coordinate actions carry the latest known screenshot display epoch when one is available so display-topology changes fail with `COMPUTER_DISPLAY_STALE`.
- Respect the user's stop/suspend request immediately. Do not loop desktop actions after a stop/suspend/error.
- The user can stop or suspend the session at any time with the configured kill-switch hotkey (default `Control+Option+Command+Escape`). If you see `COMPUTER_CANCELLED` or `COMPUTER_SUPERVISOR_NOT_LIVE`, stop and wait for the user.

## Coordinate contract

Coordinates are screenshot pixels, not CSS pixels and not normalized fractions. Use the latest successful `screenshot` dimensions and origin/scale metadata as the coordinate frame. Do not guess coordinates outside the screenshot bounds.

For stale-display protection to apply, derive pointer coordinates from a successful screenshot in the same tool session; a screenshot-first `batch` is preferred because later coordinate steps are validated against that screenshot and carry its display epoch into native execution. If a coordinate is out of bounds, the batch stops and reports `COMPUTER_COORD_INVALID`. Always capture a fresh screenshot before acting if the display may have changed.

## Actions

The model action object uses exactly these snake_case actions and fields:

- `screenshot` — capture the enabled desktop.
- `click` — `x`, `y`, optional `button` (`left`, `right`, `middle`).
- `double_click` — `x`, `y`, optional `button`.
- `move` — `x`, `y`, optional `button`.
- `drag` — `x`, `y`, `to_x`, `to_y`, optional `button`.
- `scroll` — `x`, `y`, `scroll_x`, `scroll_y`.
- `type` — `text`.
- `keypress` — `keys` string array.
- `wait` — `ms`.
- `batch` — `actions`: a non-empty array of the single actions above. Steps run in order and the result includes per-step status and the last screenshot captured inside the batch.

Shared optional fields: `timeout` seconds and `include_screenshot` for a bounded post-action screenshot when supported.

Do not use camelCase fields such as `doubleClick`, `toX`, `scrollX`, or `includeScreenshot` in the model action object.

## Examples

Take a single screenshot:

```json
{ "action": "screenshot" }
```

Click a coordinate from the latest screenshot:

```json
{ "action": "click", "x": 120, "y": 340 }
```

Run a focused sequence in one batch — screenshot first, then act, so coordinates are validated:

```json
{
  "action": "batch",
  "actions": [
    { "action": "screenshot" },
    { "action": "click", "x": 120, "y": 340 },
    { "action": "type", "text": "hello" },
    { "action": "keypress", "keys": ["Return"] }
  ]
}
```

## Error recovery

- `COMPUTER_COORD_INVALID`: the coordinate was outside the latest screenshot bounds. Capture a fresh screenshot and re-derive coordinates.
- `COMPUTER_DISPLAY_STALE`: the display changed since the screenshot. Capture a fresh screenshot before acting.
- `COMPUTER_SUPERVISOR_NOT_LIVE` / `COMPUTER_SUSPENDED` / `COMPUTER_CANCELLED`: stop acting and wait for the user.
- `COMPUTER_PERMISSION_REQUIRED`: the host needs screen-recording or accessibility permission. Ask the user to grant it.
- `COMPUTER_DISABLED`: the tool is disabled or the host is unsupported. Do not retry.

After any error, resume with a fresh screenshot rather than guessing.
