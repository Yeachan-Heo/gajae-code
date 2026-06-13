# Changelog

## [Unreleased]

### Added

- Added process-isolated deterministic render-golden capture fixtures and coverage for editor overlays, rich-text resize, multiplexer viewport repaint, sixel preservation, Termux height diffs, and transcript shrink/clear regressions.
- Added layout/rendering benchmarks for editor layout, markdown rendering, and frame rendering.

### Changed

- Tightened markdown/editor rendering and terminal repaint behavior for the compact tool-block spacing and render-golden stability work.

### Fixed

- Fixed Korean/Hangul input composition breaking in Android Termius, where typing `안녕하세요` produced duplicated jamo/syllable residue (`ㅇ아안ㄴ녀녕…`). GJC's startup keyboard reprogramming (Kitty keyboard protocol query `CSI ? u` / push `CSI > 7 u`, and the xterm modifyOtherKeys fallback `CSI > 4 ; 2 m`) disrupts the Android IME's syllable composition. Added a `GJC_TUI_KEYBOARD_PROTOCOL` opt-out (enabled by default): set `GJC_TUI_KEYBOARD_PROTOCOL=0` to leave the keyboard in its default mode so IME composition works, matching terminals/TUIs that never enable these enhanced input modes.

## [0.4.5] - 2026-06-12

- Version aligned with the 0.4.5 monorepo release; no functional changes in this package.

## [0.4.4] - 2026-06-10

- Version aligned with the 0.4.4 monorepo release; no functional changes in this package.

## [0.4.3] - 2026-06-10

### Fixed

- Fixed Korean (and other multi-byte UTF-8) paste mojibake in terminal input: `StdinBuffer` is now the single raw-stdin decoding boundary using a persistent `StringDecoder`, so multi-byte characters split across stdin read boundaries are reassembled instead of producing U+FFFD. `ProcessTerminal` no longer relies on `process.stdin.setEncoding("utf8")` and forwards raw Buffers; the legacy single-high-byte meta conversion is preserved. (#454)

## [0.4.0] - 2026-06-06

### Changed

- Ranked slash command-name suggestions by stronger prefix/token matches before fuzzy fallback ordering, while keeping priority as an intra-tier tie-breaker.

## [0.3.1] - 2026-06-05

### Changed

- Added replay-gate helper timing for text-layout utilities so Stage 5 native offload decisions are benchmark-gated by measured hot paths rather than speculative rewrites.

## [0.2.2] - 2026-05-31

### Changed

- Refreshed TUI package metadata for the GJC 0.2.2 release.

## [0.2.1] - 2026-05-30

### Fixed

- Made TUI terminal writes tolerate `EIO`/closed PTY failures by marking output unavailable, swallowing render/cursor cleanup write errors, and suppressing later render writes after detach.

## [0.2.0] - 2026-05-28

### Changed

- Refreshed TUI package metadata for the GJC 0.2.0 release.

## [0.1.3] - 2026-05-28

### Changed

- Released the current dev branch fixes with refreshed 0.1.3 package metadata.

## [0.1.2] - 2026-05-28

### Changed

- Updated package metadata for the Gajae Code npm publication.

## [15.3.2] - 2026-05-25

### Fixed

- Fixed `matchesKey(data, "ctrl+m")` (and the other named-key collisions: `ctrl+h`/`ctrl+i`/`ctrl+j`/`ctrl+[`) returning true for the bare `\r`/`\x08`/`\t`/`\n`/`\x1b` byte terminals send for Enter/Backspace/Tab/Escape in legacy mode. Binding a command to `Ctrl+M` no longer fires when the user presses Enter — the named key wins, and `ctrl+<colliding-letter>` matches only when the terminal disambiguates via the Kitty keyboard protocol or `modifyOtherKeys`. ([#1354](https://github.com/can1357/gajae-code/issues/1354))

## [15.2.3] - 2026-05-22
### Added

- Added `SettingsList#setItems` to replace the entire settings list with a new items array while automatically clamping selection to a valid index

### Changed

- Updated `Loader` to drive renders at ~60fps (16ms tick) while keeping spinner-frame advancement at 80ms so shimmer/animated message colorizers update smoothly without altering spinner cadence

## [15.1.9] - 2026-05-21

### Fixed

- Fixed terminal probe responses (DA1, kitty keyboard, Mode 2031) leaking into the prompt as keystrokes when the response is split across stdin reads. `ProcessTerminal` now reassembles `\x1b[?<digits>...` private CSI fragments and dispatches the complete response through the existing pattern handlers. ([#1238](https://github.com/can1357/gajae-code/issues/1238))

## [15.1.4] - 2026-05-19

### Fixed

- Fixed `renderInlineMarkdown` crashing with `TypeError: undefined is not an object (evaluating 'e.replace')` when called with a non-string value during streaming — partial JSON parsing leaves option label fields temporarily unpopulated, causing the ask tool renderer to fail. ([#1176](https://github.com/can1357/gajae-code/issues/1176))

## [15.0.2] - 2026-05-15

### Added

- Restored the `Key` runtime helper on `@gajae-code/tui` to mirror upstream `@mariozechner/pi-tui`'s surface. `Key.enter`, `Key.escape`, `Key.tab`, … return the canonical key-name strings; modifier methods (`Key.ctrl(k)`, `Key.shift(k)`, `Key.ctrlShift(k)`, etc.) build precisely-typed `KeyId` literals like `"ctrl+c"`. Pure runtime convenience for typed key-id construction — plugins built against the upstream package surface that import `Key` (e.g. `@plannotator/pi-extension`, `@juicesharp/rpiv-ask-user-question`) load again now that the specifier shim remaps them onto this package.

## [15.0.1] - 2026-05-14
### Breaking Changes

- Increased the minimum required Bun version for the TUI package from >=1.3.7 to >=1.3.14
- Fixed `TerminalInfo.sendNotification` not delivering desktop notifications on macOS. macOS requires per-app notification permission, which terminal emulators (kitty, ghostty, alacritty, …) almost never have, so OSC 9/99 sequences were silently dropped at the OS layer. `sendNotification` now shells out to `alerter` or `terminal-notifier` when either is on `$PATH` (both register their own LSApplication and ship a "Terminal" / `>_` icon). When neither is installed the dispatch is a deliberate no-op + a single `logger.warn` line on the first miss (subsequent dispatches stay silent) so the user can spot the missing binary in `~/.gjc/logs/gjc.YYYY-MM-DD.log` and `brew install alerter`. Linux/Windows still go through the OSC/Bell path.
- Fixed `TerminalInfo.formatNotification` losing OSC 9/99 desktop notifications when running inside tmux. The OSC sequence is now wrapped in tmux's DCS passthrough envelope (`\ePtmux;…\e\\` with embedded ESC bytes doubled) when `TMUX` is set, so notifications reach the parent terminal. `set -g allow-passthrough on` is still required on the tmux side for the wrapped sequence to be forwarded. Bell-only terminals are unchanged.
- Fixed alerter desktop notifications staying on screen indefinitely. `scripts/mac-alerter.sh` previously passed `--timeout 30` (which makes alerter call `removeDeliveredNotification` after 30 s, also purging the Notification Center entry) and forced Alert-style via `--actions "Open"` (persistent until user click). It now ships Banner-style argv (no `--actions`, no `--timeout`): macOS auto-dismisses the toast after ~10 s and archives the entry to Notification Center for later review. Click-to-focus is preserved through `@CONTENTCLICKED` body clicks. NC archival also requires "Show in Notification Center" enabled for Terminal under macOS System Settings → Notifications.
- Fixed `composeNotificationSubtitle` showing a stale tmux `pane_title` (typically `π: kitty & tmux` or the cwd prefix written before auto-naming runs) instead of the live GJC session name. The GJC-supplied `fallback` is now consulted first for the pane component; the cached tmux pane title is only used when no session name is available. Window name handling is unchanged.
- Fixed `sendDesktopNotification` always routing through `alerter` / `terminal-notifier` on darwin, even for terminals (ghostty / iTerm2 / wezterm) that surface OSC 9 / OSC 99 as native notifications through their own bundle. The dispatch now prefers the OSC path on darwin when the terminal advertises native macOS notification capability; the fallback only kicks in for kitty / alacritty / vscode / unknown shells whose host app isn't a notification-capable bundle. This unblocks the user-controlled per-app notification settings flow for ghostty / iTerm2 / wezterm — toast style, NC archival, and click-to-focus all attach to the terminal app's own System Settings entry rather than to `com.apple.Terminal` (which `alerter` would post under).
- Fixed Korean IME composition leaving a growing horizontal gap between typed jamo and the cursor inside the GJC prompt under tmux + ghostty (and other macOS terminals). `Bun.stringWidth` and the underlying UAX#11 East Asian Width tables classify Hangul Compatibility Jamo (U+3131..U+318E — ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅅ ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ + filler) as Wide (2 cells), but every macOS terminal we ship to (Ghostty / Terminal.app / iTerm2) actually renders them as a single cell in monospace fonts. `#extractCursorPosition` was computing `col = visibleWidth(beforeMarker)` and feeding the doubled value to `\x1b[(col+1)G`, placing the hardware cursor (and therefore the IME candidate window) `N_jamo` cells past the visible glyph — exactly the gap the user saw growing as they typed. `visibleWidthRaw` now subtracts 1 cell for each Compatibility Jamo character, returning the column count macOS terminals actually use. Hangul Syllables (U+AC00..U+D7A3, e.g. `안`) stay at 2 cells in both Bun and the terminal — unaffected. Other CJK widths (Chinese / Japanese / Halfwidth Hangul) are unchanged. NOTE: the Rust `pi-natives` width tables (used by `sliceWithWidth` / `truncateToWidth` / `wrapTextWithAnsi`) also count Compatibility Jamo as 2 cells; truncation and word-wrap on jamo-heavy lines will still be slightly aggressive. The defect is invisible in normal use because the AI composes Korean as syllables, not jamo, and users type syllables once IME composition completes. A follow-up will reconcile the Rust side.
- Fixed a brief black-flash flicker in the TUI when streaming long markdown responses inside tmux (especially noticeable in ghostty with multiple panes open). Root cause: when a markdown fence line above the viewport changed between two streaming tokens (e.g. `` ``` `` → `` ```python ``), `#doRender()` would take the `firstChanged < prevViewportTop` branch and emit `\x1b[2J\x1b[H` (full screen clear + cursor home) wrapped in BSU. The BSU envelope can split across PTY reads, leaving tmux briefly displaying a blank pane before the rest of the buffer arrives — multiplied across panes during repaint. The viewport-above branch now calls a new `viewportRefresh()` helper that does cursor-home + per-line `\x1b[2K` + line content (no `\x1b[2J`), so the visible viewport content is repainted without ever clearing the screen. Scrollback above the viewport may briefly show stale rendering, but only of the SAME lines that just changed — invisible during streaming when the user isn't scrolled up. Other full-redraw paths (resize, first render, etc.) keep the hard `fullRender(true)` behavior unchanged.

### Tests

- Added `test/no-2k-anywhere.test.ts` — lint guard that scans `packages/tui/src/` for `\x1b[2K` string literals outside comments. The earlier streaming-flicker fix re-introduced the BSU-split flash bug by moving `\x1b[2K`-before-content from `fullRender` to `viewportRefresh` (same anti-pattern in a new location). This test catches that class of regression at CI time so future changes can't silently revive it.
- Added `test/render-emit-snapshot.test.ts` — four scenario-based byte-snapshot guards (single-line mutation, streaming append, above-viewport mutation triggering `viewportRefresh`, trailing-line clear on shrink). Asserts structural invariants on the EMITTED BYTES from `terminal.write(…)`: no `\x1b[2K`, no `\x1b[2J`, the new content appears, the BSU close `\x1b[?2026l` is present. Catches render-path changes that achieve the right final viewport state via a transient blank frame (which is exactly how the typing-flicker bug slipped past `render-regressions.test.ts`).
- Added `test/ime-jamo-cursor.test.ts` — six cases asserting the Input component's hardware cursor marker column does not grow at 2× per typed Korean compatibility jamo. Before commit `79e3170c6` typing 14 jamo produced a 14-cell gap between the visible text and the IME candidate window; the test caps the cursor column at `PRGJCT_WIDTH + N_jamo` and asserts the per-keystroke delta is at most 1. NOTE: the Rust `pi-natives` `sliceWithWidth` still treats jamo as 2 cells (binary package, follow-up); the test guard accepts a small residual offset but flags the doubling regression.

## [14.9.8] - 2026-05-12

### Added

- Added `Terminal.setProgress(active)` to emit OSC 9;4 progress sequences with a ~1s keepalive interval so Ghostty does not clear the indicator during long-running work (ports pi-mono `a900d251` + `76bc605a`)
- Added optional `argumentHint?: string` to `SlashCommand`; rendered before the description in the autocomplete dropdown (ports pi-mono `aa25726e`)
- Added `VirtualTerminal.waitForRender()` test helper for the throttled render pipeline (ports pi-mono `41377ee8`)

### Changed

- `ProcessTerminal` `columns`/`rows` getters consult `Bun.env.COLUMNS` / `Bun.env.LINES` before falling back to 80×24, so piped/non-TTY runs honour environment-provided dimensions (ports pi-mono `32f7fc6a`)
- `requestRender()` non-force calls are coalesced to a ~16ms frame budget; `requestRender(true)` still flushes immediately via `process.nextTick` (ports pi-mono `6f5f37f8`)
- `KNOWN_TERMINALS.base` / `KNOWN_TERMINALS.trueColor` default `hyperlinks: false`; tmux and screen (`TMUX` env or `TERM` starts with `tmux`/`screen`) force `hyperlinks: false` even when the outer terminal would advertise OSC 8 (adapts pi-mono `30a8a41f`)
- `SlashCommand.getArgumentCompletions()` may return a `Promise`; results are now awaited and non-array returns are ignored (ports pi-mono `a1e10789`)
- Fuzzy `@` autocomplete now follows symlinked directories via `ScanOptions.follow_links` plumbed through the native walker (ports pi-mono `780d5367`)
- Plain `@<query>` (no slash) fuzzy matches by basename only, so `@plan` no longer surfaces every file whose ancestor directories contain `plan` (ports pi-mono `968430f6`)

### Fixed

- Fixed editor corruption on Thai Sara Am (U+0E33) and Lao AM (U+0EB3) vowels by normalizing to their compatibility decompositions on the terminal-write path while keeping editor content logically unchanged (ports pi-mono `bc668826` + `338ce3a3` + `20ca45d5`)
- Fixed cell-size detection (`CSI 6;h;w t` response) to consume only exact replies, so a bare `Escape` keystroke is no longer swallowed while waiting for terminal image metadata (ports pi-mono `49c0d860`)
- Fixed Kitty CSI-u printable input duplicating on layouts (e.g. Italian) where the terminal also emits the raw character: the immediately-following matching codepoint is now suppressed (ports pi-mono `bdb416cb`)
- Fixed bracketed-paste CSI-u `Ctrl+<letter>` re-encoding (tmux popup with `extended-keys-format=csi-u`) leaking literal `[<code>;5u` into the editor; control bytes are decoded back to their literal byte before per-char filtering (ports pi-mono `d06db09a`)
- Fixed xterm `modifyOtherKeys` shifted printable input so uppercase letters inserted via `CSI 27;mod;codepoint~` reach the editor correctly (ports pi-mono `6b55d685`)
- Fixed `super`-modified Kitty shortcuts (`super+k`, `ctrl+super+enter`, …) to parse and match via the new `KITTY_MOD_SUPER` mask (ports pi-mono `ddb8454c` + `5ed46003`)
- Fixed `ctrl+alt+<letter>` in tmux falling through to CSI-u / `modifyOtherKeys` when the legacy `ESC<ctrl-char>` form does not match (ports pi-mono `6cf5098f`)
- Fixed Markdown strikethrough requiring strict `~~text~~` delimiters with non-whitespace boundaries; single tildes no longer render strikethrough (ports pi-mono `db5274b4`)

- Allowed `SlashCommand.getArgumentCompletions` to return asynchronous results by accepting Promise-based completions
- Added `argumentHint` support to slash command definitions and displayed it in command suggestion descriptions
- Added support for xterm `modifyOtherKeys` printable key sequences by decoding `CSI 27;mod;key~` into text input

### Changed

- Changed slash-command autocomplete list rendering to combine command hint and description in a single displayed suggestion text
- Changed render scheduling to throttle `requestRender` calls to roughly 60fps by batching updates
- Changed terminal input handling to process complete cell-size responses without buffering partial input
- Changed `KeyId` to accept super-modifier combinations and improve typed key-id validation

### Fixed

- Normalized line output during rendering to correct Thai/Lao AM glyph composition for displayed text
- Fixed duplicated Kitty key input emissions by dropping the matching unmodified follow-up sequence after a Kitty CSI-u printable-key event

## [14.9.5] - 2026-05-12
### Fixed

- Fixed rapidly blinking cursor artifact during task execution by consolidating cursor control sequences into the synchronized output buffer ([#992](https://github.com/can1357/gajae-code/issues/992))

## [14.5.7] - 2026-04-29

### Fixed

- Fixed editor Ctrl+Enter handling to recognize NumLock and keypad Enter variants.

## [14.3.0] - 2026-04-25

### Fixed

- Fixed shared Markdown Mermaid fenced-block rendering to resolve diagrams from fenced source text instead of external prerender state

## [14.1.1] - 2026-04-14

### Breaking Changes

- Removed the `searchDb` constructor argument from `CombinedAutocompleteProvider`, requiring callers to use the built-in search behavior

### Changed

- Changed truncation debug logging to run only when `debugRedraw` is enabled

### Fixed

- Fixed viewport jumping during streaming and session swap by tracking actual content height instead of high-water mark

## [14.0.5] - 2026-04-11

### Changed

- Updated hash computation to use `Bun.hash()` instead of `Bun.hash.xxHash64()`, which may return `number` in addition to `bigint`
- Simplified cache key computation in Box component by removing intermediate hash updates and consolidating hash operations
- Wrapped native text utility functions (`sliceWithWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `extractSegments`) to automatically pass the current default tab width, simplifying the API for consumers
- Added `getIndentationNoescape` wrapper that uses `process.cwd()` as the project root for relative file paths
- Re-export `getDefaultTabWidth`, `getIndentation`, and `setDefaultTabWidth` from `@gajae-code/utils`; native text helpers still receive tab width via wrappers that read the JS default

## [13.16.1] - 2026-03-27

### Added

- Support for optional SearchDb parameter in CombinedAutocompleteProvider constructor for improved fuzzy search performance
- Fuzzy matching filter for autocomplete suggestions to improve relevance of results

### Changed

- Fuzzy discovery now applies fuzzy matching filter to results for improved relevance of autocomplete suggestions
- Autocomplete fuzzy discovery now accepts optional SearchDb instance for faster searches

## [13.16.0] - 2026-03-27
### Changed

- Updated tab replacement in editor text sanitization to respect configured tab width setting

## [13.15.0] - 2026-03-23

### Added

- Added `renderInlineMarkdown()` function to render inline markdown (bold, italic, code, links, strikethrough) to styled strings

### Fixed

- Fixed editor consuming user-rebound copy keys, preventing custom keybindings from working in the editor

## [13.14.1] - 2026-03-21
### Added

- Added Ctrl+_ as an additional default shortcut for undo

### Fixed

- Ensured undo functionality respects user-configured keybindings

## [13.12.0] - 2026-03-14

### Added

- Added `moveToMessageStart()` and `moveToMessageEnd()` methods to move cursor to the beginning and end of the entire message

### Fixed

- Fixed autocomplete to preserve `./` prefix when completing relative file and directory paths
- Fixed paste marker expansion to handle special regex replacement tokens ($1, $2, $&, $$, $`, $') literally in pasted content

## [13.11.0] - 2026-03-12
### Fixed

- Fixed OSC 11 background color detection to correctly handle partial escape sequences that arrive mid-buffer, preventing user input from being swallowed
- Fixed race condition where overlapping OSC 11 queries would be incorrectly cancelled by DA1 sentinels from previous queries

## [13.7.5] - 2026-03-04
### Changed

- Extracted word navigation logic into reusable `moveWordLeft` and `moveWordRight` utility functions for consistent cursor movement across components

## [13.6.2] - 2026-03-03
### Fixed

- Fixed cursor positioning when content shrinks to empty without clearOnShrink enabled

## [13.5.4] - 2026-03-01

### Fixed

- Fixed viewport repaint scrollback accounting during resize oscillation to avoid double-scrolling on height shrink and added exact-row scrollback assertions in overlay regression coverage ([#228](https://github.com/can1357/gajae-code/issues/228), [#234](https://github.com/can1357/gajae-code/issues/234))
## [13.5.3] - 2026-03-01

### Fixed

- Fixed append rendering logic to correctly handle offscreen header changes during content overflow growth, preserving scroll history integrity
- Fixed visible tail line updates when appending new content during viewport overflow conditions
- Fixed cursor positioning instability when appending content under external cursor relocation by using absolute screen addressing instead of relative cursor movement

## [13.5.2] - 2026-03-01
### Breaking Changes

- Removed `getMermaidImage` callback from MarkdownTheme; replaced with `getMermaidAscii` that accepts ASCII string instead of image data
- Removed mermaid module exports (`renderMermaidToPng`, `extractMermaidBlocks`, `prerenderMermaidBlocks`, `MermaidImage` interface)

### Changed

- Mermaid diagrams now render as ASCII text instead of terminal graphics protocol images

## [13.5.1] - 2026-03-01
### Fixed

- Fixed viewport shift handling to prevent stale content when mixed updates remap screen rows

## [13.5.0] - 2026-03-01

### Breaking Changes

- Removed `PI_TUI_RESIZE_CLEAR_STRATEGY`; resize behavior is no longer configurable between viewport/scrollback modes. The renderer now uses fixed semantics: width changes perform a hard reset (`3J` + full content rewrite), while height changes and diff fallbacks use viewport-scoped repainting.

### Added

- Added a new terminal regression suite in `packages/tui/test/render-regressions.test.ts` covering no-op render stability, targeted middle-line diffs, shrink cleanup, width-resize truncation without ghost rows, shrink/grow viewport tail anchoring, scrollback deduplication across forced redraws, overlay restore behavior, and rapid mutation convergence.
- Expanded `packages/tui/test/overlay-scroll.test.ts` with stress coverage for overflow shrink/regrow cycles, resize oscillation, overlay toggle churn, no-op render loops, and hardware-cursor-only updates while bounding scrollback growth and blank-run artifacts.

### Changed

- Refactored render orchestration to explicit `hardReset` and `viewportRepaint` paths, with targeted fallbacks for offscreen diff ranges and unsafe row deltas.
- Switched startup to `requestRender(true)` so the first frame always initializes renderer state with a forced full path.
- Replaced legacy viewport bookkeeping (`previousViewportTop`) with `viewportTopRow` tracking and consistent screen-relative cursor calculations.
- Updated stop-sequence cursor placement to target the visible working area and clamp to terminal bounds before final newline emission.
- Documented the intentional performance policy of not forcing full repaint on every viewport-top shift, relying on narrower safety guards instead.

### Fixed

- Fixed stale/duplicated terminal cursor dedup state by synchronizing `#lastCursorSequence` in all render write paths (hard reset, viewport repaint, deleted-lines clear path, append fast path, and differential path).
- Fixed scroll overshoot on `stop()` when content fills the viewport by clamping target row movement to valid screen rows.
## [13.4.0] - 2026-03-01

### Added

- Added `PI_TUI_RESIZE_CLEAR_STRATEGY` environment variable to control terminal behavior on resize: `viewport` (default) clears/redraws the viewport while preserving scrollback, or `scrollback` clears all history

### Changed

- Changed resize redraw behavior to use configurable clear semantics (`viewport` vs `scrollback`) while keeping full content rendering for scrollback navigation

### Fixed

- Fixed loader component rendering lines wider than terminal width, preventing text overflow and display artifacts

## [13.3.11] - 2026-02-28

### Fixed

- Restored terminal image protocol override and fallback detection for image rendering, including `PI_FORCE_IMAGE_PROTOCOL` support and Kitty fallback for screen/tmux/ghostty-style TERM environments.

## [13.3.8] - 2026-02-28
### Breaking Changes

- Changed mermaid hash type from string to bigint in `getMermaidImage` callback and `extractMermaidBlocks` return type
- Removed `mime-types` and `@types/mime-types` from dependencies
- Removed `@xterm/xterm` from dependencies

### Changed

- Updated mermaid hash computation to use `Bun.hash.xxHash64()` instead of `Bun.hash().toString(16)`

## [12.19.0] - 2026-02-22

### Added

- Added `getTopBorderAvailableWidth()` method to calculate available width for top border content accounting for border characters and padding

### Fixed

- Fixed stale viewport rows appearing when terminal height increases by triggering full re-render on height changes

## [12.18.0] - 2026-02-21
### Fixed

- Fixed viewport synchronization issue by clearing scrollback when terminal state becomes desynced during full re-renders

## [12.12.2] - 2026-02-19

### Fixed

- Fixed non-forced full re-renders clearing terminal scrollback history during streaming updates by limiting scrollback clears to explicit forced re-renders.

## [12.12.0] - 2026-02-19

### Added

- Added PageUp/PageDown navigation for editor content and autocomplete selection to jump across long wrapped inputs faster.

### Fixed

- Fixed history-entry navigation anchoring (Up opens at top, Down opens at bottom) and preserved editor scroll context when max-height changes to keep cursor movement visible in long prompts ([#99](https://github.com/can1357/gajae-code/issues/99)).

## [12.11.3] - 2026-02-19

### Fixed

- Fixed differential deleted-line rendering when content shrinks to empty so stale first-row content is cleared reliably.
- Fixed incremental stale-row clearing to use erase-below semantics in synchronized output, reducing leftover-line artifacts after shrink operations.

## [12.9.0] - 2026-02-17
### Added

- Exported `getTerminalId()` function to get a stable identifier for the current terminal, with support for TTY device paths and terminal multiplexers
- Exported `getTtyPath()` function to resolve the TTY device path for stdin via POSIX `ttyname(3)`

## [12.5.0] - 2026-02-15
### Added

- Added `cursorOverride` and `cursorOverrideWidth` properties to customize the end-of-text cursor glyph with ANSI-styled strings
- Added `getUseTerminalCursor()` method to query the terminal cursor mode setting

## [11.10.0] - 2026-02-10
### Added

- Added `hint` property to autocomplete items to display dim ghost text after cursor when item is selected
- Added `getInlineHint()` method to `SlashCommand` interface for providing inline hint text based on argument state
- Added `getInlineHint()` method to `AutocompleteProvider` interface for displaying dim ghost text after cursor
- Added `hintStyle` theme option to customize styling of inline hint/ghost text in editor

### Changed

- Updated editor to render inline hint text as dim ghost text after cursor when autocomplete suggestions are active or provider supplies hints

## [11.8.0] - 2026-02-10
### Added

- Added Alt+Y keybinding to cycle through kill ring entries (yank-pop)
- Added undo support to Input component with Ctrl+Z keybinding
- Added kill ring support to Input component for Emacs-style kill/yank operations
- Added yank (Ctrl+Y) and yank-pop (Alt+Y) support to Input component

### Changed

- Changed Editor kill ring implementation to use dedicated KillRing class for better state management
- Changed Editor undo stack to use generic UndoStack class with automatic state cloning
- Changed kill/yank behavior to properly accumulate consecutive kill operations
- Changed Input component deletion methods to record killed text in kill ring
- Changed undo coalescing in Input component to group consecutive word typing into single undo units

## [11.4.1] - 2026-02-06
### Fixed

- Fixed terminal scrolling when displaying overlays after rendering large content, preventing hundreds of blank lines from being output

## [11.3.0] - 2026-02-06

### Breaking Changes

- Removed `getCursorPosition()` method from Component interface and implementations, eliminating hardware cursor positioning support

### Added

- Added sticky column behavior for vertical cursor movement, preserving target column when navigating through lines of varying lengths
- Added `drainInput()` method to Terminal interface to prevent Kitty key release events from leaking to parent shell over slow SSH connections
- Added `setClearOnShrink()` method to control whether full re-render occurs when content shrinks below working area
- Added support for hidden paths (e.g., `.pi`, `.github`) in autocomplete while excluding `.git` directories

### Changed

- Changed default value of `PI_HARDWARE_CURSOR` environment variable from implicit true to explicit `"1"` for clarity
- Changed default value of `PI_CLEAR_ON_SHRINK` environment variable from implicit false to explicit `"0"` for clarity
- Changed TUI to clear screen on startup to prevent shell prompts and status messages from bleeding into the first rendered frame
- Refactored full-render logic into reusable helper function to reduce code duplication across multiple render paths
- Changed autocomplete to include hidden paths but filter out `.git` and its contents
- Changed Input component to properly handle surrogate pairs in Unicode text, preventing cursor display corruption with emoji and multi-byte characters
- Changed Editor to use `setCursorCol()` for all cursor column updates, enabling sticky column tracking
- Changed Editor's vertical navigation to implement sticky column logic via `moveToVisualLine()` and `computeVerticalMoveColumn()`
- Changed Editor's Enter key handling to extract submit logic into `submitValue()` method for better code organization
- Changed SettingsList to truncate long lines to viewport width, preventing text overflow
- Changed Terminal's `stop()` method to drain stdin before restoring raw mode, fixing race condition where Ctrl+D could close parent shell over SSH
- Changed TUI rendering to add `clearOnShrink` option (controlled by `PI_CLEAR_ON_SHRINK` env var) for reducing redraws on slower terminals
- Changed TUI rendering to detect when extra lines exceed viewport height and trigger full re-render instead of incremental updates

### Fixed

- Fixed rendering of extra blank lines when content shrinks by improving cursor positioning logic during line deletion
- Fixed cursor display position in Input component when scrolling horizontally through long text
- Fixed Kitty keyboard protocol disable sequence to use safe write method, preventing potential output buffering issues
- Fixed unnecessary full-screen redraws when changes occur in out-of-view components (e.g., spinners), reducing terminal scroll events and improving performance on slower connections
- Fixed scrollback clearing behavior to only clear screen instead of scrollback when resizing or shrinking content, preventing loss of terminal history
- Fixed `.git` directory appearing in autocomplete suggestions when filtering by prefix
- Fixed cursor position corruption in Input component when displaying text with emoji and combining characters
- Fixed `.git` directory appearing in autocomplete suggestions
- Fixed race condition where Kitty key release events could leak to parent shell after TUI exit over slow SSH connections
- Fixed Editor's word movement (Ctrl+Left/Right) to properly reset sticky column for subsequent vertical navigation
- Fixed Editor's undo operation to reset sticky column state when restoring cursor position
- Fixed Editor's right arrow key at end of last line to set sticky column for subsequent up/down navigation
- Fixed TUI rendering to correctly detect viewport changes and avoid false full-redraws after content shrinks
- Fixed Kitty protocol key parsing to prefer codepoint over base layout for Latin letters and symbols, fixing keyboard layout issues (e.g., Dvorak)

## [11.0.0] - 2026-02-05

### Added

- Introduced `terminal-capabilities.ts` module consolidating terminal detection and image protocol support
- Added `TerminalInfo` class with methods for detecting image lines and formatting notifications
- Added `NotifyProtocol` enum supporting Bell, OSC 99, and OSC 9 notification protocols
- Added `isNotificationSuppressed()` function to check `GJC_NOTIFICATIONS` environment variable
- Added `TERMINAL` constant providing detected terminal capabilities at runtime

### Changed

- Changed notification suppression environment variable from `GJC_NOTIFICATIONS` to `PI_NOTIFICATIONS`
- Changed TUI write log environment variable from `GJC_TUI_WRITE_LOG` to `PI_TUI_WRITE_LOG`
- Changed hardware cursor environment variable from `GJC_HARDWARE_CURSOR` to `PI_HARDWARE_CURSOR`
- Updated environment variable access to use `getEnv()` utility function from `@gajae-code/utils` for consistent handling
- Renamed `TERMINAL_INFO` export to `TERMINAL` for clearer API semantics
- Reorganized terminal image exports from `terminal-image` to `terminal-capabilities` module
- Updated all internal references to use `TERMINAL` instead of `TERMINAL_INFO`

### Removed

- Removed `terminal-image` module exports from public API (functionality migrated to `terminal-capabilities`)

## [10.5.0] - 2026-02-04

### Fixed

- Treated inline image lines with cursor-move prefixes as image sequences to prevent width overflow crashes

## [9.8.0] - 2026-02-01

### Changed

- Moved `wrapTextWithAnsi` export to `@gajae-code/natives` package

### Fixed

- Improved Kitty terminal key sequence parsing to correctly handle text field codepoints in CSI-u sequences
- Fixed handling of private use Unicode codepoints (U+E000 to U+F8FF) in Kitty key decoding to prevent invalid character interpretation

## [9.7.0] - 2026-02-01
### Breaking Changes

- Removed `Key` helper object from public API; use string literals like `"ctrl+c"` instead of `Key.ctrl("c")`
- Removed `KeyEventType` export from public API

### Changed

- Migrated key parsing and matching logic to native implementation for improved performance
- Simplified `isKeyRelease()` and `isKeyRepeat()` to use regex pattern matching instead of string inclusion checks

## [9.6.2] - 2026-02-01
### Changed

- Renamed `EllipsisKind` enum to `Ellipsis` for clearer API naming
- Changed hardcoded ellipsis character from theme-configurable to literal "…" in editor truncation
- Refactored `visibleWidth` function to use caching wrapper around new `visibleWidthRaw` implementation for improved performance

### Removed

- Removed `truncateToWidth`, `sliceWithWidth`, and `extractSegments` functions from public API (now re-exported directly from @gajae-code/natives)
- Removed `ellipsis` property from `SymbolTheme` interface
- Removed `extractAnsiCode` function from public API

## [9.6.1] - 2026-02-01
### Changed

- Improved performance of key ID parsing with optimized cache lookup strategy
- Simplified `visibleWidth` calculation to use consistent Bun.stringWidth approach for all string lengths

### Removed

- Removed `visibleWidth` benchmark file in favor of Kitty sequence benchmarking

## [9.5.0] - 2026-02-01
### Changed

- Improved fuzzy file search performance by using native implementation instead of spawning external process
- Replaced external `fd` binary with native fuzzy path search for `@`-prefixed autocomplete

## [9.4.0] - 2026-01-31
### Added

- Exported `padding` utility function for creating space-padded strings efficiently

### Changed

- Optimized padding operations across all components to use pre-allocated space buffer for better performance

## [9.2.2] - 2026-01-31

### Added
- Added setAutocompleteMaxVisible() configuration (3-20 items)
- Added image detection to terminal capabilities (containsImage method)
- Added stdin monitoring to detect stalled input events and log warnings

### Changed
- Improved blockquote rendering with text wrapping in Markdown component
- Restructured terminal capabilities from interface-based to class-based model
- Improved table column width calculation with word-aware wrapping
- Refactored text utilities to use native WASM implementations for strings >256 chars with JS fast path

### Fixed
- Simplified terminal write error handling to mark terminal as dead on any write failure
- Fixed multi-line strings in renderOutputBlock causing width overflow
- Fixed slash command autocomplete applying stale completion when typing quickly

### Removed
- Removed TUI layout engine exports from public API (BoxNode, ColumnNode, LayoutNode, etc.)

## [8.12.7] - 2026-01-29

### Fixed
- Fixed slash command autocomplete applying stale completion when typing quickly

## [8.4.1] - 2026-01-25

### Added
- Added fuzzy match function for autocomplete suggestions
## [8.4.0] - 2026-01-25

### Changed
- Added Ctrl+Backspace as a delete-word-backward keybinding and improved modified backspace matching

### Fixed
- Terminal gracefully handles write failures by marking dead instead of exiting the process
- Reserved cursor space for zero padding and corrected end-of-line cursor rendering to prevent wrap glitches
- Corrected editor end-of-line cursor rendering assertion to use includes() instead of endsWith()
## [8.2.0] - 2026-01-24

### Added
- Added mermaid diagram rendering engine (renderMermaidToPng) with mmdc CLI integration
- Added terminal graphics encoding (iTerm2/Kitty) for mermaid diagrams with automatic width scaling
- Added mermaid block extraction and deduplication utilities (extractMermaidBlocks)

### Changed
- Updated TypeScript configuration for better publish-time configuration handling with tsconfig.publish.json
- Migrated file system operations from synchronous to asynchronous APIs in autocomplete provider for non-blocking I/O
- Migrated node module imports from named to namespace imports across all packages for consistency with project guidelines

### Fixed
- Fixed crash when terminal becomes unavailable (EIO errors) by exiting gracefully instead of throwing
- Fixed potential errors during emergency terminal restore when terminal is already dead
- Fixed autocomplete race condition by tracking request ID to prevent stale suggestion results
## [6.8.3] - 2026-01-21
### Added

- Added undo support in the editor via `Ctrl+-`
- Added `Alt+Delete` as a delete-word-forward shortcut
- Added configurable code block indentation for Markdown rendering
- Added undo support in the editor via `Ctrl+-`.
- Added configurable code block indentation for Markdown rendering.
- Added `Alt+Delete` as a delete-word-forward shortcut.

### Changed

- Improved fuzzy matching to handle alphanumeric swaps
- Normalized keybinding definitions to lowercase internally
- Improved fuzzy matching to handle alphanumeric swaps.
- Normalized keybinding definitions to lowercase internally.

### Fixed

- Added legacy terminal support for `Ctrl+` symbol key combinations
- Added legacy terminal support for `Ctrl+` symbol key combinations.

## [6.8.1] - 2026-01-20

### Fixed

- Fixed viewport tracking after partial renders to prevent autocomplete list artifacts

## [5.6.7] - 2026-01-18

### Added

- Added configurable editor padding via `editorPaddingX` theme option
- Added `setMaxHeight()` method to limit editor height with scrolling
- Added Emacs-style kill ring for text deletion operations
- Added `Alt+D` keybinding to delete words forward
- Added `Ctrl+Y` keybinding to yank from kill ring
- Added `waitForRender()` method to await pending renders
- Added Focusable interface and hardware cursor marker support for IME positioning
- Added support for shifted symbol keys in keybindings

### Changed

- Updated tab bar rendering to wrap text across multiple lines when content exceeds available width
- Expanded Kitty keyboard protocol coverage for non-Latin layouts and legacy Alt sequences
- Improved cursor positioning with safer bounds checking
- Updated editor layout to respect configurable padding
- Refactored scrolling logic for better viewport management

### Fixed

- Fixed key detection for shifted symbol characters
- Fixed backspace handling with additional codepoint support
- Fixed Alt+letter key combinations for better recognition

## [5.3.1] - 2026-01-15
### Fixed

- Fixed rendering issues on Windows by preventing re-entrant renders

## [5.1.0] - 2026-01-14

### Added

- Added `pageUp` and `pageDown` key support with `selectPageUp`/`selectPageDown` editor actions
- Added `isPageUp()` and `isPageDown()` helper functions
- Added `SizeValue` type for CSS-like overlay sizing (absolute or percentage strings like `"50%"`)
- Added `OverlayHandle` interface with `hide()`, `setHidden()`, `isHidden()` methods for overlay visibility control
- Added `visible` callback to `OverlayOptions` for dynamic visibility based on terminal dimensions
- Added `pad` parameter to `truncateToWidth()` for padding result with spaces to exact width

### Changed

- Changed `OverlayOptions` to use `SizeValue` type for `width`, `maxHeight`, `row`, and `col` properties
- Changed `showOverlay()` to return `OverlayHandle` for controlling overlay visibility
- Removed `widthPercent`, `maxHeightPercent`, `rowPercent`, `colPercent` from `OverlayOptions` (use percentage strings instead)

### Fixed

- Fixed numbered list items showing "1." for all items when code blocks break list continuity
- Fixed width overflow protection in overlay compositing to prevent TUI crashes

## [4.7.0] - 2026-01-12

### Fixed
- Remove trailing space padding from Text, Markdown, and TruncatedText components when no background color is set (fixes copied text including unwanted whitespace)

## [4.6.0] - 2026-01-12

### Added
- Add fuzzy matching module (`fuzzyMatch`, `fuzzyFilter`) for command autocomplete
- Add `getExpandedText()` to editor for expanding paste markers
- Add backslash+enter newline fallback for terminals without Kitty protocol

### Fixed
- Remove Kitty protocol query timeout that caused shift+enter delays
- Add bracketed paste check to prevent false key release/repeat detection
- Rendering optimizations: only re-render changed lines
- Refactor input component to use keybindings manager

## [4.4.4] - 2026-01-11
### Fixed

- Fixed Ctrl+Enter sequences to insert new lines in the editor

## [4.2.1] - 2026-01-11
### Changed

- Improved file autocomplete to show directory listing when typing `@` with no query, and fall back to prefix matching when fuzzy search returns no results

### Fixed

- Fixed editor redraw glitch when canceling autocomplete suggestions
- Fixed `fd` tool detection to automatically find `fd` or `fdfind` in PATH when not explicitly configured

## [4.1.0] - 2026-01-10
### Added

- Added persistent prompt history storage support via `setHistoryStorage()` method, allowing history to be saved and restored across sessions

## [4.0.0] - 2026-01-10
### Added

- `EditorComponent` interface for custom editor implementations
- `StdinBuffer` class to split batched stdin into individual sequences
- Overlay compositing via `TUI.showOverlay()` and `TUI.hideOverlay()` for `ctx.ui.custom()` with `{ overlay: true }`
- Kitty keyboard protocol flag 2 support for key release events (`isKeyRelease()`, `isKeyRepeat()`, `KeyEventType`)
- `setKittyProtocolActive()`, `isKittyProtocolActive()` for Kitty protocol state management
- `kittyProtocolActive` property on Terminal interface to query Kitty protocol state
- `Component.wantsKeyRelease` property to opt-in to key release events (default false)
- Input component `onEscape` callback for handling escape key presses

### Changed

- Terminal startup now queries Kitty protocol support before enabling event reporting
- Default editor `newLine` binding now uses `shift+enter` only

### Fixed

- Key presses no longer dropped when batched with other events over SSH
- TUI now filters out key release events by default, preventing double-processing of keys
- `matchesKey()` now correctly matches Kitty protocol sequences for unmodified letter keys
- Crash when pasting text with trailing whitespace exceeding terminal width through Markdown rendering

## [3.32.0] - 2026-01-08

### Fixed

- Fixed text wrapping allowing long whitespace tokens to exceed line width

## [3.20.0] - 2026-01-06
### Added

- Added `isCapsLock` helper function for detecting Caps Lock key press via Kitty protocol
- Added `isCtrlY` helper function for detecting Ctrl+Y keyboard input
- Added configurable editor keybindings with typed key identifiers and action matching
- Added word-wrapped editor rendering for long lines

### Changed

- Settings list descriptions now wrap to the available width instead of truncating

### Fixed

- Fixed Shift+Enter detection in legacy terminals that send ESC+CR sequence

## [3.15.1] - 2026-01-05

### Fixed

- Fixed editor cursor blinking by allowing terminal cursor positioning when enabled.

## [3.15.0] - 2026-01-05

### Added

- Added `inputCursor` symbol for customizing the text input cursor character
- Added `symbols` property to `EditorTheme`, `MarkdownTheme`, and `SelectListTheme` interfaces for component-level symbol customization
- Added `SymbolTheme` interface for customizing UI symbols including cursors, borders, spinners, and box-drawing characters
- Added support for custom spinner frames in the Loader component

## [3.9.1337] - 2026-01-04
### Added

- Added `setTopBorder()` method to Editor component for displaying custom status content in the top border
- Added `getWidth()` method to TUI class for retrieving terminal width
- Added rounded corner box-drawing characters to Editor component borders

### Changed

- Changed Editor component to use proper box borders with vertical side borders instead of horizontal-only borders
- Changed cursor style from block to thin blinking bar (▏) at end of line

## [1.500.0] - 2026-01-03
### Added

- Added `getText()` method to Text component for retrieving current text content

## [1.337.1] - 2026-01-02

### Added

- TabBar component for horizontal tab navigation
- Emergency terminal restore to prevent corrupted state on crashes
- Overhauled UI with welcome screen and powerline footer
- Theme-configurable HTML export colors
- `ctx.ui.theme` getter for styling status text with theme colors

### Changed

- Forked to @gajae-code scope with unified versioning across all packages

### Fixed

- Strip OSC 8 hyperlink sequences in `visibleWidth()`
- Crash on Unicode format characters in `visibleWidth()`
- Markdown code block syntax highlighting

## [1.337.0] - 2026-01-02

Initial release under @gajae-code scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.31.1] - 2026-01-02

### Fixed

- `visibleWidth()` now strips OSC 8 hyperlink sequences, fixing text wrapping for clickable links ([#396](https://github.com/badlogic/pi-mono/pull/396) by [@Cursivez](https://github.com/Cursivez))

## [0.31.0] - 2026-01-02

### Added

- `isShiftCtrlO()` key detection function for Shift+Ctrl+O (Kitty protocol)
- `isShiftCtrlD()` key detection function for Shift+Ctrl+D (Kitty protocol)
- `TUI.onDebug` callback for global debug key handling (Shift+Ctrl+D)
- `wrapTextWithAnsi()` utility now exported (wraps text to width, preserving ANSI codes)

### Changed

- README.md completely rewritten with accurate component documentation, theme interfaces, and examples
- `visibleWidth()` reimplemented with grapheme-based width calculation, 10x faster on Bun and ~15% faster on Node ([#369](https://github.com/badlogic/pi-mono/pull/369) by [@nathyong](https://github.com/nathyong))

### Fixed

- Markdown component now renders HTML tags as plain text instead of silently dropping them ([#359](https://github.com/badlogic/pi-mono/issues/359))
- Crash in `visibleWidth()` and grapheme iteration when encountering undefined code points ([#372](https://github.com/badlogic/pi-mono/pull/372) by [@HACKE-RC](https://github.com/HACKE-RC))
- ZWJ emoji sequences (rainbow flag, family, etc.) now render with correct width instead of being split into multiple characters ([#369](https://github.com/badlogic/pi-mono/pull/369) by [@nathyong](https://github.com/nathyong))

## [0.29.0] - 2025-12-25

### Added

- **Auto-space before pasted file paths**: When pasting a file path (starting with `/`, `~`, or `.`) and the cursor is after a word character, a space is automatically prepended for better readability. Useful when dragging screenshots from macOS. ([#307](https://github.com/badlogic/pi-mono/pull/307) by [@mitsuhiko](https://github.com/mitsuhiko))
- **Word navigation for Input component**: Added Ctrl+Left/Right and Alt+Left/Right support for word-by-word cursor movement. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))
- **Full Unicode input**: Input component now accepts Unicode characters beyond ASCII. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

### Fixed

- **Readline-style Ctrl+W**: Now skips trailing whitespace before deleting the preceding word, matching standard readline behavior. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))
