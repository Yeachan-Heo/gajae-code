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
item description, and ends with a dim keyboard hint. Printable text starts a
case-insensitive label search shown above the list; Backspace removes one
grapheme, and Escape clears a non-empty search before a later Escape cancels
the list. Hosts that need stable height reserve fixed description rows; the
status-line custom editor reserves two.

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
  action. Printable text filters settings by label. Escape first clears an
  active filter, then follows the current component's cancel path before the
  parent is allowed to close.
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
| `home-unconfigured` | No complete notification provider. |
| `home-configured-inactive` | Provider configuration and desired intent exist; current session is inactive. |
| `home-runtime-active` | Current session endpoint is active. |
| `home-local-off` | Current session is explicitly locally disabled. |
| `home-env-off` | Process-level environment hard-off suppresses the surface/runtime. |
| `home-env-on` | Explicit environment opt-in enables automatic current-session admission. |
| `home-discord-only` | Discord is complete, desired on, and effective without Telegram. |
| `home-slack-only` | Slack is complete, desired on, and effective without Telegram. |
| `setup-provider` | First-class Telegram, Discord, and Slack provider choice is focused. |
| `setup-chat-entry` | Telegram chat ID field is focused. |
| `setup-token-entry` | Masked Telegram token field is focused. |
| `setup-validating` | Token/destination validation is pending. |
| `setup-threaded-warning` | Threaded mode compatibility warning is visible. |
| `setup-pairing` | Cancellable private-chat pairing/discovery is pending. |
| `setup-review` | Sanitized provider, secret action, desired intent, and destination await explicit save. |
| `saving` | Durable atomic save is in progress and guarded. |
| `health-probing` | Non-cancellable health probe is in progress and guarded. |
| `health-ok` | Health report is successful. |
| `health-warning` | Health report contains a recoverable warning. |
| `no-health-load` | Health data is unavailable and reload guidance is visible. |
| `testing` | Notification delivery test is in progress and guarded. |
| `recovering` | Recovery action is in progress and guarded. |
| `reconnecting` | Reconnect action is in progress and guarded. |
| `navigation-locked` | A guarded operation explains why Tab/Escape cannot leave. |
| `confirmation-remove` | Adapter-local Telegram removal awaits confirmation; sibling/global state is preserved. |
| `confirmation-disable` | Global disable awaits confirmation and preserves provider credentials/intent. |
| `success` | A completed operation has concise success copy. |
| `preferences` | Notification preferences are visible and editable. |
| `error` | A sanitized operation failure has recovery guidance. |
| `foreign-blocked` | Telegram is excluded from the shared endpoint while effective chat siblings use isolated discovery. |
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

### Status Line Custom Editor simulation

The Appearance tab's Status Line Custom Editor is a spatial editor, not a
generic setting row list. It renders a simulated statusbar with left/right
segment areas, a hidden-segment palette, visible Separator and segment-option
controls, and Confirm/Exit actions. It must not render legacy `Segment`,
`Move left`, or `Move right` rows.

The editor owns transient state locally: focused statusbar slot, focused palette
item, focused root control, open visible-choice panel, picked segment, floating
ghost, empty origin slot, and overflow warning. Durable settings remain only the
existing `statusLine.leftSegments`, `statusLine.rightSegments`,
`statusLine.separator`, and `statusLine.segmentOptions` keys; Confirm persists
through the existing settings guard, while Exit or root-state Escape restores
the previous preview and closes.

Focus variants are `statusbar`, `palette`, `separator-control`,
`option-control(path)`, `choice(target, focusedValue, returnFocus)`, `confirm`,
and `exit`. Left/Right is owned by the editor while active and never switches
settings tabs. Enter selects/deselects, picks/drops, applies a focused choice,
or activates Confirm/Exit according to focus. Up/Down traverses palette,
visible root controls, actions, and choice candidates. Escape inside `choice`
returns to the opener without mutation; Escape everywhere else cancels and
restores. Delete only hides a focused visible statusbar segment.

Separator and every segment option are visible-choice controls, never cycle-only
rows. Descriptor data owns labels, allowed values, visible current-value
formatting, and typed draft application. Separator choices are Powerline, Thin
chevron, Slash, Pipe, Block, None, and ASCII. Boolean options show `true` and
`false`; enum options show their union values; `path.maxLength` shows `16`,
`24`, `32`, `40`, `50`, `60`, and `80`.

At constrained width the simulated statusbar renders as two rows and emits an
explicit overflow/wrap warning. ANSI-aware cell measurement remains mandatory;
ASCII/no-color output must retain textual focus, ghost/origin, selected choice,
and warning affordances.

Deterministic evidence belongs to
`test/fixtures/tui/status-line-custom-editor-showcase.ts`, captured by
`scripts/capture-status-line-custom-editor-showcase.ts --out
.gjc/qa/status-line-custom-editor-<run>` and verified by
`scripts/verify-status-line-custom-editor-showcase.ts --root
.gjc/qa/status-line-custom-editor-<run> --require-independent-review`. The
canonical states are `root-statusbar`, `picked-origin-slot`,
`palette-exact-insert`, `separator-control`, `separator-choice-focused`,
`separator-choice-applied`, `option-boolean-choice-focused`,
`option-enum-choice-focused`, `option-numeric-choice-focused`,
`option-choice-applied`, `exit-restored`, `confirm-persisted`,
`overflow-two-row-warning`, and `narrow-cjk`. Each state records
`terminal.txt`, `terminal-ansi.txt`, `terminal.html`, and `metadata.json`, plus
the root manifest. Missing state witnesses, ANSI/plain mismatch, invalid
metadata, and absent independent review are blocking visual-QA failures.

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
