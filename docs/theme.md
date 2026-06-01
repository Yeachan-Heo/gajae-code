# Theming Reference

This document describes how theming works in the coding-agent today: schema, loading, runtime behavior, and failure modes.

## What the theme system controls

The theme system drives:

- foreground/background color tokens used across the TUI
- markdown styling adapters (`getMarkdownTheme()`)
- selector/editor/settings list adapters (`getSelectListTheme()`, `getEditorTheme()`, `getSettingsListTheme()`)
- symbol preset + symbol overrides (`unicode`, `nerd`, `ascii`)
- syntax highlighting colors used by native highlighter (`@gajae-code/natives`)
- status line segment colors

Primary implementation: `src/modes/theme/theme.ts`.

## Theme JSON shape

Theme files are JSON objects validated against the runtime schema in `theme.ts` (`ThemeJsonSchema`) and mirrored by `src/modes/theme/theme-schema.json`.

Top-level fields:

- `name` (required)
- `colors` (required; all color tokens required)
- `vars` (optional; reusable color variables)
- `export` (optional; HTML export colors)
- `symbols` (optional)
  - `preset` (optional: `unicode | nerd | ascii`)
  - `overrides` (optional: key/value overrides for `SymbolKey`)

Color values accept:

- hex string (`"#RRGGBB"`)
- 256-color index (`0..255`)
- variable reference string (resolved through `vars`)
- empty string (`""`) meaning terminal default (`\x1b[39m` fg, `\x1b[49m` bg)

## Required color tokens (current)

All tokens below are required in `colors`.

### Core text and borders (11)

`accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`

### Background blocks (7)

`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `statusLineBg`

### Message/tool text (5)

`userMessageText`, `customMessageText`, `customMessageLabel`, `toolTitle`, `toolOutput`

### Markdown (10)

`mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`

### Tool diff + syntax highlighting (12)

`toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`,
`syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`

### Mode/thinking borders (8)

`thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `bashMode`, `pythonMode`

### Status line segment colors (14)

`statusLineSep`, `statusLineModel`, `statusLinePath`, `statusLineGitClean`, `statusLineGitDirty`, `statusLineContext`, `statusLineSpend`, `statusLineStaged`, `statusLineDirty`, `statusLineUntracked`, `statusLineOutput`, `statusLineCost`, `statusLineSubagents`

## Optional tokens

### `export` section (optional)

Used for HTML export theming helpers:

- `export.pageBg`
- `export.cardBg`
- `export.infoBg`

If omitted, export code derives defaults from resolved theme colors.

### `symbols` section (optional)

- `symbols.preset` sets a theme-level default symbol set.
- `symbols.overrides` can override individual `SymbolKey` values.

Runtime precedence:

1. settings `symbolPreset` override (if set)
2. theme JSON `symbols.preset`
3. fallback `"unicode"`

Invalid override keys are ignored and logged (`logger.debug`).

## Built-in vs custom theme sources

Theme lookup order (`loadThemeJson`):

1. built-in embedded themes (`dark.json`, `light.json`, and all `defaults/*.json` compiled into `defaultThemes`, including the red-claw crustacean theme)
2. custom theme file: `<customThemesDir>/<name>.json`

Custom themes directory comes from `getCustomThemesDir()`:

- default: `~/.gjc/agent/themes`
- overridden by `GJC_CODING_AGENT_DIR` (`$GJC_CODING_AGENT_DIR/themes`)

`getAvailableThemes()` returns merged built-in + custom names, sorted, with built-ins taking precedence on name collision.

## Loading, validation, and resolution

For custom theme files:

1. read JSON
2. parse JSON
3. validate against `ThemeJsonSchema`
4. resolve `vars` references recursively
5. convert resolved values to ANSI by terminal capability mode

Validation behavior:

- missing required color tokens: explicit grouped error message
- bad token types/values: validation errors with JSON path
- unknown theme file: `Theme not found: <name>`

Var reference behavior:

- supports nested references
- throws on missing variable reference
- throws on circular references

## Terminal color mode behavior

Color mode detection (`detectColorMode`):

- `COLORTERM=truecolor|24bit` => truecolor
- `WT_SESSION` => truecolor
- `TERM` in `dumb`, `linux`, or empty => 256color
- otherwise => truecolor

Conversion behavior:

- hex -> `Bun.color(..., "ansi-16m" | "ansi-256")`
- numeric -> `38;5` / `48;5` ANSI
- `""` -> default fg/bg reset

## Runtime switching behavior

### Initial theme (`initTheme`)

`main.ts` initializes theme with settings:

- `symbolPreset`
- `colorBlindMode`
- `theme.dark`
- `theme.light`

Auto theme slot selection uses terminal appearance in this order:

1. terminal-reported OSC 11 background luminance, unless the macOS/Zellij fallback path is active
2. `COLORFGBG` background index (`< 8` => dark, `>= 8` => light)
3. macOS appearance fallback only for the known-broken macOS/Zellij OSC 11 path
4. dark slot fallback

Built-in theme note: `red-claw` is the default dark GJC theme, with red/orange brand tokens, separate semantic error/warning/diff-removal tokens, and crab-oriented symbol overrides.

Current defaults from settings schema:

- `theme.dark = "red-claw"`
- `theme.light = "light"`
- `symbolPreset = "unicode"`
- `colorBlindMode = false`

### Explicit switching (`setTheme`)

- loads selected theme
- updates global `theme` singleton
- optionally starts watcher
- triggers `onThemeChange` callback

On failure:

- falls back to built-in `dark`
- returns `{ success: false, error }`

### Preview switching (`previewTheme`)

- applies temporary preview theme to global `theme`
- does **not** change persisted settings by itself
- returns success/error without fallback replacement

The settings theme picker is confirm-only; arrow-key browsing does not call `previewTheme`, so the rendered theme and displayed/persisted theme name stay aligned until Enter confirms a new selection.

## Watchers and live reload

When watcher is enabled (`setTheme(..., true)` / interactive init):

- watches `<customThemesDir>/<currentTheme>.json` only when that file exists
- built-ins are effectively not watched; built-in theme lookup also takes precedence over same-name custom files
- matching file changes schedule a debounced reload; reload errors or temporary file absence keep the last successfully loaded theme
- the watcher does not perform a delete/rename fallback; it waits for a future successful reload or explicit theme switch

Auto mode also reevaluates dark/light slot mapping from terminal appearance changes, `SIGWINCH`, and the macOS fallback observer when active.

## Color-blind mode behavior

`colorBlindMode` changes only one token at runtime:

- `toolDiffAdded` is HSV-adjusted (green shifted toward blue)
- adjustment is applied only when resolved value is a hex string

Other tokens are unchanged.

## Where theme settings are persisted

Theme-related settings are persisted by `Settings` to global config YAML:

- path: `<agentDir>/config.yml`
- default agent dir: `~/.gjc/agent`
- effective default file: `~/.gjc/agent/config.yml`

Persisted keys:

- `theme.dark`
- `theme.light`
- `symbolPreset`
- `colorBlindMode`

Legacy migration exists: old flat `theme: "name"` is migrated to nested `theme.dark` or `theme.light` based on luminance detection.

## Creating a custom theme (practical)

1. Create file in custom themes dir, e.g. `~/.gjc/agent/themes/my-theme.json`.
2. Include `name`, optional `vars`, and **all required** `colors` tokens.
3. Optionally include `symbols` and `export`.
4. Select the theme in Settings (`Display -> Dark theme` or `Display -> Light theme`) depending on which auto slot you want. For the bundled crustacean look, choose `red-claw`.

Minimal skeleton:

```json
{
  "name": "my-theme",
  "vars": {
    "accent": "#7aa2f7",
    "muted": 244
  },
  "colors": {
    "accent": "accent",
    "border": "#4c566a",
    "borderAccent": "accent",
    "borderMuted": "muted",
    "success": "#9ece6a",
    "error": "#f7768e",
    "warning": "#e0af68",
    "muted": "muted",
    "dim": 240,
    "text": "",
    "thinkingText": "muted",

    "selectedBg": "#2a2f45",
    "userMessageBg": "#1f2335",
    "userMessageText": "",
    "customMessageBg": "#24283b",
    "customMessageText": "",
    "customMessageLabel": "accent",
    "toolPendingBg": "#1f2335",
    "toolSuccessBg": "#1f2d2a",
    "toolErrorBg": "#2d1f2a",
    "toolTitle": "",
    "toolOutput": "muted",

    "mdHeading": "accent",
    "mdLink": "accent",
    "mdLinkUrl": "muted",
    "mdCode": "#c0caf5",
    "mdCodeBlock": "#c0caf5",
    "mdCodeBlockBorder": "muted",
    "mdQuote": "muted",
    "mdQuoteBorder": "muted",
    "mdHr": "muted",
    "mdListBullet": "accent",

    "toolDiffAdded": "#9ece6a",
    "toolDiffRemoved": "#f7768e",
    "toolDiffContext": "muted",

    "syntaxComment": "#565f89",
    "syntaxKeyword": "#bb9af7",
    "syntaxFunction": "#7aa2f7",
    "syntaxVariable": "#c0caf5",
    "syntaxString": "#9ece6a",
    "syntaxNumber": "#ff9e64",
    "syntaxType": "#2ac3de",
    "syntaxOperator": "#89ddff",
    "syntaxPunctuation": "#9aa5ce",

    "thinkingOff": 240,
    "thinkingMinimal": 244,
    "thinkingLow": "#7aa2f7",
    "thinkingMedium": "#2ac3de",
    "thinkingHigh": "#bb9af7",
    "thinkingXhigh": "#f7768e",

    "bashMode": "#2ac3de",
    "pythonMode": "#bb9af7",

    "statusLineBg": "#16161e",
    "statusLineSep": 240,
    "statusLineModel": "#bb9af7",
    "statusLinePath": "#7aa2f7",
    "statusLineGitClean": "#9ece6a",
    "statusLineGitDirty": "#e0af68",
    "statusLineContext": "#2ac3de",
    "statusLineSpend": "#7dcfff",
    "statusLineStaged": "#9ece6a",
    "statusLineDirty": "#e0af68",
    "statusLineUntracked": "#f7768e",
    "statusLineOutput": "#c0caf5",
    "statusLineCost": "#ff9e64",
    "statusLineSubagents": "#bb9af7"
  }
}
```

## Testing custom themes

Use this workflow:

1. Start interactive mode (watcher enabled from startup).
2. Open settings and confirm the custom theme in the dark/light theme picker; arrow-key browsing is intentionally non-mutating.
3. For custom theme files, edit the JSON while running and confirm auto-reload on save.
4. Exercise critical surfaces:
   - markdown rendering
   - tool blocks (pending/success/error)
   - diff rendering (added/removed/context)
   - status line readability
   - thinking level border changes
   - bash/python mode border colors
5. Validate both symbol presets if your theme depends on glyph width/appearance.

## Real constraints and caveats

- All `colors` tokens are required for custom themes.
- `export` and `symbols` are optional.
- `$schema` in theme JSON is informational; runtime validation is enforced by a Zod schema in code.
- `setTheme` failure falls back to `dark`; `previewTheme` failure does not replace current theme.
- File watcher reload errors or temporary missing files keep the current loaded theme until a successful reload or explicit theme switch.
