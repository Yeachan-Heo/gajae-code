# Stream Deck integration guide with cmux

This guide captures a production-style Elgato Stream Deck control surface for Gajae-Code (`gjc`) running inside [cmux](https://github.com/manaflow-ai/cmux). It is formatted as an installable AI skill template so an operator or coding agent can reproduce, audit, repair, or extend the integration without relying on undocumented UI automation.

The installable skill body starts at the first frontmatter marker. To install it as a user skill:

```sh
mkdir -p ~/.gjc/agent/skills/streamdeck-cmux
sed -n '/^---$/,$p' docs/streamdeck-integration-guide-with-cmux.md \
  > ~/.gjc/agent/skills/streamdeck-cmux/SKILL.md

gjc config set skills.enabled true
gjc config set skills.enablePiUser true
```

Start a new GJC session and invoke `/skill:streamdeck-cmux`.

---
name: streamdeck-cmux
description: Configure, operate, verify, or repair an Elgato Stream Deck integration for Gajae-Code sessions hosted in cmux.
argument-hint: "[install|audit|repair|extend]"
level: 2
---

# Gajae-Code Stream Deck + cmux operator skill

## Purpose

Build a Stream Deck control surface that treats cmux as the terminal host, GJC as the interactive coding runtime, and the GJC SDK as the authoritative machine interface for pending questions.

The control surface should:

- navigate cmux panes and surface tabs;
- open fixed project and home-directory terminal tabs;
- create worktree-scoped GJC sessions;
- change the model profile of the focused GJC session;
- invoke common GJC skills without submitting them prematurely;
- send precise keyboard controls such as `Shift+Tab`, `Esc`, and `Enter`;
- render and answer the focused session's SDK questions;
- open and close native cmux terminal surfaces;
- reuse existing Chrome or Safari tabs for ordinary web shortcuts;
- use distinct, readable mascot artwork for each operation;
- preserve the operator's original Stream Deck profile and unrelated repository work.

## Do not use when

- cmux is not the terminal host;
- the Stream Deck application or hardware is unavailable;
- the target GJC session has SDK hosting disabled with `GJC_SDK_DISABLE=1` and SDK question answering is required;
- the requested action would overwrite a shared checkout containing unrelated work;
- the operator expects generic UI automation instead of deterministic cmux and SDK commands.

## Safety invariants

1. Back up the full Stream Deck profile before every structural layout change.
2. Preserve the original/default profile instead of reconstructing it manually.
3. Never log or commit SDK tokens, provider API keys, browser credentials, or endpoint discovery files.
4. Resolve the focused cmux surface with `cmux identify --no-caller`; do not infer focus only from tree decorations.
5. Send GJC-only controls only when the focused surface title starts with `GJC:`.
6. Use `action_needed.id` as the only authority for a generic SDK question reply.
7. Do not answer stale, resolved, hidden, non-focused, free-text, or unsupported controlled questions from fixed answer keys.
8. Send `Shift+Tab` as one atomic key event. Do not emulate it with separately delivered `Esc`-prefixed text.
9. Do not create duplicate browser tabs when an existing Chrome or Safari tab matches.
10. Reuse a focused non-GJC terminal when the operator explicitly wants an in-place worktree launch.
11. Keep Stream Deck profiles, local plugin installations, generated artwork, and SDK state outside version control. Repository-local `.gjc/state/` is gitignored and is the authoritative SDK discovery location; do not move, delete, or copy it elsewhere.

## Reference environment

The implementation described here was validated with:

- Elgato Stream Deck application `7.5.1`;
- Stream Deck device model `20GBA9901`;
- Gajae-Code `0.12.21`;
- cmux installed at `/Applications/cmux.app`;
- cmux CLI at `/Applications/cmux.app/Contents/Resources/bin/cmux`;
- GJC installed at `~/.local/bin/gjc`;
- official mascot source at `assets/character.png`.

Treat versions and absolute paths as environment inputs, not permanent product constants.

## Architecture

```text
Stream Deck hardware
  -> Elgato Stream Deck application
     -> native Stream Deck plugin
        -> cmux CLI / socket RPC
        -> GJC SDK WebSocket endpoints
        -> local launch helpers
        -> generated key images
```

Use a native Stream Deck plugin instead of a collection of shell-command actions. The plugin provides dynamic titles, per-key settings, hold/tap handling, SDK subscriptions, focused-session guards, question-state rendering, deterministic cmux routing, and success/error feedback.

A representative local installation is:

```text
~/.local/share/gjc-streamdeck-plugin/
  manifest.json
  plugin.js
  bin/plugin
  images/*.png

~/Library/Application Support/com.elgato.StreamDeck/Plugins/
  dev.gajae.streamdeck.sdPlugin/
    manifest.json
    plugin.js
    bin/plugin
    images/*.png
```

Keep one editable source copy and synchronize it to the installed plugin directory. Verify deployment with `cmp` before restarting Stream Deck.

## Preserve and separate profiles

Maintain separate profiles for separate concerns:

- `Default Profile`: the restored original profile;
- `Daily Control`: browser, cmux, and active-session controls;
- an optional session inventory profile when dedicated session slots are useful.

Before changing a profile:

```sh
stamp="$(date +%Y%m%d-%H%M%S)"
base="$HOME/Library/Application Support/com.elgato.StreamDeck"
mkdir -p "$base/ManualBackups"
ditto -c -k --sequesterRsrc --keepParent \
  "$base/ProfilesV3/<profile>.sdProfile" \
  "$base/ManualBackups/streamdeck-before-change-$stamp.zip"
```

Restore from a known backup instead of reverse-engineering a damaged default profile.

### Freeze and rollback the working integration

Before adding gesture mappings or changing page structure, freeze the exact installed plugin and affected page profile together with the source commit:

```sh
stamp="$(date +%Y%m%d-%H%M%S)"
base="$HOME/Library/Application Support/com.elgato.StreamDeck"
tmp="$(mktemp -d)"
mkdir -p "$tmp/frozen" "$base/ManualBackups"

ditto "$base/Plugins/dev.gajae.streamdeck.sdPlugin" \
  "$tmp/frozen/plugin"
ditto "$base/ProfilesV3/<profile>.sdProfile/Profiles/<page-3>" \
  "$tmp/frozen/page-3"
git rev-parse HEAD > "$tmp/frozen/commit.txt"
git status --short --branch > "$tmp/frozen/git-status.txt"

ditto -c -k --sequesterRsrc --keepParent "$tmp/frozen" \
  "$base/ManualBackups/gjc-before-change-$stamp.zip"
rm -rf "$tmp"
```

The gesture-control rollout used this frozen rollback archive:

```text
~/Library/Application Support/com.elgato.StreamDeck/ManualBackups/
gjc-before-gesture-controls-20260813-144957.zip
```

It contains the pre-gesture plugin, page-three profile, source commit `1423f2a435`, and repository status. Restore the archived plugin and page directory, preserve executable bits on `bin/plugin` and `bin/worktree-session`, then hard-restart Stream Deck.

## Three-page operating model

### Page 1: daily web shortcuts

Use ordinary daily shortcuts here. Browser actions should:

1. search every Chrome window and tab;
2. search every Safari window and tab;
3. focus an existing matching tab;
4. create a Chrome tab only when neither browser contains a match.

Compiled AppleScript applications are suitable when Stream Deck's built-in website action cannot enforce tab reuse. Match stable URL fragments rather than volatile titles.

### Page 2: cmux navigation and session entry

```text
TAB PREV | TAB NEXT | DUPLICATE TAB | CLOSE TAB | GJC FOCUS
PANE PREV | PANE NEXT | HOME TAB      | STEER NOW | ESC X2
BACK      | DIR PREV  | DIRECTORY TAB | DIR NEXT  | NEXT
```

#### Navigation controls

- `PANE PREV` / `PANE NEXT`: select the previous or next pane in the current workspace.
- `TAB PREV` / `TAB NEXT`: select the previous or next surface in the focused pane.
- `GJC FOCUS`: sample fresh cmux topology once on key release. On a focused `GJC:` surface it submits `proceed`; on a normal terminal it launches the canonical GJC binary in that same surface.
- `DIR PREV` / `DIR NEXT`: browse the ten most recent GJC working directories. A hold reverses the configured direction.
- `DIRECTORY TAB`: tap opens a shell at the selected path; hold opens the path and starts GJC.

#### Session and surface controls

- `DUPLICATE TAB`: tap opens a shell at the focused terminal's current working directory; hold starts GJC there.
- `CLOSE TAB`: close the focused cmux surface.
- `HOME TAB`: create a terminal surface in `$HOME`.
- `STEER NOW`: send `Esc`, wait 100 ms, then send `Enter`.
- `ESC X2`: send `Esc`, wait 100 ms, then send `Esc` again.

Recent paths are displayed relative to `~/Documents/Workspace`. Managed worktrees display the canonical repository and branch on separate lines.

The launch path must use the configured canonical GJC executable rather than depending on an interactive shell alias. The local default is `~/.local/bin/gjc`, with `GJC_STREAMDECK_GJC` available as an override.
### Bundled source and assets

The repository-owned implementation lives at `integrations/streamdeck-cmux/`:

- `plugin/` contains the native Stream Deck plugin source, launcher, worktree helper, and required 144-by-144 PNG assets;
- `profile/page-2` and `profile/page-3` contain portable page manifests and page-owned artwork;
- `install.sh` installs the plugin and creates an importable `.streamDeckProfile` bundle on the Desktop.

Runtime paths are derived from `$HOME`, `import.meta.dir`, `PATH`, and optional environment overrides (`GJC_STREAMDECK_GJC`, `GJC_STREAMDECK_CMUX`, `GJC_STREAMDECK_WORKTREE`, `GJC_AGENT_DIR`, `GJC_STREAMDECK_LOG`). Never commit local profile databases, SDK endpoint files, tokens, or user-specific absolute project paths.

### Page 3: focused GJC operations

```text
MODEL NAV  | MODEL SET     | SKILL NAV | SKILL RUN | BTW
PROMPT NAV | PROMPT SUBMIT | CLEAR CTX | THINK     | THEME
BACK       | NEW SESSION   | RESUME    | EXIT      | NEXT
```

#### Model selector

`MODEL NAV` cycles the configured model catalog; hold moves backward. `MODEL SET` submits `/model gajae-code/<selected-id>`. The navigation image remains fixed, while the Set control composites the selected model artwork into its base image.

The current catalog contains:

```text
frontier-heavy
frontier-default
gpt-heavy
gpt-default
kimi-gpt
kimi-deepseek-glm
glm-deepseek
deepseek-glm
lunamaxxing-local
open-weights-spark-deepseek
open-weights-spark-luna
```

#### Skill selector

`SKILL NAV` taps forward and holds backward through `deep-interview`, `ralplan`, `ultragoal`, and `team`. `SKILL RUN` taps to insert `/skill:<id>` without submitting and holds to submit immediately.

#### Frequent prompt selector

`PROMPT NAV` taps forward and holds backward through ten repeated operator actions mined from top-level session messages:

```text
CONTINUE
PR TO DEV
REVIEW & MERGE
COMMIT PUSH / PR DEV
REBASE DEV
RUN TESTS
FIX TESTS
AUDIT DIFF
CLEANUP
UPDATE DOCS
```

`PROMPT SUBMIT` uses three gestures:

- tap: submit the selected prompt;
- hold: insert the selected prompt without `Enter` so it can be edited;
- double tap: submit `/clear`, wait 250 ms, then submit the selected prompt to the same captured GJC surface.

#### Context, thinking, theme, and session controls

- `CLEAR CTX`: tap submits `/clear`; hold asks for a concise summary of state, decisions, remaining work, and verification evidence; double tap submits `/new`.
- `THINK`: displays the focused session's persisted thinking level and taps `Shift+Tab` to cycle it.
- `THEME`: tap cycles forward, hold cycles backward, and double tap restores `red-claw`.
- `NEW SESSION`: submits `/new`. The `NEW SESSION` label is baked into its artwork, matching Resume and Exit rather than using Stream Deck title overlay.
- `RESUME`: submits `/resume`.
- `EXIT`: submits `/exit`.
- `BTW`: inserts the configured `/btw` side-question prompt.

PR and merge prompts are operator conveniences, not policy bypasses. GJC must still inspect repository rules, verify changes, and perform only actions authorized by the active runtime context.

## cmux command patterns

Use the installed cmux CLI directly:

```sh
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux

$CMUX identify --no-caller
$CMUX tree --all
$CMUX focus-panel --panel surface:7 --workspace workspace:1 --window window:1
$CMUX new-surface --type terminal --pane pane:1 --focus true
$CMUX close-surface --surface surface:7 --workspace workspace:1 --window window:1
```

A new surface response contains a `surface:<n>` reference. Capture that exact reference and use it for subsequent send, rename, focus, read-screen, or close operations.

Do not use selected/active decorations from `cmux tree --all` as the sole focus authority. `cmux identify --no-caller` returns the actual focused window, workspace, pane, and surface.

## Keyboard delivery

### Text and Enter

```sh
cmux send \
  --surface surface:7 \
  --workspace workspace:1 \
  --window window:1 \
  'make a PR targeting dev and make it LGTM'

cmux send-key \
  --surface surface:7 \
  --workspace workspace:1 \
  --window window:1 \
  enter
```

### Gesture delivery

The plugin measures `keyDown` to `keyUp` duration. A hold begins at 600 ms. Double-tap recognition uses a 280 ms window and is enabled only for Prompt Submit, Clear Context, and Theme; other controls execute immediately on release.

Do not enable double-tap globally. Delaying tab, pane, escape, close, or navigation controls makes the deck feel unresponsive and increases accidental destructive actions.

### Shift+Tab

Send `Shift+Tab` atomically:

```sh
cmux send-key \
  --surface surface:7 \
  --workspace workspace:1 \
  --window window:1 \
  'shift+tab'
```

The expected terminal byte sequence is:

```text
[27, 91, 90]
```

Do not send `\x1b[Z` through a text API when the TUI may consume the leading escape independently and abort the active operation.

### Steer and abort

```text
STEER: Esc -> wait 100 ms -> Enter
ABORT: Esc -> wait 100 ms -> Esc
```

Keep these as distinct controls. The abort control should not require a hold unless the operator explicitly requests one.

## SDK question answer pad

Every top-level GJC session publishes a loopback SDK discovery file:

```text
<repo>/.gjc/state/sdk/<sessionId>.json
```

The file contains the session WebSocket URL and token. Connect with the token as a query parameter and never persist or log it elsewhere.

Do not assume repositories are only one directory below a fixed workspace root. Resolve each live `gjc` process PID to its TTY and current working directory, then inspect that exact `<cwd>/.gjc/state/sdk/` directory. This includes managed `.gajae-code-worktrees` sessions.

When the focused session emits:

```json
{
  "type": "action_needed",
  "id": "act_9e31",
  "kind": "ask",
  "sessionId": "sess-1",
  "question": "Choose a target",
  "options": ["A", "B"],
  "recommendedIndex": 1
}
```

temporarily replace all five top-row controls—the four profile keys plus `BTW EXPLAIN`—with:

```text
ANSWER 1 | ANSWER 2 | ANSWER 3 | ANSWER 4 | ANSWER 5
```

Render the real option labels with bounded wrapping. Highlight the valid recommended index, but never decorate or modify the submitted answer value.

Reply with the exact active presentation ID:

```json
{
  "type": "reply",
  "id": "act_9e31",
  "answer": 1,
  "token": "<session token>",
  "idempotencyKey": "streamdeck-act_9e31-1"
}
```

Return to the ordinary profile controls only when `action_resolved` arrives for the **same presentation ID currently displayed**; an `action_resolved` for a different session can arrive while another question's pad is still active, so match the frame `id` against the displayed presentation before clearing it. If `reply_rejected` arrives, show an error and do not guess from question text, option text, workflow IDs, or earlier presentations.

For checkbox questions, negotiate `ask_controls_v1` in the client `hello` / replay request and require both `selectedOptionIndices` and an enabled or disabled typed `navigation_forward` control. Support up to four checkbox options because the fifth top-row key is reserved for `Done` or `Next`:

```text
☐ OPTION 1 | ☑ OPTION 2 | ☐ OPTION 3 | NO OPTION | DONE
```

Pressing an option sends its numeric index against the exact current `action_needed.id`. GJC resolves that presentation and reissues a fresh one with updated `selectedOptionIndices`; replace the displayed ID and selection state rather than reusing the old ID. Pressing the fifth key sends the typed control:

```json
{ "type": "reply", "id": "<current action id>", "answer": { "controlId": "navigation_forward" }, "token": "<session token>" }
```

Do not infer controls from labels such as `Done` or `Next`; only use the negotiated control object and honor its `enabled` field.

Only display the fixed answer pad when the question belongs to the focused GJC session, the PID/TTY mapping is exact, and the action is still active. Supported shapes are:

- one to five scalar options with no negotiated controls;
- one to four checkbox options with `selectedOptionIndices` and a typed `navigation_forward` control.

Leave free-text, checkbox questions with five or more options, malformed/missing controls, and other controlled asks to the native GJC UI.

## Mascot artwork

Use `assets/character.png` as the identity reference. Generate a distinct pose, expression, prop, and task scene for every key. Optimize for a 144-by-144 display:

- dark background;
- strong silhouette;
- high-contrast border;
- large central action;
- short bottom label;
- no small decorative text;
- dim artwork behind dynamic titles such as the focused session name or folder label.

Suitable task scenes include pane dividers, tabs, browser windows, model cores, emergency controls, git branches, approval checks, interview notebooks, planning blueprints, and goal summits.

Generate artwork through a configured image provider without embedding credentials in commands, logs, documentation, or committed files. Environment variables should contain only operator-managed values; commit neither the values nor local shell configuration.

## Manifest and plugin behavior

Represent each key with an action UUID and small settings payload. A generic control action can dispatch by `settings.type`:

```json
{ "name": "new-website-tab", "type": "newWebsiteTab" }
{ "name": "folder-gajae", "type": "fixedFolder", "path": "$HOME/src/gajae-code", "label": "gajae-code" }
{ "name": "set-kimi-gpt", "type": "command", "value": "/model gajae-code/kimi-gpt", "submit": true, "answerSlot": 3 }
{ "name": "thinking-level", "type": "key", "value": "shift+tab" }
```

Use separate actions only when Stream Deck behavior differs materially, such as cmux navigation, focused status, skill typing, steer, or double-escape abort.

## Verification protocol

After each behavioral change, verify the narrow observable contract.

### Build and installation

```sh
bun build ~/.local/share/gjc-streamdeck-plugin/plugin.js \
  --target=bun \
  --outfile="$HOME/tmp/gjc-streamdeck-plugin-verify.js"

cmp ~/.local/share/gjc-streamdeck-plugin/plugin.js \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/dev.gajae.streamdeck.sdPlugin/plugin.js"
```

### Layout

- Every referenced image exists.
- Moved actions have new action IDs.
- Page navigation keys still point in the intended direction.
- Dynamic title keys have `ShowTitle: true`.
- Question answer slots are zero-based and unique.
- Removed controls do not remain in another page or plugin manifest.

### cmux behavior

Use temporary surfaces and restore the original focus after each test:

- pane previous/next;
- tab previous/next;
- terminal creation in the requested pane;
- fixed-folder and recent-directory `cd` behavior;
- focused tab closure;
- tap-versus-hold directory and duplicate-tab launches;
- exact `Shift+Tab` bytes;
- exact `Esc`, delay, and `Esc` sequence;
- selector reversal at the 600 ms hold boundary;
- Prompt Submit tap, hold-to-insert, and double-tap `/clear` plus prompt on one surface;
- Clear Context tap, summary hold, and `/new` double tap;
- Theme forward, backward, and `red-claw` reset.

### SDK behavior

Use a temporary token-authenticated SDK WebSocket server and a temporary GJC-titled cmux surface to prove:

- discovery;
- focused session mapping;
- `action_needed` rendering;
- option wrapping;
- recommended-option highlighting;
- exact zero-based reply;
- `action_resolved` restoration;
- stale/rejected reply handling.

### Stream Deck restart

After synchronizing the plugin:

```sh
pkill -TERM -f '^/Applications/Elgato Stream Deck.app/Contents/MacOS/Stream Deck$' || true
sleep 2
open -a '/Applications/Elgato Stream Deck.app'
```

Confirm the plugin reconnects, contexts render, and the active profile remains correct.

## Troubleshooting

### A GJC control shows an error

Check the focused cmux surface title. GJC-only commands intentionally fail closed unless the raw title starts with `GJC:`.

### Hold or double tap does not trigger

Confirm the hardware emits a complete `keyDown` and `keyUp` pair. Holds require at least 600 ms. Double taps require the second release within 280 ms and are intentionally supported only by Prompt Submit, Clear Context, and Theme. Navigation controls use hold only and should never wait for a possible second tap.

### Think level aborts the operation

The integration is probably sending escape-prefixed text. Replace it with atomic `cmux send-key ... shift+tab`.

### Question options do not appear

Check:

- SDK hosting is enabled;
- the endpoint PID is alive;
- the token-authenticated WebSocket connected;
- the focused surface maps to the endpoint TTY;
- the focused session was retained even when the session inventory is capped;
- the question has no more than five scalar options, or no more than four checkbox options plus a negotiated `navigation_forward` control.

### A browser shortcut creates duplicates

Search all Chrome and Safari windows before creating a tab. Do not limit the search to the frontmost window.

### Artwork is unreadable

Remove small details, enlarge the action, darken the dynamic-title background, shorten the label, and render a complete two-page contact sheet before deployment.

## Completion report

Report only verified facts:

- profile IDs or names changed;
- page and coordinate layout;
- plugin source and installed locations;
- backup path;
- exact cmux and SDK checks run;
- number of plugin keys rendered;
- remaining environment-specific paths or optional profiles;
- failures that could not be reproduced or verified.
