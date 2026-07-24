# Keybindings

Run `/hotkeys` inside an `gjc` session to see the active chords for your current build. The list reflects any remaps loaded from disk and any bindings added by extensions.

## Customize keybindings

User remaps live in `~/.gjc/agent/keybindings.json`. The file is a JSON object whose keys are keybinding action IDs and whose values are either one chord string or an array of chord strings. It is not read from `~/.gjc/agent/config.yml`, and there is no nested `keybindings` object.

```json
{
  "app.commandPalette.open": "ctrl+p",
  "app.model.cycleForward": "alt+n",
  "app.model.selectTemporary": "alt+p",
  "app.plan.toggle": "alt+shift+p"
}
```

Chord names are case-insensitive. New configuration should use canonical textual IDs rather than matching the labels shown in the UI.
Configuration uses portable canonical key IDs, not the labels printed by a particular host: use `ctrl`, `alt`, `shift`, and `super` with a key name, for example `ctrl+p`, `alt+enter`, `shift+tab`, and `super+c`. Matching is case-insensitive, but new configuration should use this canonical textual form so the same file remains portable.

Runtime UI labels are platform-native. On macOS, `Ctrl`, `Alt`, `Shift`, and `Super` display as `⌃`, `⌥`, `⇧`, and `⌘`; MacBook keycaps such as Return, Escape, Tab, Delete, and the arrow keys display as `↩`, `⎋`, `⇥`, `⌫`/`⌦`, and arrows. These glyphs are display labels only: configure `super+c`, not `⌘C`, and `alt+enter`, not `⌥↩`.
Static onboarding and generated reference material describe shipped defaults and must stay host-independent. The active runtime surface is authoritative for effective bindings after user remaps and extensions load: use `/hotkeys` to see those bindings on the current platform.

Set an action to an empty array to disable it:

```json
{
  "app.stt.toggle": []
}
```

## Common action IDs

| Action ID | Default | Meaning |
| --- | --- | --- |
| `app.commandPalette.open` | `ctrl+p` | Open the command palette |
| `app.model.cycleForward` | `alt+n` | Cycle role models forward |
| `app.model.cycleBackward` | `alt+shift+n` | Cycle role models backward |
| `app.model.selectTemporary` | `alt+p` | Pick a model temporarily for this session |
| `app.model.select` | `ctrl+l` | Open the model selector and set roles |
| `app.plan.toggle` | `alt+shift+p` | Toggle plan mode |
| `app.history.search` | `ctrl+r` | Search prompt history |
| `app.tools.expand` | `ctrl+o` | Toggle tool-output expansion |
| `app.thinking.toggle` | `ctrl+t` | Toggle thinking-block visibility |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.editor.external` | `ctrl+g` | Edit the draft in `$VISUAL` / `$EDITOR` |
| `app.message.followUp` | _(none)_ | Optional remap for a follow-up message; `ctrl+enter` is reserved for editor newline |
| `app.message.queue` | `alt+enter` (`alt+q` on darwin/win32) | Explicitly queue a message for the next turn |
| `app.message.dequeue` | `alt+up` | Dequeue a queued message back into the editor |

| `app.clipboard.copyLine` | `alt+shift+l` | Copy the current line |
| `app.clipboard.copyPrompt` | `alt+shift+c` | Copy the whole prompt |
| `app.stt.toggle` | `alt+h` | Toggle speech-to-text recording |
| `app.irc.sidebar.toggle` | `alt+i` | Toggle IRC sidebar |

Older unqualified action names are migrated when `keybindings.json` is loaded, but new docs and new configs should use the namespaced action IDs above.

On macOS and native Windows terminals, GJC defaults `app.message.queue` to `Alt+Q`; Windows Terminal and PowerShell commonly reserve `Alt+Enter` for fullscreen before GJC can receive it. Users who prefer another chord can remap `app.message.queue` in `~/.gjc/agent/keybindings.json`.

In the main GJC composer, plain `PageUp` / `PageDown` page the visible transcript viewport instead of browsing prompt history; use `Up` / `Down` or `Ctrl+R` for prompt history. Autocomplete and selector surfaces still use `PageUp` / `PageDown` for list paging while they have focus.

## Auditing default-key collisions

Some default chords are intentionally reused across different UI contexts, where the focused component disambiguates them at dispatch time. For example `Enter` maps to both input submit and selection confirm, and `Ctrl+C` maps to both input copy and selection cancel. These are not conflicts — only one context is active at a time.

To audit the registry for keys whose default binding is claimed by more than one action, use `detectDefaultKeyCollisions(definitions)` from `@gajae-code/tui/keybindings`. It returns one entry per colliding key with the list of claiming action IDs, which is useful when adding new defaults or reviewing the surface. User-remap conflicts (multiple actions bound to the same chord in `keybindings.json`) continue to be reported separately by `KeybindingsManager.getConflicts()`.

Two audit clarifications for the current surface:

- `app.clipboard.copyLine` is registry-backed and dispatched through the input controller's custom key handlers, not hardcoded.
- `tui.input.copy` is declared in the registry but is not currently dispatched by `Editor.handleInput`.

The editor's configurable action defaults (including the platform-aware `app.clipboard.pasteImage` default) are derived directly from the central `KEYBINDINGS` registry, so there is a single source of truth for those defaults.

## Current surface audit

Authoritative inventory of the keybinding registry, one row per action. Generated from `TUI_KEYBINDINGS` (`packages/tui/src/keybindings.ts`) and `KEYBINDINGS` (`packages/coding-agent/src/config/keybindings.ts`). Every action ID below is remappable via `~/.gjc/agent/keybindings.json` unless noted. A drift test (`packages/coding-agent/test/keybindings-audit.test.ts`) asserts every registry action ID appears in this table.

### Editor context (`tui.editor.*`)

| Action ID | Default | Notes |
| --- | --- | --- |
| `tui.editor.cursorUp` | `up` | |
| `tui.editor.cursorDown` | `down` | |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | `ctrl+b` also `app.tool.backgroundFold` (other context) |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | `ctrl+left` also `app.tree.foldOrUp` |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | `ctrl+right` also `app.tree.unfoldOrDown` |
| `tui.editor.cursorLineStart` | `home`, `ctrl+a` | |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+e` | |
| `tui.editor.jumpForward` | `ctrl+]` | |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | |
| `tui.editor.pageUp` | `pageUp` | |
| `tui.editor.pageDown` | `pageDown` | |
| `tui.editor.deleteCharBackward` | `backspace` | |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | `ctrl+d` also `app.exit` / `app.session.delete` |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace`, `ctrl+backspace` | |
| `tui.editor.deleteWordForward` | `alt+delete`, `alt+d` | |
| `tui.editor.deleteToLineStart` | `ctrl+u` | |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | |
| `tui.editor.yank` | `ctrl+y` | |
| `tui.editor.yankPop` | `alt+y` | |
| `tui.editor.undo` | `ctrl+-`, `ctrl+_` | |

### Input context (`tui.input.*`)

| Action ID | Default | Notes |
| --- | --- | --- |
| `tui.input.newLine` | `Shift+Enter` | `Ctrl+Enter` and `Ctrl+Shift+Enter` are also accepted by the editor when the terminal encodes them distinctly |

| `tui.input.submit` | `enter` | also `tui.select.confirm` (other context) |
| `tui.input.tab` | `tab` | |
| `tui.input.copy` | `ctrl+c` | declared but not dispatched by `Editor.handleInput` |

### Selection context (`tui.select.*`)

| Action ID | Default | Notes |
| --- | --- | --- |
| `tui.select.up` | `up` | |
| `tui.select.down` | `down` | |
| `tui.select.pageUp` | `pageUp` | |
| `tui.select.pageDown` | `pageDown` | |
| `tui.select.confirm` | `enter` | |
| `tui.select.cancel` | `escape`, `ctrl+c` | `escape` also `app.interrupt` |

### Application context (`app.*`)

| Action ID | Default | Domains |
| --- | --- | --- |
| `app.interrupt` | escape | global |
| `app.clear` | ctrl+c | global |
| `app.exit` | ctrl+d | global |
| `app.suspend` | ctrl+z | global |
| `app.thinking.cycle` | shift+tab | composer |
| `app.thinking.toggle` | ctrl+t | composer |
| `app.commandPalette.open` | ctrl+p | composer |
| `app.model.cycleForward` | alt+n | composer |
| `app.model.cycleBackward` | alt+shift+n | composer |
| `app.model.select` | ctrl+l | composer |
| `app.model.selectTemporary` | alt+p | composer |
| `app.tools.expand` | ctrl+o | composer |
| `app.tool.backgroundFold` | ctrl+b | composer |
| `app.editor.external` | ctrl+g | composer |
| `app.message.followUp` | _(none)_ | composer |
| `app.message.queue` | alt+q (darwin/win32) / alt+enter (linux) | composer |
| `app.message.dequeue` | alt+up, alt+down | composer |
| `app.clipboard.pasteImage` | ctrl+v (darwin/linux) / alt+v (win32) | composer |
| `app.clipboard.copyLine` | alt+shift+l | composer |
| `app.clipboard.copyPrompt` | alt+shift+c | composer |
| `app.session.new` | ctrl+n | composer |
| `app.session.tree` | _(none)_ | composer |
| `app.session.fork` | _(none)_ | composer |
| `app.session.resume` | _(none)_ | composer |
| `app.session.observe` | ctrl+s | composer |
| `app.session.dashboard` | _(none)_ | composer |
| `app.jobs.open` | alt+j | composer |
| `app.session.togglePath` | ctrl+p | selector |
| `app.session.toggleSort` | ctrl+s | selector |
| `app.session.rename` | ctrl+r | selector |
| `app.session.delete` | ctrl+d | selector |
| `app.session.deleteNoninvasive` | ctrl+backspace | selector |
| `app.tree.foldOrUp` | ctrl+left, alt+left | selector |
| `app.tree.unfoldOrDown` | ctrl+right, alt+right | selector |
| `app.plan.toggle` | alt+shift+p | composer |
| `app.history.search` | ctrl+r | composer |
| `app.stt.toggle` | alt+h | composer |
| `app.irc.sidebar.toggle` | alt+i | composer |
| `app.transcript.browse` | _(none)_ | composer |
| `app.transcript.prevTurn` | _(none)_ | composer |
| `app.transcript.nextTurn` | _(none)_ | composer |
| `app.mode.cycle` | _(none)_ | composer |
| `app.tasks.toggle` | alt+t | composer |
| `app.queue.togglePane` | _(none)_ | composer |
| `app.message.sendNow` | _(none)_ | composer |

### Global engine context (`tui.global.*`)

| Action ID | Default | Notes |
| --- | --- | --- |
| `tui.global.debug` | `shift+ctrl+d` | Toggle debug overlay; resolved through the registry in `tui.ts` |

Cross-context default reuse (`ctrl+s`, `ctrl+r`, `ctrl+d`, `ctrl+b`, `ctrl+left`/`ctrl+right`, `enter`, `escape`, `ctrl+c`) is intentional: each pair is active in a different focused context and is disambiguated at dispatch time. Use `detectDefaultKeyCollisions()` (above) to re-derive this list from the registry.

### Not yet registry-managed

A few contexts still match chords directly instead of resolving through the registry, and are tracked for a later phase:

- Tree selector (`tree-selector.ts`): up/down/left/right/enter, `ctrl+c`, filter cycling (`ctrl+o` / `ctrl+shift+o`), filter modes (`alt+d/t/u/l/a`), label edit (`shift+l`).
- Parts of the model selector.
