# Modes TUI design system

## Workflow branch and sources

This surface uses the **extract existing system first** branch from
[`docs/ui-design-visual-qa.md`](../../../../docs/ui-design-visual-qa.md). The
rules below are extracted from the current settings selector and shared TUI
components; they are first-party implementation guidance, not a third-party
reference or a screenshot substitute.

Source material:

- `components/settings-selector.ts` and `components/settings-defs.ts`
- `components/provider-onboarding-selector.ts` and `components/dynamic-border.ts`
- the status-line custom editor embedded in `components/settings-selector.ts`
- `../theme/theme.ts` and `../shared.ts`
- `packages/tui/src/components/tab-bar.ts`, `settings-list.ts`, `select-list.ts`,
  and `input.ts`

## Existing visual grammar

### Tokens and theme roles

- **Foreground roles:** use `accent` for the active cursor, active setting
  label/value, titles, and the Settings label; `text` for ordinary active-tab
  content; `muted` for inactive tabs and secondary values; `dim` for
  descriptions, navigation hints, and unavailable preview text; `border` for
  structural rules. The selector must use semantic theme roles rather than
  hard-coded SGR values.
- **Selection:** the active tab is bold `text` on `selectedBg`; a selected list
  row has an `accent` cursor and accent label/value. Selection remains
  distinguishable by cursor, reverse/background treatment, and its position,
  not color alone.
- **Symbols:** Unicode defaults include `❯` for the navigation cursor and
  `─` for the sharp horizontal rule. The ASCII preset supplies `>` for the
  cursor and ASCII box/separator alternatives. A no-color render removes SGR
  styling but retains textual state, cursor, selection, and action labels.
- **Typography and density:** terminal cells are the grid. Current selector
  titles are bold, one line; ordinary list rows are one line; descriptions are
  indented two spaces and are secondary. Do not invent rounded cards, shadow,
  or pixel-like padding. Preserve the compact one-cell vertical rhythm used by
  `Spacer(1)`.

### Frame and navigation anatomy

The existing settings selector is a vertically stacked frame:

1. a `DynamicBorder` renders a full-width sharp horizontal rule in `border`;
2. a `TabBar` renders `Settings:` followed by tab chunks and the dim
   `(tab to cycle)` hint;
3. one blank spacer row separates navigation from content;
4. the selected tab content renders; and
5. the same border closes the frame.

`TabBar` gives each tab a leading/trailing space, leaves two spaces between
chunks, and wraps *between chunks* when the next chunk exceeds the available
visible width. It cycles with Tab/Right and Shift+Tab/Left. The tab label and
hint can occupy their own lines at narrow widths; this is intentional rather
than a reason to truncate tab identities.

`SettingsList` uses a two-column row: cursor/indent, a label padded to a
visible-width-aligned column capped at 30 cells, two spaces, then a truncated
value. The selected row uses the themed cursor; unselected rows reserve two
spaces. It centers the selected item inside its `maxVisible` window, reports
scroll position as `(current/total)`, places a blank row before the selected
item description, and ends with the dim
`Enter/Space to change · Esc to cancel` hint. Hosts that need stable height
reserve fixed description rows; the status-line custom editor reserves two.

Submenus are a content replacement, not a modal overlay: a bold accent title,
optional muted description, optional preview, a spacer, a select/list control,
and a dim return hint. The status-line custom editor demonstrates the expected
pattern for a transactional draft: live preview while editing; explicit
**Save** and **Cancel and restore** actions; save only commits the draft;
cancel restores the prior preview.

Provider onboarding is the smaller framed-list variant: border, spacer, bold
title, muted explanatory line, spacer, cursor list with each description
indented four spaces, guidance, spacer, border. It establishes the expected
empty space and list density for an operational setup flow.

### Focus, cursor, keyboard, and input behavior

- Up/Down wrap within selector lists. Enter and Space activate the current
  action. Escape follows the current component's cancel path before the parent
  is allowed to close.
- The parent routes Tab/Left/Right to the tab bar except while a text input is
  active. Text entry owns arrow keys and Tab in that state.
- `Input` has a visible `> ` prompt, a zero-width hardware cursor marker only
  while focused, and inverse video on the current grapheme. It horizontally
  scrolls to keep the cursor grapheme visible, including wide graphemes.
- Input normalizes to NFC, moves/deletes by grapheme cluster, supports word
  navigation, undo, kill/yank, bracketed paste, and replaces pasted tabs while
  removing line breaks. Notification secrets will use the dedicated masked
  input from Work item 6; they must never appear in list values, descriptions,
  previews, artifacts, or logs.
### Shortcut labels and binding authority

Keybinding configuration is a portable canonical grammar: textual key IDs use `ctrl`, `alt`, `shift`, and `super` plus a key name (for example, `ctrl+p` or `alt+enter`). Do not serialize or require display-only labels. Runtime UI renders those IDs through the shared formatter for its explicit platform context; macOS uses MacBook-style glyphs (`⌃`, `⌥`, `⇧`, `⌘`, `↩`, `⎋`, `⇥`, `⌫`, `⌦`, and arrow glyphs) while other platforms use textual labels. A glyph is never configuration syntax.

Static onboarding and generated documentation have authority only over shipped defaults. Keep generated tables host-independent by showing canonical textual IDs, not the capture host's labels. The runtime `KeybindingsManager` owns the effective binding set after user remaps and extensions load; `/hotkeys` and runtime hints must render that effective set with the platform context injected by their host. Do not let a static onboarding hint imply that it reflects remaps.

### Status, errors, confirmation, and disabled work

Operational status is concise, textual, and adjacent to the action/list that
caused it. Success, warning, error, pending/running, disabled, blocked, and
aborted states use the themed status symbols when available, but also name the
condition in prose. Error guidance states the safe recovery action without
showing credentials. Confirmations are explicit focused choices; destructive
remove/disable actions are never the default side effect of navigation.

A non-cancellable action visibly locks navigation and names the reason. A
cancellable action names cancellation while it is pending, aborts on exit, and
must not render a late completion after disposal. This follows the selector's
existing preview/cancel ownership rather than adding a parallel focus model.

### Motion, no-motion, and depth

The selector has no required animation, easing, shadows, or overlay depth.
State changes are discrete renders. Pending work may use a static pending or
running symbol and textual progress; it must be equally understandable with
reduced motion or no motion. Do not add a spinner whose frame is the only
signal of progress.

### Accessibility and international text

- Never rely on hue, Unicode-only iconography, or an animated spinner as the
  sole indication of selection, severity, progress, or confirmation.
- Keep keyboard affordances visible in the persistent hint and retain a clear
  selected cursor in ASCII/no-color output.
- Measure clipping and alignment with ANSI-aware terminal-cell width helpers;
  do not use JavaScript string length for CJK layout.
- Preserve NFC in editable values. Use grapheme-aware cursor and deletion
  behavior. When CJK or mixed CJK/Latin prose wraps, break between semantic
  phrases/actions, never through an action label, a status name, a masked
  secret marker, or a short code/config identifier. CJK semantic wrapping
  defects block visual QA.

## Responsive contract

The canonical visual-QA viewports are **80×24**, **120×36**, and **160×48**
terminal cells. Captures include the whole terminal surface for each state.

- **80×24:** prioritize the selected action, one-line status, and navigation
  hint. The final Settings tab bar including Notifications must occupy no more
  than four rendered lines, leaving at least 14 rows between the tab spacer and
  closing border. The selected action, its one-line status, and one-line hint
  must be simultaneously visible in that content budget. Long guidance wraps
  only in its allocated body region; the list scrolls rather than pushing the
  focused action below the frame.
- **120×36:** retain the same anatomy and show the summary, active action list,
  status, and localized sample without clipping. Use the additional height for
  description/guidance, not decorative whitespace.
- **160×48:** retain the same hierarchy and terminal density while exposing the
  full status/help detail and all relevant scroll positions. It is not a
  different desktop layout.

## Notifications editor contract (Work item 7 consumer)

The Notifications editor will be a directly hosted `Notifications` tab, not a
`SettingItem.submenu`. It preserves the frame above and owns its lifecycle.
Its body is ordered as:

1. a concise global/session/runtime summary;
2. an actionable list (configure/reconfigure, global enable/disable,
   session on/off, health, test, recovery, reconnect, and adapter-local remove
   where applicable);
3. one focused status/progress or confirmation region;
4. contextual localized guidance; and
5. a persistent keyboard/navigation hint.

Masked credential entry is a dedicated focus state, never a generic text
setting. Pairing is cancellable; save, health probe, test, recovery, and
reconnect are guarded as specified by the product plan. Tab navigation must
abort and await a cancellable pairing before switching; it must remain locked
for guarded work. Completion after disposal is ignored.

The showcase fixture and capture script render the live
`SettingsSelectorComponent` Notifications tab with in-memory operations and a
fixed clock. Captures are deterministic visual evidence for the product screen;
they must never fall back to placeholder text or bypass the real editor render.

## Canonical showcase states

These identifiers are stable external visual-QA contract values. Do not rename,
combine, or substitute them.

| State ID | Required condition represented |
| --- | --- |
| `home-unconfigured` | No configured notification destination. |
| `home-configured-inactive` | Credentials/configuration exist; current session is inactive. |
| `home-runtime-active` | Current session endpoint is active. |
| `home-local-off` | Current session is explicitly locally disabled. |
| `home-env-off` | Environment hard-off suppresses the surface/runtime. |
| `home-env-on` | Explicit environment opt-in enables the current session. |
| `home-discord-only` | Global Discord configuration without Telegram setup. |
| `home-slack-only` | Global Slack configuration without Telegram setup. |
| `setup-provider` | Provider choice is focused. |
| `setup-chat-entry` | Telegram chat ID field is focused. |
| `setup-token-entry` | Masked Telegram token field is focused. |
| `setup-validating` | Token/destination validation is pending. |
| `setup-threaded-warning` | Threaded mode compatibility warning is visible. |
| `setup-pairing` | Cancellable private-chat pairing/discovery is pending. |
| `setup-review` | Sanitized setup choices await explicit save. |
| `saving` | Durable atomic save is in progress and guarded. |
| `health-probing` | Non-cancellable health probe is in progress and guarded. |
| `health-ok` | Health report is successful. |
| `health-warning` | Health report contains a recoverable warning. |
| `no-health-load` | Health data is unavailable and reload guidance is visible. |
| `testing` | Notification delivery test is in progress and guarded. |
| `recovering` | Recovery action is in progress and guarded. |
| `reconnecting` | Reconnect action is in progress and guarded. |
| `navigation-locked` | A guarded operation explains why Tab/Escape cannot leave. |
| `confirmation-remove` | Adapter-local Telegram removal awaits confirmation. |
| `confirmation-disable` | Global disable awaits confirmation. |
| `success` | A completed operation has concise success copy. |
| `preferences` | Notification preferences are visible and editable. |
| `error` | A sanitized operation failure has recovery guidance. |
| `foreign-blocked` | A foreign/unknown daemon identity blocks activation safely. |
| `blocked-restore-retain` | A blocked post-save identity race requires Restore or Retain before navigation. |
| `cancellation` | A cancellable setup/pairing action was cancelled and restored. |
| `narrow-cjk` | Narrow localized CJK content exercises semantic line wrapping. |
| `narrow-scroll` | Narrow viewport content exercises vertical scrolling and focus visibility. |

## Deterministic showcase and capture matrix

`test/fixtures/tui/notifications-settings-showcase.ts` is the source of truth
for the canonical states, localized English/Korean/Japanese/Chinese content,
viewports, and matrix. The required capture command is:

```sh
bun packages/coding-agent/scripts/capture-notifications-settings-showcase.ts --output .gjc/qa/issue-2050-notifications
```

The baseline consists of every canonical state at `80x24`, `120x36`, and
`160x48` using `unicode-color`: **34 × 3 = 102** entries. Add exactly these
ASCII/no-color variants:

- `home-configured-inactive/80x24/ascii-no-color`
- `health-warning/80x24/ascii-no-color`
- `foreign-blocked/120x36/ascii-no-color`
- `confirmation-remove/80x24/ascii-no-color`

Add exactly these targeted narrow Unicode variants at `48x36`:

- `narrow-cjk/48x36/unicode-color`
- `narrow-scroll/48x36/unicode-color`

The expected manifest count is therefore **108 = (34 × 3) + 4 + 2**. Every key
is `{state_id}/{viewport}/{render_mode}`. Each entry directory contains
`terminal.txt`, `terminal-ansi.txt`, `terminal.html`, and `metadata.json`; the
root `manifest.json` lists all 108 entries and the SHA-256/byte length of every
entry file. Metadata records replay source, terminal size, fixed fixture
capture timestamp, rendering assumptions, wrapping policy, and capture mode.

Regenerate captures, inspect all relevant scroll positions, and obtain an
independent-review receipt at
`.gjc/qa/issue-2050-notifications/independent-review.json`. The reviewer must
not be the implementing executor. That receipt must use the plan's schema and
record both manifest counts as 108 plus CJK review results.

No raw third-party design corpus, screenshot, or reference asset is stored by
this workflow.

## Sticky transcript viewport contract

Live mode remains in natural terminal flow. Entering manual history makes the
application-owned transcript lane scrollable while the status line and every
later direct composer child are a fixed suffix at the bottom. PageUp/PageDown
move by the transcript capacity; the wheel remains three rows. A focused editor
keeps focus, and ordinary editor input or paste follows live before processing
that input.

Manual output has one bounded boolean indication, exactly **`New output — type
to follow`**. It is not a count. New visible agent/tool/extension output may set
it while manual; reflow, transient chrome, reconciliation, and user input may
not. Following clears it only after a successful live repaint. Manual-era output
is authoritative in the application transcript but is never retroactively
replayed into native host scrollback; subsequent ordinary live output follows
normal host behavior.

The transcript is the only selectable coordinate space. Pinned status/composer
chrome, notices, blank rows, and overlays never enter selection or copied text;
CJK selection clamping remains directional and grapheme/cell aware. Under
constrained height the notice drops first, then decorative pet and low-priority
hooks. Focused editor/cursor, status, and normal hooks outrank those rows; zero
transcript capacity is valid and must not corrupt cursor geometry.

At narrow widths use ANSI-aware terminal-cell measurement. ASCII/no-color keeps
textual state without SGR. Korean, Japanese, Chinese, and mixed CJK/Latin prose
must wrap at semantic phrase boundaries, never through an action/status label or
short identifier; a semantic CJK break is a visual-QA failure.

### Direct-root anatomy, IRC lane, and pin boundary

The production root has one ordered, direct-child anatomy. Do not wrap, reorder,
or independently pin these regions:

1. `ircSplitView` is the viewport anchor and owns the transcript (and the IRC
   sidebar when effective);
2. `pendingMessagesContainer`, `statusContainer`, `todoContainer`, and
   `btwContainer` follow the anchor **before** the pin boundary;
3. `statusLine` is the pin boundary; and
4. `hookWidgetContainerAbove`, `editorContainer`, `petFloorContainer`, and
   `hookWidgetContainerBelow` are the later direct composer children in that
   order.

`statusContainer` is transient operation/status content in the pre-boundary
application flow; it is not the persistent `statusLine` telemetry rail. The
status line begins the fixed suffix. The focused editor, its cursor, and every
later direct composer child remain below that boundary during manual history,
streaming, and reflow. Pending messages, todo, and BTW therefore remain
transcript-adjacent rather than becoming accidental fixed chrome.

IRC has one shared work-lane geometry. At **64 cells or narrower** the IRC lane
is ineffective and transcript/todo use the full width. At **65 cells** it is
exactly **32 / 3 / 30** cells (left work lane / separator / IRC lane). At wider
sizes the same split calculation applies; todo uses the left work lane whenever
IRC is effective, including empty, streaming, and long IRC histories. Todo
does not create a second sidebar, a separately rounded width, or a different
collapse rule.

Todo is absent when empty. Populated todos support long text, multiple phases,
and collapsed/expanded views without crossing the separator or overflowing
their work lane. The active phase is retained in collapsed view; expanded view
keeps phase/task order. IRC empty, streaming, and long states preserve the
same root order and pin boundary.

Row reservation is content-priority based: reserve the focused composer and
status line first, then normal hooks; when height is constrained, drop the
manual-output notice first, then the decorative pet, then low-priority hooks.
A zero-row transcript capacity is valid. Neither reservation nor degradation
may hide focus/cursor geometry, move an anchor into pinned chrome, or turn a
resize into a follow/manual state change. Manual and follow paths, streaming
updates, width growth/shrink, and height growth/shrink preserve the anchor
semantics; resize must recompute the shared IRC/todo lane before rendering.

All lane measurement, clipping, and wrapping is ANSI-aware terminal-cell
measurement. Terminal graphics may be shown only where the effective layout
permits them and must degrade to the textual graphics fallback without changing
row ownership. ANSI/color output preserves visible cursor/focus state; ASCII
and no-color output retains textual selection/status affordances. CJK and mixed
CJK/Latin todo, IRC, status, and BTW text break at semantic phrase boundaries,
not inside a phase/action/status label, short identifier, or grapheme cluster.
Those defects, width overflow, overlap, hidden focus/cursor, and lost anchors
are blocking visual-QA failures.
### Sticky viewport deterministic visual QA

`test/fixtures/tui/sticky-viewport-showcase.ts` is a fixed-clock, no-network,
first-party harness that starts the production `TUI` over a `VirtualTerminal`.
It constructs transcript, status, hooks, and the real composer as children,
then drives the live/manual viewport path before capturing the terminal frame.
Capture with `bun packages/coding-agent/scripts/capture-sticky-viewport-showcase.ts
--out .gjc/qa/sticky-viewport-<run>` and verify with the paired `--root` script.
The immutable matrix has exactly 20 keys: `live-overflow`, `manual-history`,
`manual-new-output`, `multiline-editor-hooks-pet`, `capacity-many`,
`capacity-one`, `capacity-zero`, and `selection-boundary` at both 80x24 and
120x36 Unicode/color; plus `manual-new-output/80x24/ascii-no-color`,
`capacity-zero/48x10/ascii-no-color`,
`multiline-editor-hooks-pet/48x10/unicode-color`, and
`narrow-cjk/48x10/unicode-color`. Do not add or replace a manual-follow case.

Each key has only `terminal.txt`, ANSI-preserving `terminal-ansi.txt`, `terminal.html`, and `metadata.json`; the manifest records SHA-256 and byte length. Per-key metadata binds immutable font/render assumptions and the ANSI-aware wrapping/truncation policy. `VirtualTerminal` reconstructs ANSI from visible xterm cells, including cell padding, palette/RGB colors, attributes, and inverse video; plain text is always the stripped reconstruction. The verifier owns an independent literal 20-key oracle and fails closed unless stripped ANSI equals text, `terminal.html` equals the exported canonical `ansiToHtml(terminal-ansi.txt)` byte-for-byte (including its complete document envelope and global CSS), HTML independently preserves the ANSI style-run text, every retained row has the exact `Bun.stringWidth` cell width (including trailing spaces), and `ansi_mode` agrees with required Unicode color SGR or ASCII/no-color output. Every metadata entry has exact CJK phrase-boundary metadata: the narrow-CJK key has only the three canonical boundaries in order and every other key has `[]`. Manual captures prove successful production wheel and PageUp paths and retain observable historical transcript-row evidence. It validates exact payload paths (no duplicates or traversal), immutable source/output revisions, state/status/suffix order, notice cardinality, capacity, actual mouse-copied transcript-only selection, composer, CJK, and provenance invariants. `review-input.json` binds the exact manifest digest, capture author/executor identity, acceptance/design versions, required artifacts, narrow-CJK boundaries, and deterministic host matrix. `--require-independent-review` requires an attestation with an exact root key set; exact per-key result and artifact-check key sets; exact defect `{ description, accepted }` keys with a trimmed, nonblank description; canonical trimmed reviewer identity distinct from both bound identities; the independent-terminal-reviewer role; fixture revision; expected and observed counts of 20; exact checked keys; accepted per-key artifact-check/notes results; accepted artifact/CJK/host decisions; bound digest; and final `accept`. Any malformed, incomplete, or extra attestation content fails closed.
## GJC Bundles

GJC Bundles is a directly hosted Settings surface using the existing framed-list
grammar. A bundle identity is always displayed as its name plus `(user)` or
`(project)`. Same-name rows in opposite scopes are distinct identities and are
never merged, selected together, or mutated through one another.

Only safe source presentation is permitted. Never render or retain a raw source
locator, userinfo, query, fragment, token, authentication material, or a full
parent path in labels, descriptions, status, confirmation, errors, or evidence.

Persisted enablement is user intent: bundle and eligible-surface enabled or
disabled state. Effective runtime status is advisory display evidence only and
never acts as hidden authorization. Deterministic quarantine blocks an enable
action; disable is always available. Runtime evidence does not alter either
rule.

Focus, cursor, wrapping, ANSI-aware cell measurement, CJK semantic wrapping,
and list scrolling follow the existing settings contracts above. Up/Down wrap
within lists. A non-cancellable bundle mutation visibly locks navigation,
including Escape and tab changes, until it completes; the lock names its
reason. Long names and descriptions wrap in allocated content regions without
hiding scope identity, CJK text breaks only at semantic boundaries, ANSI styles
do not affect width measurement, and long surface lists scroll while retaining
the focused row and scroll position.

This Settings surface does not install or uninstall bundles, edit sources, or
repair quarantine. It supports only list/detail, update review/apply,
bundle-toggle, and eligible-surface-toggle actions.

### Create-only refusal and source reachability

An already-installed target is refused with `already_installed_use_upgrade`,
independently of `--force`, and the refusal performs no filesystem mutation:
it is decided before any registry lock is acquired, because acquiring a lock
itself creates the scope root.

Refusal is bound to the bundle name declared in the manifest, because that name
*is* the identity component. When the source is a local directory the name is
read without resolving, so a deleted-and-recreated or offline-but-present source
still refuses correctly.

When the source cannot be read at all — a deleted directory, an unreachable git
remote, a missing tarball — the target's identity is genuinely unknowable before
resolution, so the operation resolves and reports the source failure instead of
refusing. Matching on the stored locator was tried and rejected as unsound: one
locator can resolve to different content over time, the same URI can back two
differently named bundles, and a stored `uri#ref` differs from a bare `uri`, so
locator-based refusal would refuse installs that should proceed. Refusing on a
guess is worse than reporting the real failure, so identity must be readable for
refusal to apply.

## Light-theme compliance contract

This section is the first-party contract for `red-claw-light` and
`blue-crab-light`. It strengthens, but does not replace, the Notifications
contract above. The compliance fixture must request one of those two names
through a closed typed union and must call the named production components.
It must not draw a parallel settings list, transcript, diff, markdown,
syntax, status line, or overflow facsimile.

Canonical capture requires explicit, non-empty implementation and capture
identities. Each identity uses the stable `scheme:value` form (for example,
`github:octocat`):

```sh
GJC_LIGHT_THEME_IMPLEMENTATION_AUTHOR_IDS=github:<implementation-author> \
GJC_LIGHT_THEME_CAPTURE_AUTHOR_IDS=github:<capture-author> \
bun packages/coding-agent/scripts/capture-light-theme-compliance-showcase.ts \
  --output .gjc/qa/gjc-light-theme-compliance/current
```

The output must be a strict, non-symlinked descendant of the repository's
`.gjc/qa` directory. The capture command rejects the filesystem root, home,
repository, `.git`, `.gjc/qa` itself, ancestors, outside paths, lexical `..`
aliases, and symlink aliases before any recursive removal. It also completes
author, environment, and source preflight before replacing a prior corpus.

### Actual consumer and contrast inventory

`pageBg` below means the selected theme's export page background. `default`
means the terminal's declared light background, which the fixture fixes to
`pageBg`. Text pairings require WCAG contrast of at least **4.5:1**.
Structural/non-text pairings require at least **3:1**. IDs are stable test
contract values; a consumer addition or role change must update this table
and the test-side expected set together.

| ID | Production consumer and state | Foreground role | Background role | Class | Minimum | Evidence scene |
| --- | --- | --- | --- | --- | --- | --- |
| `settings-border` | `DynamicBorder.render` frame rule | `border` | `pageBg` | structural | 3:1 | `normal-default` |
| `settings-tab-label` | `getTabBarTheme().label` | `accent` | `pageBg` | text | 4.5:1 | `normal-default` |
| `settings-tab-active` | `getTabBarTheme().active` | `text` | `selectedBg` | text | 4.5:1 | `selected-focus-active` |
| `settings-tab-selected-fill` | active tab fill | `selectedBg` | `pageBg` | structural | 3:1 | `selected-focus-active` |
| `settings-tab-inactive` | `getTabBarTheme().inactive` | `muted` | `pageBg` | text | 4.5:1 | `normal-default` |
| `settings-tab-hint` | `getTabBarTheme().hint` | `dim` | `pageBg` | text | 4.5:1 | `normal-default` |
| `settings-list-selected-label` | `getSettingsListTheme().label(true)` | `accent` | `pageBg` | text | 4.5:1 | `selected-focus-active` |
| `settings-list-selected-value` | `getSettingsListTheme().value(true)` | `accent` | `pageBg` | text | 4.5:1 | `selected-focus-active` |
| `settings-list-value` | `getSettingsListTheme().value(false)` | `muted` | `pageBg` | text | 4.5:1 | `normal-default` |
| `settings-list-description` | `getSettingsListTheme().description` | `dim` | `pageBg` | text | 4.5:1 | `normal-default` |
| `settings-list-cursor` | `getSettingsListTheme().cursor` | `accent` | `pageBg` | text | 4.5:1 | `selected-focus-active` |
| `settings-list-hint` | `getSettingsListTheme().hint` | `dim` | `pageBg` | text | 4.5:1 | `normal-default` |
| `select-list-selected` | `getSelectListTheme` selected prefix/text | `accent` | `pageBg` | text | 4.5:1 | `selected-focus-active` |
| `select-list-secondary` | description, scroll position, no-match | `muted` | `pageBg` | text | 4.5:1 | `empty` |
| `submenu-title` | settings submenu title | `accent` | `pageBg` | text | 4.5:1 | `expanded` |
| `submenu-secondary` | submenu description/preview | `muted` | `pageBg` | text | 4.5:1 | `expanded` |
| `submenu-unavailable` | unavailable preview fallback | `dim` | `pageBg` | text | 4.5:1 | `disabled` |
| `provider-title` | `ProviderOnboardingSelector` bold title | `text` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `provider-selected` | onboarding selected option/cursor | `accent` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `provider-secondary` | onboarding subtitle/option description | `muted` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `assistant-header` | `AssistantMessageComponent` header | `statusLineModel` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `assistant-thinking` | thinking markdown and label | `thinkingText` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `assistant-error` | abort/error line | `error` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `assistant-usage` | token-usage line | `dim` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `tool-pending-title` | `ToolExecutionComponent` pending title | `toolTitle` | `toolPendingBg` | text | 4.5:1 | `consumer-atlas` |
| `tool-pending-output` | pending output/args | `toolOutput` | `toolPendingBg` | text | 4.5:1 | `consumer-atlas` |
| `tool-success-title` | completed tool title | `toolTitle` | `toolSuccessBg` | text | 4.5:1 | `consumer-atlas` |
| `tool-success-output` | completed tool output | `toolOutput` | `toolSuccessBg` | text | 4.5:1 | `consumer-atlas` |
| `tool-error-title` | failed tool title | `toolTitle` | `toolErrorBg` | text | 4.5:1 | `consumer-atlas` |
| `tool-error-output` | failed tool output | `toolOutput` | `toolErrorBg` | text | 4.5:1 | `consumer-atlas` |
| `diff-added` | `renderDiff` added line | `toolDiffAdded` | `toolSuccessBg` | text | 4.5:1 | `diff` |
| `diff-removed` | `renderDiff` removed line | `toolDiffRemoved` | `toolErrorBg` | text | 4.5:1 | `diff` |
| `diff-context` | `renderDiff` context line | `toolDiffContext` | `pageBg` | text | 4.5:1 | `diff` |
| `markdown-heading` | production Markdown heading | `mdHeading` | `pageBg` | text | 4.5:1 | `markdown` |
| `markdown-link` | production Markdown link | `mdLink` | `pageBg` | text | 4.5:1 | `markdown` |
| `markdown-link-url` | production Markdown URL | `mdLinkUrl` | `pageBg` | text | 4.5:1 | `markdown` |
| `markdown-code` | inline code | `mdCode` | `pageBg` | text | 4.5:1 | `markdown` |
| `markdown-code-block` | fenced code text | `mdCodeBlock` | `pageBg` | text | 4.5:1 | `markdown` |
| `markdown-code-border` | fenced code border | `mdCodeBlockBorder` | `pageBg` | structural | 3:1 | `markdown` |
| `markdown-quote` | quote text | `mdQuote` | `pageBg` | text | 4.5:1 | `markdown` |
| `markdown-quote-border` | quote border | `mdQuoteBorder` | `pageBg` | structural | 3:1 | `markdown` |
| `markdown-rule` | horizontal rule | `mdHr` | `pageBg` | structural | 3:1 | `markdown` |
| `markdown-bullet` | list bullet | `mdListBullet` | `pageBg` | text | 4.5:1 | `markdown` |
| `syntax-comment` | highlighted comment | `syntaxComment` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-keyword` | highlighted keyword | `syntaxKeyword` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-function` | highlighted function | `syntaxFunction` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-variable` | highlighted variable | `syntaxVariable` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-string` | highlighted string | `syntaxString` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-number` | highlighted number | `syntaxNumber` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-type` | highlighted type | `syntaxType` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-operator` | highlighted operator | `syntaxOperator` | `pageBg` | text | 4.5:1 | `syntax` |
| `syntax-punctuation` | highlighted punctuation | `syntaxPunctuation` | `pageBg` | text | 4.5:1 | `syntax` |
| `status-group` | `StatusLineComponent` group text | `text` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-separator` | status group separator | `statusLineSep` | `userMessageBg` | structural | 3:1 | `status` |
| `status-model` | model segment | `statusLineModel` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-path` | path segment | `statusLinePath` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-clean` | clean/staged segment | `statusLineGitClean` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-dirty` | dirty/spend segment | `statusLineGitDirty` | `userMessageBg` | text | 4.5:1 | `warning` |
| `status-context` | healthy context segment | `statusLineContext` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-output` | output/rate segment | `statusLineOutput` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-cost` | cost segment | `statusLineCost` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-subagents` | subagent/jobs segment | `statusLineSubagents` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-success` | status-line success state | `success` | `pageBg` | text | 4.5:1 | `success` |
| `status-warning` | status-line warning state | `warning` | `pageBg` | text | 4.5:1 | `warning` |
| `status-error` | status-line error/aborted state | `error` | `pageBg` | text | 4.5:1 | `error` |
| `status-pending` | pending status icon/description | `muted` | `pageBg` | text | 4.5:1 | `pending-loading` |
| `status-running` | running status icon/title | `accent` | `pageBg` | text | 4.5:1 | `pending-loading` |
| `chrome-border-accent` | tree/compaction and high-attention chrome | `borderAccent` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `chrome-border-muted` | welcome pills/decorative rails | `borderMuted` | `pageBg` | structural | 3:1 | `consumer-atlas` |
| `user-message-text` | `UserMessageComponent` text | `userMessageText` | `userMessageBg` | text | 4.5:1 | `consumer-atlas` |
| `custom-message-label` | custom/skill/hook/summary labels | `customMessageLabel` | `customMessageBg` | text | 4.5:1 | `consumer-atlas` |
| `custom-message-text` | custom/skill/hook/summary content | `customMessageText` | `customMessageBg` | text | 4.5:1 | `consumer-atlas` |
| `thinking-off` | `Theme.getThinkingBorderColor` off level | `thinkingOff` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `thinking-minimal` | `Theme.getThinkingBorderColor` minimal level | `thinkingMinimal` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `thinking-low` | `Theme.getThinkingBorderColor` low level | `thinkingLow` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `thinking-medium` | `Theme.getThinkingBorderColor` medium level | `thinkingMedium` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `thinking-high` | `Theme.getThinkingBorderColor` high level | `thinkingHigh` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `thinking-xhigh` | `Theme.getThinkingBorderColor` xhigh level | `thinkingXhigh` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `bash-mode` | shell label/execution frame | `bashMode` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `python-mode` | eval execution frame | `pythonMode` | `pageBg` | text | 4.5:1 | `consumer-atlas` |
| `status-spend` | input/total/usage segments | `statusLineSpend` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-staged` | staged git marker | `statusLineStaged` | `userMessageBg` | text | 4.5:1 | `status` |
| `status-unstaged` | unstaged git marker | `statusLineDirty` | `userMessageBg` | text | 4.5:1 | `warning` |
| `status-untracked` | untracked git marker | `statusLineUntracked` | `userMessageBg` | text | 4.5:1 | `warning` |

Background-only roles are proven by the foreground rows that name them in the
Background role column; they do not require synthetic self-pairing rows.
`statusLineBg` is an intentionally unpainted compatibility/schema token:
`StatusLineComponent` deliberately uses `userMessageBg` instead
(`tool-status-header.ts:773-779`).

`tools-markdown.ts` produces unstyled Markdown source and is therefore not a
theme consumer. `settings-defs.ts` defines data and conditions but does not
paint a role. These exclusions are explicit, not omitted coverage.

The complete sentinel covers every sorted token from `THEME_COLOR_KEYS` and the
resolved `background` (`pageBg`), while the now-84-row table covers every actual
in-scope foreground/structural consumer. Tests must reject a missing, extra,
duplicate, unresolved, or undocumented consumer/pairing. Semantic colors
`accent`, `success`, `warning`, `error`,
and `toolDiffRemoved` must remain pairwise distinct. Theme JSON may be
changed only when a failing documented pairing proves the token is the
source defect; a shared resolver or dark-theme change requires architecture
review.

### States, non-color cues, and responsive behavior

The actual showcase covers default, selected/focused/active, disabled,
pending/loading, empty, success, warning, error, confirmation, expanded,
collapsed, permission failure, and connection failure. Hover is N/A for a
terminal. Loading is N/A for the settings/theme selectors themselves because
their asynchronous theme list resolves before mount; the production
`ToolExecutionComponent` supplies pending/loading evidence. Sticky content is
N/A for those selectors; their production behavior is `maxVisible` windowing.

Meaning must survive color removal: selection uses `❯` or `>` plus position
and active-tab text; pending/running names the operation; success, warning,
error, permission failure, and connection failure use symbols plus prose;
confirmation presents explicit action labels; disabled work names the reason;
expanded/collapsed states retain disclosure text; focus retains the cursor.
The six ASCII/no-color scenes are the required proof, not a waiver for other
states.

Canonical viewports are 80x24, 120x36, and 160x48. At 80 columns the selected
action, one-line status, and navigation hint remain simultaneously visible.
At all widths use ANSI-aware cell width and grapheme spans. JavaScript string
length is not a layout oracle. The linked `overflow-top`,
`overflow-middle`, and `overflow-bottom` scenes drive one production
`SettingsList`/`SelectList` corpus through its real `maxVisible` window.
For every theme and canonical viewport metadata records `item_count`,
`selected_index`, `window_start`, `window_end`, `visible_item_ids`,
`scroll_position`, `sticky_top_row_ids`, and `sticky_bottom_row_ids`. The
triplet proves first/interior/final boundaries and identical opening
frame/header and closing hint/border signatures; metadata-only assertions are
insufficient.

Korean, Japanese, Chinese, and mixed CJK/Latin content must preserve grapheme
clusters and semantic units. Phrase/action/status boundaries, masked-secret
markers, and short code/config identifiers may not split. Each language has
eight truecolor captures: two themes at 80x24, 120x36, 160x48, and 48x36.
Mixed CJK/Latin also has one 256-color 48x36 capture per theme. Any bad
semantic break blocks completion.

### Light showcase matrix and theme identity

The 24 Unicode baseline scene IDs are exactly:

`normal-default`, `selected-focus-active`, `disabled`, `pending-loading`,
`empty`, `success`, `warning`, `error`, `confirmation`, `expanded`,
`collapsed`, `permission-failure`, `connection-failure`, `diff`, `markdown`,
`syntax`, `status`, `overflow-top`, `overflow-middle`, `overflow-bottom`,
`wrap-korean`, `wrap-japanese`, `wrap-chinese`, and
`wrap-mixed-cjk-latin`.

Cross those scenes with two themes and three canonical viewports for 144
entries. Add `ascii-no-color` at 80x24 for `selected-focus-active`,
`pending-loading`, `warning`, `error`, `confirmation`, and `status` for each
theme (12). Add `unicode-color` at 48x36 for the four wrapping scenes for each
theme (8). Add the production-backed `consumer-atlas` scene at 80x128,
120x128, and 160x128 for each theme (6). Add `unicode-256-color` for
`selected-focus-active` at all three canonical widths (6), mixed CJK/Latin at
48x36 (2), and `consumer-atlas` at 120x128 (2). These ten captures exercise
real 256-color downsampling, retain non-color cues, and must satisfy the same
documented contrast thresholds after conversion. The exact total is **180
entries**. The key is `{theme}/{scene}/{viewport}/{render_mode}`.

Every entry contains exactly `terminal.txt`, `terminal-ansi.txt`,
`terminal.html`, `metadata.json`, and `terminal.png`, producing exactly
**900 hashed entry leaves**. Root `manifest.json`,
`capture-environment.json`, `review-input.json`, `run-receipt.json`, and the
later `independent-review.json` are control artifacts and are not included in
900.

Before rendering, the fixture requires
`requested_theme === resolved_theme === manifest_key_theme`. There is no
fallback. The normalized complete role map and its SHA-256 sentinel are
repeated in metadata, the HTML theme declaration, the SVG display list, PNG
sentinel samples, and the manifest. Unknown names, duplicate theme sentinel
hashes, or any requested/resolved/key/role/sentinel mismatch fail before a
complete entry is written.
Production evidence fixtures must inject every host-sensitive display input while still rendering the real production component. The status scene fixes its project directory and Git snapshot; the consumer atlas passes an explicit Darwin `KeyDisplayContext` to `WelcomeComponent`. Neither scene may derive retained text from the validator host's clone path, branch, worktree state, or `process.platform`. Regression coverage must render the canonical labels on non-Darwin replay hosts rather than weakening the production plain/ANSI byte comparison.

### PNG, fonts, and capture environment

The evidence helper parses ANSI once into a canonical cell grid. Plain text,
HTML, and a transient SVG are serializers of that grid. The SVG is
rasterized in-process by the exact direct development dependency
`@resvg/resvg-js@2.6.2`; it is not retained as a sixth artifact. Browser,
remote, platform screenshot, capture-only CSS layout, and a second terminal
renderer are forbidden.

Cell geometry is fixed to `cell_width_px = 10`, `cell_height_px = 20`,
`baseline_px = 15`, `horizontal_padding_px = 16` per side,
`vertical_padding_px = 16` per side, and `device_pixel_ratio = 1`. PNG
dimensions are `(columns * 10 + 32) × (rows * 20 + 32)`. Graphemes are placed
by cell coordinate and wcwidth span.

No font bytes are vendored. Canonical Darwin capture resolves, in order:

| Script | Requested/POST name | System path | Version | File SHA-256 |
| --- | --- | --- | --- | --- |
| Latin/terminal | Menlo Regular / `Menlo-Regular` | `/System/Library/Fonts/Menlo.ttc` | 132907 | `dc256e0b39c2a6fec947129d421fef41b8b429f58f9b6e5d1b148c87f775c1f6` |
| Korean | Apple SD Gothic Neo Regular / `AppleSDGothicNeo-Regular` | `/System/Library/Fonts/AppleSDGothicNeo.ttc` | 65536 | `e33989af92c53dd2b80efd88f50c404094a046658d0e7a7692619587570e616c` |
| Japanese | Hiragino Sans W3 / `HiraginoSans-W3` | `/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc` | 541327 | `833776a6fd68e2c71c0c52fd8041195bd3d0a336cdb278170b7ad71c7e1b3475` |
| Simplified Chinese | PingFang SC Regular / `PingFangSC-Regular` | `/System/Library/AssetsV2/com_apple_MobileAsset_Font8/86ba2c91f017a3749571a82f2c6d890ac7ffb2fb.asset/AssetData/PingFang.ttc` | 327680 | `9ff3ce9439fe285cdabb46f9ceb46b1ac58f1ca07e6f4a764e8286db621a0af9` |

Each font record includes requested/resolved family and PostScript name,
system path, version, file hash, covered script, and `source: system`. A
missing/substituted canonical face fails canonical capture. Documented local
fallbacks may produce non-canonical evidence but may not claim byte
determinism.

`capture-environment.json` records OS/version/build, architecture, exact Bun
version, lockfile hash, Resvg package/native hashes, helper/ANSI-parser/cell
width/SVG serializer versions, locale, `TZ=UTC`, font records, geometry, DPR,
and color profile. Its canonical-field SHA-256 is the environment ID. Two
clean captures may claim byte determinism only with identical source,
inputs, command, and environment ID; all deterministic leaves, PNG bytes,
and decoded RGBA hashes must match. Run time and elapsed time are isolated in
`run-receipt.json`; its output path is the canonical repository-relative
`.gjc/qa/gjc-light-theme-compliance/current`, never a host-absolute path.

Evidence validation also re-renders every canonical key from the current
production fixture and byte-compares both plain and ANSI terminal output.
A second `Bun.stripANSI` path verifies plain-text fidelity, and a separate
HTML envelope/entity extractor verifies that the retained `<pre>` text is
exactly the terminal text. These checks are additive to rebuilding the
canonical cell grid, HTML, and SVG display list; a self-consistent forged
serializer output cannot replace the current production render.

The validator decodes each retained PNG directly from its PNG bytes, validates
chunk CRC/order, requires bounded non-interlaced 8-bit RGBA, reverses every PNG
row filter, and recomputes dimensions, decoded RGBA SHA-256, non-uniformity,
and every sentinel sample independently of Resvg's capture-time pixel buffer.
A valid PNG envelope or capture-time metadata claim cannot substitute for
decoded pixel proof.

`manifest.json` schema version 2 records the exact sorted
path/hash/byte-length authority from `LIGHT_THEME_EVIDENCE_SOURCE_PATHS` plus
every regular file under `LIGHT_THEME_EVIDENCE_SOURCE_TREES`, along with their
aggregate source fingerprint and Git/worktree revision. The closure includes
this contract, both actual retained default palettes as well as the added
light palettes, theme/schema/settings policy, production renderer and
transitive TUI/native/width sources, dependency manifests and lockfiles,
fixtures, capture/validator/transport scripts and tests, and the Dev CI
workflow/planner. Symlinks, duplicate paths, missing trees, non-files, or an
exact-set/hash/revision mismatch fail closed. Evidence validation recomputes
the full closure from the current worktree; any authority change makes the
capture stale.

Across different environments, acceptance uses identical matrix, replayed
cell-grid hash, text, ANSI semantics, grapheme spans, role-per-cell and
occupancy maps, sticky/window metadata, valid PNG dimensions/RGBA, theme
sentinel samples, and human semantic review. PNG format/dimensions alone are
not evidence.

### Exact-head CI evidence transport

A completed corpus, including `independent-review.json`, is packaged without
vendoring it in the repository:

```sh
bun packages/coding-agent/scripts/ci-light-theme-evidence.ts archive \
  --source .gjc/qa/gjc-light-theme-compliance/current \
  --output .gjc/qa/gjc-light-theme-compliance/gjc-light-theme-compliance.tar.gz
```

The pull-request head repository publishes that file as the sole asset named
`gjc-light-theme-compliance.tar.gz` on release tag
`light-theme-evidence-<exact-40-hex-PR-head>`. Dev CI schedules the dedicated
`Light-theme exact-head evidence` job for every PR that changes any source
authority path or tree. It downloads only that head repository/tag/asset,
refuses unsafe/excess/missing archive paths, bounds both compressed and
extracted bytes against decompression bombs, requires exactly five root
controls plus 180 entry directories and 900 leaves, exports
`GJC_LIGHT_THEME_EVIDENCE` and `GJC_LIGHT_THEME_EVIDENCE_REQUIRED=1`, then
runs the exhaustive evidence test.
A missing asset, missing environment variable, stale source closure, invalid
leaf, or invalid independent review fails both the evidence job and the
protected affected aggregate. Push CI does not require a historical PR
release asset.

### Notifications byte-equivalence gate

The frozen pre-refactor baseline is
`.gjc/qa/gjc-light-theme-compliance/notifications-baseline`, manifest
SHA-256
`a6bcbad31ec45f68f37f8dd354a64f189c9764e77ee5f24a4fad73e27ec75acb`.
The canonical command remains the command above and remains default
red-claw. It must produce exactly 108 keys and 432 entry leaves, four files
per entry, with no PNG. Every paired entry byte and the manifest
key/file/SHA-256/byte-length map must match the baseline. State IDs, localized
copy, viewport/render-mode extras, fixture timestamp, and review-input counts
must match. Only external receipt revision/time/elapsed/output-path fields may
differ. There is no theme-aware or structural-diff exception.

### Independent review schema version 2

`independent-review.json` rejects unknown top-level fields except optional
string `notes`. It requires:

- literal `schema_version: 2`, `decision: "pass"`, and a UTC `reviewed_at`
  after capture and before any later source/output change;
- non-empty reviewer `id`, `role`, and `affiliation`;
- independence arrays for implementation and capture author IDs, false
  `reviewer_authored_implementation` and `reviewer_authored_capture`, a
  non-empty basis, and no reviewer ID in either author array;
- manifest schema version 2 non-empty, unique canonical implementation and
  capture author arrays, copied exactly into review input and the review
  independence block; omitted or empty arrays fail instead of vacuously
  proving independence;
- manifest relative path, lowercase SHA-256, source revision, environment ID,
  expected/observed entry counts 180, and expected/observed leaf counts 900;
- exactly 180 unique `reviewed_entry_keys`, set-equal to the manifest;
- passing plain, ANSI, HTML, metadata, PNG, and integrity format results;
- exact theme keys `red-claw-light` and `blue-crab-light`, 90 reviewed entries
  each, with passing requested/resolved/sentinel and contrast/cue results;
- exact language keys Korean, Japanese, Chinese, and mixed CJK/Latin: the
  first three list their exact eight truecolor keys, while mixed CJK/Latin
  also lists its two 256-color keys; all pass grapheme/semantic results;
- exact overflow top/middle/bottom sets of six canonical keys each;
- one `sticky_virtualized` result naming the production import and
  `maxVisible-windowed` mechanism, listing all 18 linked keys, with passing
  sticky-row, boundary, and metadata results;
- one `consumer_atlas` result listing the exact eight atlas keys, with passing
  production-component rendering, named-consumer coverage, and responsive-width
  results;
- the exact 12 no-color keys and a passing cue result;
- one `ansi_256_color` result listing the exact ten 256-color keys, with
  passing downsampling, contrast, and non-color-cue results;
- findings with stable ID, severity
  `blocker|high|medium|low|note`, entry keys, description, and disposition;
  pass requires no unresolved finding and `blocker_count: 0`; and
- a non-empty attestation that the reviewer recomputed integrity, inspected
  all 180 entries rather than sampling, checked this DESIGN contract and
  acceptance criteria, and authored neither implementation nor capture.

A missing/excess key, count-only claim, stale binding, reviewer overlap,
unresolved finding, or schema mismatch fails closed. Any later source,
deterministic leaf, manifest, environment, or review-input change invalidates
the receipt and requires full recapture and independent re-review.

### Decision record and provenance

Decision: keep the canonical Notifications evidence byte-stable and add a
dedicated production-renderer-backed light-theme fixture with a shared
ANSI-cell-grid evidence helper, exact local Resvg rasterization, the 180/900
matrix, and exhaustive independent review. Theme tests alone, repurposing
Notifications, browser screenshots, vendored fonts, cross-machine PNG byte
goldens, representative pairing samples, and sampled review are rejected.

Consequences: the coding-agent package owns one exact rasterizer development
dependency; generated evidence stays under `.gjc/qa` and is not committed;
canonical Darwin captures depend on the recorded installed fonts; theme or
consumer fixes require a failing inventory row; and every post-review change
forces recapture/re-review. No third-party corpus, screenshot, font, brand
guide, prompt pack, or raw reference asset is copied into source control.
