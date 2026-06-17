# computer

Use `computer` only when the session has explicitly enabled macOS computer-use. It controls the real desktop and is off by default.

## Safety contract

- Disabled means disabled: when `computer.enabled` and `computer.alwaysOn` are both false, every action including `screenshot` fails with `COMPUTER_DISABLED` and captures nothing.
- The tool is macOS-only in v1.
- Native execution remains supervisor-gated. If the stop/suspend supervisor is unavailable, stale, suspended, permissioned off, display-stale, or cancelled, the action fails closed with a `COMPUTER_*` code.
- Respect the user's stop/suspend request immediately. Do not loop desktop actions after a stop/suspend/error.

## Coordinate contract

Coordinates are screenshot pixels, not CSS pixels and not normalized fractions. Use the latest successful `screenshot` dimensions and origin/scale metadata as the coordinate frame. Do not guess coordinates outside the screenshot bounds.

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

Shared optional fields: `timeout` seconds and `include_screenshot` for a bounded post-action screenshot when supported.

Do not use camelCase fields such as `doubleClick`, `toX`, `scrollX`, or `includeScreenshot` in the model action object.
