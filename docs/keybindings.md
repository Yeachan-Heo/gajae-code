# Keybindings

Run `/hotkeys` inside an `gjc` session to see the active chords for your current build. The list reflects any remaps loaded from disk and any bindings added by extensions.

## Customize keybindings

User remaps live in `~/.gjc/agent/keybindings.json`. The file is a JSON object whose keys are keybinding action IDs and whose values are either one chord string or an array of chord strings. It is not read from `~/.gjc/agent/config.yml`, and there is no nested `keybindings` object.

```json
{
  "app.model.cycleForward": "Ctrl+P",
  "app.model.selectTemporary": "Alt+P",
  "app.plan.toggle": "Alt+Shift+P"
}
```

Chord names are case-insensitive and use the same notation shown in the UI, such as `Ctrl+P`, `Alt+Shift+P`, `Shift+Enter`, and `Ctrl+Backspace`.

Set an action to an empty array to disable it:

```json
{
  "app.stt.toggle": []
}
```

## Common action IDs

| Action ID | Default | Meaning |
| --- | --- | --- |
| `app.model.cycleForward` | `Ctrl+P` | Cycle role models forward |
| `app.model.cycleBackward` | `Shift+Ctrl+P` | Cycle role models backward |
| `app.model.selectTemporary` | `Alt+P` | Pick a model temporarily for this session |
| `app.model.select` | `Ctrl+L` | Open the model selector and set roles |
| `app.plan.toggle` | `Alt+Shift+P` | Toggle plan mode |
| `app.history.search` | `Ctrl+R` | Search prompt history |
| `app.tools.expand` | `Ctrl+O` | Toggle tool-output expansion |
| `app.thinking.toggle` | `Ctrl+T` | Toggle thinking-block visibility |
| `app.thinking.cycle` | `Shift+Tab` | Cycle thinking level |
| `app.editor.external` | `Ctrl+G` | Edit the draft in `$VISUAL` / `$EDITOR` |
| `app.message.followUp` | _(none)_ | Optional remap for a follow-up message; `Ctrl+Enter` is reserved for editor newline |
| `app.message.queue` | `Alt+Enter` | Explicitly queue a message for the next turn |
| `app.message.dequeue` | `Alt+Up` | Dequeue a queued message back into the editor |

| `app.clipboard.copyLine` | `Alt+Shift+L` | Copy the current line |
| `app.clipboard.copyPrompt` | `Alt+Shift+C` | Copy the whole prompt |
| `app.stt.toggle` | `Alt+H` | Toggle speech-to-text recording |

Older unqualified action names are migrated when `keybindings.json` is loaded, but new docs and new configs should use the namespaced action IDs above.

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

| Action ID | Default | Notes |
| --- | --- | --- |
| `app.interrupt` | `escape` | |
| `app.clear` | `ctrl+c` | |
| `app.exit` | `ctrl+d` | |
| `app.suspend` | `ctrl+z` | |
| `app.thinking.cycle` | `shift+tab` | |
| `app.thinking.toggle` | `ctrl+t` | |
| `app.model.cycleForward` | `ctrl+p` | also `app.session.togglePath` (session list) |
| `app.model.cycleBackward` | `shift+ctrl+p` | |
| `app.model.select` | `ctrl+l` | |
| `app.model.selectTemporary` | `alt+p` | |
| `app.tools.expand` | `ctrl+o` | |
| `app.tool.backgroundFold` | `ctrl+b` | |
| `app.editor.external` | `ctrl+g` | |
| `app.message.followUp` | _(none)_ | `Ctrl+Enter` remains newline unless the user explicitly remaps this action; while idle the chord still falls through to newline |
| `app.message.queue` | `alt+enter` | |
| `app.message.dequeue` | `alt+up` | |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on win32) | platform-aware; single source of truth in `KEYBINDINGS` |
| `app.clipboard.copyLine` | `alt+shift+l` | registry-backed via input-controller custom handler |
| `app.clipboard.copyPrompt` | `alt+shift+c` | |
| `app.session.new` | _(none)_ | command-driven; empty default |
| `app.session.tree` | _(none)_ | command-driven; empty default |
| `app.session.fork` | _(none)_ | command-driven; empty default |
| `app.session.resume` | _(none)_ | command-driven; empty default |
| `app.session.observe` | `ctrl+s` | also `app.session.toggleSort` (session list) |
| `app.jobs.open` | `alt+j` | |
| `app.session.togglePath` | `ctrl+p` | session-list context |
| `app.session.toggleSort` | `ctrl+s` | session-list context |
| `app.session.rename` | `ctrl+r` | also `app.history.search` |
| `app.session.delete` | `ctrl+d` | session-list context |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | |
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | |
| `app.plan.toggle` | `alt+shift+p` | |
| `app.history.search` | `ctrl+r` | |
| `app.stt.toggle` | `alt+h` | |

### Global engine context (`tui.global.*`)

| Action ID | Default | Notes |
| --- | --- | --- |
| `tui.global.debug` | `shift+ctrl+d` | Toggle debug overlay; resolved through the registry in `tui.ts` |

Cross-context default reuse (`ctrl+p`, `ctrl+s`, `ctrl+r`, `ctrl+d`, `ctrl+b`, `ctrl+left`/`ctrl+right`, `enter`, `escape`, `ctrl+c`) is intentional: each pair is active in a different focused context and is disambiguated at dispatch time. Use `detectDefaultKeyCollisions()` (above) to re-derive this list from the registry.

### Not yet registry-managed

A few contexts still match chords directly instead of resolving through the registry, and are tracked for a later phase:

- Tree selector (`tree-selector.ts`): up/down/left/right/enter, `ctrl+c`, filter cycling (`ctrl+o` / `ctrl+shift+o`), filter modes (`alt+d/t/u/l/a`), label edit (`shift+l`).
- Parts of the model selector.
