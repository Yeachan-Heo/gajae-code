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
Configuration uses portable canonical key IDs, not the labels printed by a particular host: use `ctrl`, `alt`, `shift`, and `super` with a key name, for example `ctrl+p`, `alt+enter`, `shift+tab`, and `super+c`. macOS aliases `option`/`meta` normalize to `alt`, and `command`/`cmd` normalize to `super`; canonical names are recommended for portable files.

Runtime UI labels are platform-native. On macOS, `Ctrl`, `Alt`, `Shift`, and `Super` display as `⌃`, `⌥`, `⇧`, and `⌘`; MacBook keycaps such as Return, Escape, Tab, Delete, and the arrow keys display as `↩`, `⎋`, `⇥`, `⌫`/`⌦`, and arrows. These glyphs are display labels only: configure `super+c`, not `⌘C`, and `alt+enter`, not `⌥↩`.
On macOS, both left and right Option keys use the same terminal Meta/Esc path. Option shortcuts therefore require the terminal profile to forward Option as Meta/Esc or to use an enhanced keyboard protocol. In Apple Terminal, enable **Settings > Profiles > Keyboard > Use Option as Meta key** for the profile used by GJC; this setting covers both physical Option keys. In Ghostty, set `macos-option-as-alt = true` in `~/.config/ghostty/config`, then reload its configuration or restart it. The parser also accepts legacy Meta-wrapped arrows, paging, function keys, and other escape sequences.
Apple Terminal reserves most Command shortcuts for its own menus, so those key events never enter the PTY and cannot be recovered by GJC. `super+...` bindings work when the terminal sends a Super modifier through Kitty/modifyOtherKeys or an explicit profile key mapping; map the desired Command chord under **Profiles > Keyboard > Key list** when using Terminal.app. Text produced by an Option key as composed Unicode cannot be reverse-inferred as an Option chord.
For example, to bind Command+P, set the GJC action to `super+p` (or `command+p`, which is normalized), then add a Terminal.app profile mapping for Command+P that sends Kitty `CSI 112;9u` (`Send Escape Sequence` value `[112;9u`, or the equivalent hex bytes including the leading `ESC`). The mapping is required because no PTY application can recover a Command event that Terminal.app consumed.
For terminals that do not forward Option, remap the queue actions to canonical Control chords (choose unclaimed chords appropriate for your terminal), for example:

```json
{
  "app.message.queue": "ctrl+q",
  "app.message.dequeue": ["ctrl+pageup", "ctrl+pagedown"]
}
```
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
| `app.message.dequeue` | `alt+up`, `alt+down` | Open the queue and select a queued message to edit |

| `app.clipboard.copyLine` | `alt+shift+l` | Copy the current line |
| `app.clipboard.pasteText` | _(none)_ | Paste text from configured clipboard transport (`clipboard.transport: ssh`); command palette only |
| `app.clipboard.copyPrompt` | `alt+shift+c` | Copy the whole prompt |
| `app.stt.toggle` | `alt+h` | Toggle speech-to-text recording |
| `app.irc.sidebar.toggle` | `alt+i` | Toggle IRC sidebar |

For setup, microphone permissions, first-use behavior, and troubleshooting, see [Speech-to-text](./speech-to-text.md).

Older unqualified action names are migrated when `keybindings.json` is loaded, but new docs and new configs should use the namespaced action IDs above.

On macOS, Option+Q queues a message for the next turn when the active terminal profile forwards Option as Meta/Esc; in Apple Terminal, this is controlled by **Use Option as Meta key** and applies to both left and right Option keys. On native Windows terminals, the equivalent default is Alt+Q. Windows Terminal and PowerShell commonly reserve Alt+Enter for fullscreen before GJC can receive it. Users who prefer another chord can remap `app.message.queue` in `~/.gjc/agent/keybindings.json`.

When messages are queued, use Option+Up/Down on macOS (Alt+Up/Down on Windows) to open the queue and select a message. In the queue, Return edits the selected message, Forward Delete (`⌦`; Fn+Delete on compact Mac keyboards) removes it, Control+Up/Down reorders it within its delivery group, and Escape closes the queue. Reordering does not convert compaction, steer, and follow-up messages into one another.

In the main GJC composer, plain `PageUp` / `PageDown` page the visible transcript lane instead of browsing prompt history; the status line and composer remain fixed at the bottom while manually scrolled. When GJC owns mouse input (`mouse.enabled: true`), the wheel moves the transcript by three rows per notch. Ordinary typing or paste keeps editor focus and returns to live output before editing; use `Up` / `Down` or `Ctrl+R` for prompt history. Autocomplete and selector surfaces still use `PageUp` / `PageDown` for list paging while they have focus.

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
| `app.tool.backgroundFold` | alt+shift+b, super+b | composer |
| `app.editor.external` | ctrl+g | composer |
| `app.message.followUp` | _(none)_ | composer |
| `app.message.queue` | alt+q (darwin/win32) / alt+enter (linux) | composer |
| `app.message.dequeue` | alt+up, alt+down | composer |
| `app.clipboard.pasteImage` | ctrl+v, super+v (darwin) / ctrl+v, alt+v (win32) / ctrl+v (linux) | composer |
| `app.clipboard.pasteText` | _(none)_ | composer |
| `app.clipboard.copyLine` | alt+shift+l | composer |
| `app.clipboard.copyPrompt` | alt+shift+c | composer |
| `app.clipboard.copyOAuthUrl` | alt+shift+u | composer |
| `app.session.new` | ctrl+n | composer |
| `app.session.tree` | alt+shift+s | composer |
| `app.session.fork` | alt+shift+f | composer |
| `app.session.resume` | alt+shift+r | composer |
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
| `app.todo.toggle` | alt+shift+t | composer |
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
- Composer editor (`editor.ts`): the kill-ring, word-delete and line-kill actions (`tui.editor.deleteToLineEnd`, `tui.editor.deleteToLineStart`, `tui.editor.deleteWordBackward`, `tui.editor.deleteWordForward`, `tui.editor.yank`, `tui.editor.yankPop`) now resolve through the registry and are fully remappable. Two exceptions remain: `tui.editor.cursorLineStart` and `tui.editor.cursorLineEnd` are matched by literal `ctrl+a` / `ctrl+e` branches placed ahead of their registry branches, so remapping those two actions elsewhere does **not** free `ctrl+a` / `ctrl+e` inside the composer. The `alt+enter` / `ctrl+j` / `ctrl+enter` submit and newline chords are likewise still literal.
