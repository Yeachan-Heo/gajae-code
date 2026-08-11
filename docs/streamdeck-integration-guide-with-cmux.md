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

Build a Stream Deck control surface that treats cmux as the terminal host, GJC as the interactive coding runtime, and `gjc sdk session` as the credential-free machine interface for bounded status and controls. Interactive questions remain in the native GJC UI or a configured managed adapter.

The control surface should:

- navigate cmux panes and surface tabs;
- open fixed project and home-directory terminal tabs;
- create worktree-scoped GJC sessions;
- change the model profile of the focused GJC session;
- invoke common GJC skills without submitting them prematurely;
- send precise keyboard controls such as `Shift+Tab`, `Esc`, and `Enter`;
- surface native or managed-adapter question state without answering it directly;
- open and close native cmux terminal surfaces;
- reuse existing Chrome or Safari tabs for ordinary web shortcuts;
- use distinct, readable mascot artwork for each operation;
- preserve the operator's original Stream Deck profile and unrelated repository work.

## Do not use when

- cmux is not the terminal host;
- the Stream Deck application or hardware is unavailable;
- the operator requires direct question answering from Stream Deck; use the native GJC UI or a configured managed adapter instead;
- the requested action would overwrite a shared checkout containing unrelated work;
- the operator expects generic UI automation instead of deterministic cmux and broker-bound SDK commands.

## Safety invariants

1. Back up the full Stream Deck profile before every structural layout change.
2. Preserve the original/default profile instead of reconstructing it manually.
3. Never log or commit SDK tokens, provider API keys, browser credentials, or endpoint discovery files.
4. Resolve the focused cmux surface with `cmux identify --no-caller`; do not infer focus only from tree decorations.
5. Send GJC-only controls only when the focused surface title starts with `GJC:`.
6. Do not attempt generic SDK question replies from Stream Deck; native GJC UI or a managed adapter owns the current presentation.
7. Do not synthesize answers from stale, resolved, hidden, non-focused, free-text, or unsupported multi-select questions.
8. Send `Shift+Tab` as one atomic key event. Do not emulate it with separately delivered `Esc`-prefixed text.
9. Do not create duplicate browser tabs when an existing Chrome or Safari tab matches.
10. Reuse a focused non-GJC terminal when the operator explicitly wants an in-place worktree launch.
11. Keep Stream Deck profiles, local plugin installations, and generated artwork outside version control. Private SDK-core state remains product-owned; do not inspect, move, delete, or copy endpoint discovery records.

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
        -> broker-bound `gjc sdk session` CLI / managed adapter presentation surface
        -> local launch helpers
        -> generated key images
```

Use a native Stream Deck plugin instead of a collection of shell-command actions. The plugin provides dynamic titles, per-key settings, hold/tap handling, broker-bound status invocations, managed-adapter presentation integration, focused-session guards, deterministic cmux routing, and success/error feedback.

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
PANE PREV | PANE NEXT | NEW SESSION | CLOSE TAB | GJC FOCUS
TAB PREV | TAB NEXT | VOICE | STEER | ESC X2
BACK | VibeQuant | gajae-code | HOME | NEXT
```

#### Navigation controls

- `PANE PREV` / `PANE NEXT`: select the previous or next pane in the current workspace.
- `TAB PREV` / `TAB NEXT`: select the previous or next surface in the focused pane.
- `GJC FOCUS`: keep the text-focused visual style; when pressed, submit `proceed` plus `Enter` only to a focused `GJC:` surface.

#### Session and surface controls

- `NEW SESSION`: create a terminal surface and ask for a worktree name; a blank answer starts a plain `gjc` session, while a name starts `gjc --worktree <name>`. Do not select a profile here.
- `CLOSE TAB`: close the focused cmux surface.
- `VOICE`: invoke GJC's local Whisper speech-to-text action with a user remap to `Ctrl+H` on the focused `GJC:` surface.
- `STEER`: send `Esc`, wait 100 ms, then send `Enter`.
- `ESC X2`: send `Esc`, wait 100 ms, then send `Esc` again.

A session-only launcher can be implemented as:

```zsh
#!/bin/zsh
set -u

printf 'GJC worktree name (blank = plain session): '
IFS= read -r worktree_name
args=()
[[ -n "$worktree_name" ]] && args+=(--worktree "$worktree_name")
exec "$HOME/.local/bin/gjc" "${args[@]}"
```

Do not prompt for a model profile here. Apply the profile after the GJC session starts.

#### Fixed folder controls

Use explicit paths instead of recent-project discovery:

- `VibeQuant` -> `$HOME/Documents/Workspace/VibeQuant`;
- `gajae-code` -> `$HOME/Documents/Workspace/gajae-code`;
- `HOME` -> `$HOME`.

Parameterize these values for each operator. A fixed folder key creates a terminal surface in the current pane and sends `cd -- '<path>'`. Store fully expanded absolute paths (or `$HOME`-relative values the plugin normalizes before shell-quoting) so single-quoting never suppresses tilde expansion.

### Page 3: focused GJC operations

```text
SET FRONTIER | SET GPT | SET GLM DS | KIMI GPT | BTW EXPLAIN
RESUME | EXIT | PR TO DEV | THINK LEVEL | CLEAR CTX
BACK | DEEP INTERVIEW | RALPLAN | ULTRAGOAL | NEXT
```

#### Model profile controls

Model profile keys submit commands to the focused GJC editor:

```text
/model gajae-code/frontier-heavy
/model gajae-code/gpt-heavy
/model gajae-code/glm-deepseek
/model gajae-code/kimi-gpt
```

A profile must exist and be available to the current session. The names shown above (`frontier-heavy`, `gpt-heavy`, `glm-deepseek`, `kimi-gpt`) are operator-defined examples, not bundled defaults; none of them ships with GJC. Provide matching definitions in `~/.gjc/agent/models.yml` or replace them with bundled profile names before the keys will work.

#### Session controls

- `RESUME`: submit `/resume` and open the saved-session selector.
- `EXIT`: submit `/exit` for a clean GJC shutdown.
- `PR TO DEV`: submit the operator macro `make a PR targeting dev and make it LGTM` plus `Enter`.
- `THINK LEVEL`: send atomic `Shift+Tab` through `cmux send-key`.
- `CLEAR CTX`: submit `/clear`, preserving the session ID while clearing context.
- `BTW EXPLAIN`: submit `/btw 설명해봐 이거` for an ephemeral side question.

The PR macro is an operator convenience, not a policy bypass. GJC must still inspect repository rules, run required verification, use an isolated branch or worktree when appropriate, create a focused commit, and open a PR against `dev` only when that branch exists and is the repository's intended integration branch.

#### Skill controls

Skill keys type but do not submit:

```text
/skill:deep-interview
/skill:ralplan
/skill:ultragoal
```

Leaving the command in the editor allows the operator to add arguments before pressing `Enter`.

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

### Voice (`Ctrl+H`)

Remap local Whisper speech-to-text in `~/.gjc/agent/keybindings.json`:

```json
{
  "app.stt.toggle": "Ctrl+H"
}
```

The Stream Deck plugin sends atomic `ctrl+h` through `cmux send-key`. New GJC sessions load the remap; already-running sessions keep the keybindings they started with and should not be modified in place.

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

## SDK question presentation boundary

A Stream Deck profile must not implement a standalone GJC session attachment. Do
not scan `.gjc/state/sdk`, parse discovery records, read credentials, or open a
raw per-session WebSocket.

Use the native GJC UI for interactive questions. A configured managed adapter
receives the opaque `SessionRouter` attachment required to render and answer a
current presentation; the Stream Deck can control only the adapter's documented
presentation surface. For credential-free local status, invoke `gjc sdk session
inspect <sessionId>` from the selected repository. For broader orchestration,
use Coordinator MCP.

Do not synthesize question replies from profile keys, cached action IDs, question
text, option labels, workflow IDs, or historical presentations. A stale or
ambiguous presentation must remain unanswered rather than being guessed.

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
- voice sends atomic `Ctrl+H` to a session that loaded the remap without inserting text;
- fixed-folder `cd` behavior;
- focused tab closure;
- same-tab worktree prompting when required;
- exact `Shift+Tab` bytes;
- exact `Esc`, delay, and `Esc` sequence;
- exact macro text plus carriage return.

### SDK behavior

Use a temporary broker-bound CLI fixture and a temporary GJC-titled cmux surface to prove:

- credential-free session inspection;
- focused session mapping;
- native or managed-adapter question presentation;
- no discovery-file, credential, or raw transport access;
- stale or rejected presentation handling that never guesses a reply.

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

### Worktree prompting does not appear

Confirm the helper is executable. A blank name must invoke plain `gjc`; a non-empty name must invoke `gjc --worktree <name>` from a Git repository. Do not pass a filesystem path as the worktree name.

### Think level aborts the operation

The integration is probably sending escape-prefixed text. Replace it with atomic `cmux send-key ... shift+tab`.

### Question options do not appear

Question presentation belongs to the native GJC UI or a configured managed
adapter. Confirm the managed adapter has the exact current session mapping and
that `gjc sdk session inspect <sessionId>` reports the session through the
Broker. The Stream Deck must not diagnose or attach to the private transport.

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
