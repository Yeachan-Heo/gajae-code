# @gajae-code/telegram-remote

A tiny, safe **Telegram operator remote** for Gajae-Code (`gjc`) sessions — v0 of
[issue #681](https://github.com/Yeachan-Heo/gajae-code/issues/681), implementing the
contract fixed in [`docs/telegram-remote.md`](../../docs/telegram-remote.md).

This is a **command + bounded-read** gateway over the **Coordinator MCP**, for session
**lifecycle and observation** from a phone. It is deliberately **not** a remote RPC
cockpit, a remote shell, a config editor, or a transcript viewer. The real session owner
stays GJC/tmux/harness-side; Telegram is only the control button.

## What it does

Five commands, mapped onto Coordinator MCP tool calls:

| Command | Intent | Mutation |
| --- | --- | --- |
| `/sessions` | List live/recent sessions with concise bounded status | none (read) |
| `/observe <sessionId>` | One session's bounded public-safe status slice | none (read) |
| `/start-session <presetId> [task]` | Start a session from an **approved preset** | `sessions` |
| `/stop <sessionId>` | Request a graceful stop (confirmation required) | `reports` |
| `/help` | Show the command set | none |

Everything outside this vocabulary is rejected as unknown.

## Safety properties

- **Default deny.** Only an explicit allowlist of Telegram user/chat ids may issue any
  command. Unlisted senders get an identical, boring refusal — no hints, no enumeration.
- **Preset-only creation.** A preset binds a fixed workdir + fixed session command +
  optional fixed task template with a single length-capped, control-char-stripped
  `{{task}}` slot. No workdir/command/branch/repo/shell/raw-RPC ever comes from chat.
- **Fail-closed mutations.** The coordinator runs with the smallest mutation set
  (`sessions`, plus `reports` only when `/stop` is enabled). `questions` is never enabled.
- **Redaction by construction.** Only a typed projection (session id, derived name,
  bounded status enum, branch, timestamps, bounded turn/lifecycle enum, short sanitized
  blocker) leaves the PC. Raw tmux tail, transcripts, tool IO, diffs, file contents, env,
  system prompt, tokens/secrets, and absolute paths are never transmitted.
- **Confirmation for `/stop`.** A `/stop <id>` arms; a second `/stop <id> confirm` (or the
  inline **Confirm stop** button) records the coordinator terminal `cancelled` status. `/stop`
  does **not** kill a tmux process.

## Rich messaging (optional)

When `GJC_TELEGRAM_REMOTE_ENABLE_RICH` is on (default), replies use HTML formatting and inline
keyboards as a **presentation + alternate-entry layer** — never a new action surface:

- `/sessions` and `/observe` render with bold labels and `<code>` ids and carry **Observe** /
  **Stop** / **Refresh** buttons; `/stop` and the Stop button offer **Confirm stop** / **Cancel**.
- `/start` is friendly onboarding; the Bot command menu (`setMyCommands`) registers
  `sessions`, `observe`, `stop`, `help`, `start` — it cannot register hyphenated `/start-session`,
  which `/help` documents.
- **Callbacks reuse the same surface.** Button presses re-enter the same gateway handlers and the
  same `CoordinatorClient` → Coordinator MCP calls as text commands. No second control protocol.
- **Callback security.** Callback queries pass the same default-deny allowlist. `callback_data` is
  only an opaque `gtr:v1:<token>` (≤64 bytes, never the session id); the exact raw session id lives
  in TTL-bound, chat/user-bound, single-use server-side token metadata. Unauthorized, expired,
  malformed, missing-chat, replayed, and cancel callbacks are **answer-only** (a toast, no chat
  message, no backend call). Every callback is answered (`answerCallbackQuery`).
- **Optional push notifications.** When `GJC_TELEGRAM_REMOTE_ENABLE_PUSH=true` and a state dir is
  configured, Follow/Mute subscriptions use the existing `gjc_coordinator_watch_events` surface. Push
  delivery never widens the transmitted-data allowlist.

Set `GJC_TELEGRAM_REMOTE_ENABLE_RICH=false` to fall back to plain text.

## RPC mode (single persistent session)

Set `GJC_TELEGRAM_REMOTE_BACKEND=rpc` to make the gateway dial one existing
owner-only UNIX socket exposed by `gjc launch --output rpc`. The gateway never
spawns, kills, or tears down that session; it is only a Telegram attach/detach
remote keyboard for the already-running RPC-mode session.

RPC mode exposes only `/attach`, `/detach`, `/status`, `/abort`, `/help`, and
`/start`. Coordinator browsing and lifecycle commands are not available:
`/sessions`, `/observe`, `/presets`, `/start-session`, and `/stop` are rejected
as unknown in RPC mode. When Bot command registration is enabled, the menu
advertises only the RPC command set.

The RPC surface is event-driven: agent questions and gates render as inline
buttons; turn-complete delivery sends only the final assistant text, HTML-escaped
and chunked to Telegram's 4096-byte message limit; session exit or liveness
timeout sends exactly one stale-attachment alert.

The socket OS-ownership boundary is the real security boundary. Same-UID clients
are fully trusted in v1; protection is for different-UID users and unsafe
filesystem placement. Controller ownership is last-connected-wins: a later UDS
client becomes current, old-socket writes are ignored or time out, and the
gateway alerts once, reconnects, and resyncs.

RPC knobs: `GJC_TELEGRAM_REMOTE_BACKEND=rpc`,
`GJC_TELEGRAM_REMOTE_RPC_SOCKET=/path/to/gjc-rpc.sock`,
`GJC_TELEGRAM_REMOTE_STATE_DIR=/path/to/state` (required in RPC mode for
reconnect/resync), `GJC_TELEGRAM_REMOTE_LIVENESS_MS=60000`, and
`GJC_TELEGRAM_REMOTE_ALLOW_ATTACH_SOCKET_ARG=false`. See `.env.example`.

## Managed background service examples

Turnkey examples live under `examples/systemd/` and `examples/launchd/`. They are examples, not a new
GJC daemon. Use **systemd user units** as the Linux production path and **launchd LaunchAgents** as
macOS local parity.

Service managers do not inherit your interactive shell setup. Before copying the units, discover the
real executable paths on the target host and either edit the examples to use them or keep the
service-local `PATH=` lines current:

```sh
command -v bun
command -v gjc
command -v gjc-telegram-remote || true
```

The shipped examples use absolute `/usr/bin/env`, `/bin/sh`, and service-local `PATH=` as a portable
baseline. For stricter deployments, replace `/usr/bin/env bun ...` and `/usr/bin/env gjc ...` with
absolute `bun`, `gjc`, or `gjc-telegram-remote` paths in every `ExecStart=`, `ExecStartPre=`, launchd
`ProgramArguments`, and wrapper `exec` line.

### Linux systemd user units

Coordinator mode is one service because the gateway starts `gjc mcp-serve coordinator` itself:

```sh
mkdir -p ~/.config/gjc ~/.config/systemd/user
cp examples/systemd/telegram-remote.env.example ~/.config/gjc/telegram-remote.env
chmod 700 ~/.config/gjc
chmod 600 ~/.config/gjc/telegram-remote.env
$EDITOR ~/.config/gjc/telegram-remote.env
cp examples/systemd/gjc-telegram-remote-coordinator.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gjc-telegram-remote-coordinator.service
```

RPC mode is two services: `gjc-rpc-session.service` owns the persistent `gjc launch --output rpc
--listen ...` session socket, and `gjc-telegram-remote-rpc.service` dials it. The bot unit uses
`Wants=` + `After=` + a finite socket wait; `After=` alone is only ordering, not readiness.

```sh
cp examples/systemd/gjc-rpc-session.service ~/.config/systemd/user/
cp examples/systemd/gjc-telegram-remote-rpc.service ~/.config/systemd/user/
# Edit both units and ~/.config/gjc/telegram-remote.env so the --listen socket exactly matches
# GJC_TELEGRAM_REMOTE_RPC_SOCKET (use a concrete /run/user/<uid>/... path in the env file).
systemctl --user daemon-reload
systemctl --user enable --now gjc-rpc-session.service gjc-telegram-remote-rpc.service
```

For boot without an interactive login, enable linger explicitly:

```sh
loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" -p Linger
```

Keep the token only in the copied env file. `EnvironmentFile=` keeps it out of the unit and argv, but
because the app is env-only the token still reaches the process environment. A hardened systemd setup
can use `LoadCredential=`/`systemd-creds`, but today that requires a wrapper that exports
`GJC_TELEGRAM_REMOTE_BOT_TOKEN` from `$CREDENTIALS_DIRECTORY` (or future token-file support).

Verification checklist:

```sh
systemd-analyze verify --user ~/.config/systemd/user/gjc-telegram-remote-coordinator.service
systemd-analyze verify --user ~/.config/systemd/user/gjc-rpc-session.service
systemd-analyze verify --user ~/.config/systemd/user/gjc-telegram-remote-rpc.service
stat -c "%a %U %G %n" ~/.config/gjc/telegram-remote.env
stat -c "%F %a %u %n" /run/user/$(id -u)/gjc/telegram-remote.sock
systemctl --user show gjc-telegram-remote-rpc.service -p ExecStart
journalctl --user -u gjc-telegram-remote-rpc.service
```

The token must not appear in unit text, `ExecStart`, wrapper output, or logs. Socket parent ownership
and mode must match the same UID that runs both RPC services. `GJC_TELEGRAM_REMOTE_RPC_SOCKET` in the
env file must be a concrete path and must exactly match the RPC session unit's `--listen` path; do not
put `%h` or `%t` in app env values expecting telegram-remote to expand them.

Default RPC coupling is intentionally loose: stopping the bot leaves the session running. If the RPC
session dies while the bot remains alive, the gateway reports stale/disconnected state and the operator
can reattach or restart. Operators who prefer stronger lifecycle coupling can adapt the examples with
`Requires=`, `BindsTo=`, or `PartOf=`, but those have different stop/restart propagation semantics and
still do not replace the bounded socket wait.

Strict coupling options are deliberately not the default:

- `Requires=gjc-rpc-session.service` pulls in the session unit and fails startup if it cannot start;
  it still is not readiness and does not replace the socket wait.
- `BindsTo=gjc-rpc-session.service` also stops the bot when the session unit disappears, which may be
  useful if operators prefer a clean bot restart cycle after session loss.
- `PartOf=gjc-rpc-session.service` propagates stop/restart operations from the session unit to the bot
  but does not pull in the session at startup.

Use these only when you want the bot lifecycle coupled more tightly to the RPC session.

Uninstall:

```sh
systemctl --user disable --now gjc-telegram-remote-coordinator.service gjc-telegram-remote-rpc.service gjc-rpc-session.service
rm -f ~/.config/systemd/user/gjc-telegram-remote-coordinator.service ~/.config/systemd/user/gjc-telegram-remote-rpc.service ~/.config/systemd/user/gjc-rpc-session.service
systemctl --user daemon-reload
# Remove ~/.config/gjc/telegram-remote.env only when you intentionally want to delete secrets/config.
```

### macOS launchd parity

The `examples/launchd/` plists use `com.example...` labels on purpose: copy them to
`~/Library/LaunchAgents/`, replace `YOU` and the label namespace for your machine, copy the wrapper
scripts, and keep the env file mode `0600`. launchd has no `EnvironmentFile=` or systemd-style
`After=`/`Wants=`/`BindsTo=` semantics, so the RPC bot wrapper sources a protected shell env file and
performs a finite socket wait before execing Bun.

Coordinator mode loads one LaunchAgent:

```sh
mkdir -p ~/Library/LaunchAgents ~/Library/Application\ Support/gjc ~/Library/Logs
cp examples/launchd/telegram-remote.env.example ~/Library/Application\ Support/gjc/telegram-remote.env
chmod 600 ~/Library/Application\ Support/gjc/telegram-remote.env
cp examples/launchd/com.example.gajae-code.telegram-remote.coordinator.plist ~/Library/LaunchAgents/
# Edit ~/Library/LaunchAgents/com.example.gajae-code.telegram-remote.coordinator.plist:
# replace YOU and com.example... with local absolute paths and labels.
plutil -lint ~/Library/LaunchAgents/com.example.gajae-code.telegram-remote.coordinator.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.gajae-code.telegram-remote.coordinator.plist
```

RPC mode loads two LaunchAgents. The RPC session plist's `--listen` socket must exactly match
`GJC_TELEGRAM_REMOTE_RPC_SOCKET` in the env file; the RPC bot wrapper waits for that socket and times
out clearly if it never appears:

```sh
cp examples/launchd/com.example.gajae-code.gjc-rpc-session.plist ~/Library/LaunchAgents/
cp examples/launchd/com.example.gajae-code.telegram-remote.rpc.plist ~/Library/LaunchAgents/
# Edit both plists and the env file: replace YOU, labels, absolute paths, and matching socket paths.
plutil -lint ~/Library/LaunchAgents/com.example.gajae-code.gjc-rpc-session.plist \
  ~/Library/LaunchAgents/com.example.gajae-code.telegram-remote.rpc.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.gajae-code.gjc-rpc-session.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.gajae-code.telegram-remote.rpc.plist
```

Verify launchd logs under `~/Library/Logs/` contain no token, and verify a bot restart does not imply
ownership of the RPC session unless you intentionally changed the examples.

The env file is sourced by `/bin/sh`; quote values containing spaces. The wrappers must not echo env
values, and the token must not appear in plist `ProgramArguments` or log files.

Uninstall with `launchctl bootout gui/$(id -u) <plist>` and then remove copied plists/env files only
when desired.

## Run it

```sh
export GJC_TELEGRAM_REMOTE_BOT_TOKEN="123456:telegram-bot-token"
export GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS="11111111"   # comma-separated
export GJC_TELEGRAM_REMOTE_PRESETS='[
  {"id":"proj","workdir":"/home/bot/src/project","sessionCommand":"gjc --worktree",
   "taskTemplate":"Use /skill:ralplan to plan: {{task}}","taskMaxLen":2000}
]'
export GJC_TELEGRAM_REMOTE_ENABLE_STOP="true"            # optional; enables /stop

bun run start
```

The service spawns `gjc mcp-serve coordinator` with a forced, smallest mutation set and
long-polls the Telegram Bot API. See `.env.example` for every variable.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GJC_TELEGRAM_REMOTE_BOT_TOKEN` | **Required.** Telegram bot token. |
| `GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS` | Comma-separated allowlist of Telegram user ids. |
| `GJC_TELEGRAM_REMOTE_ALLOWED_CHAT_IDS` | Comma-separated allowlist of chat ids. At least one allowlist is required. |
| `GJC_TELEGRAM_REMOTE_PRESETS` | JSON array of presets (`id`, `workdir`, `sessionCommand`, `taskTemplate?`, `taskMaxLen?`). |
| `GJC_TELEGRAM_REMOTE_ENABLE_STOP` | `true`/`1`/`yes` to enable `/stop` (adds the `reports` mutation class). |
| `GJC_TELEGRAM_REMOTE_ENABLE_RICH` | Enable HTML + inline keyboards (default `true`; `false` for plain text). |
| `GJC_TELEGRAM_REMOTE_RICH_CALLBACK_TTL_MS` | TTL for observe/refresh/arm callback tokens (default `600000`). |
| `GJC_TELEGRAM_REMOTE_RICH_CALLBACK_MAX_TOKENS` | Max in-memory callback tokens (default `500`). |
| `GJC_TELEGRAM_REMOTE_ENABLE_EDIT_MESSAGE_TEXT` | Refresh `/observe` in place via `editMessageText` (default `false`; falls back to a new message). |
| `GJC_TELEGRAM_REMOTE_REGISTER_COMMANDS` | Register the Bot command menu at startup (default `true`). |
| `GJC_TELEGRAM_REMOTE_DEFAULT_TASK_MAX_LEN` | Default per-preset task cap (default `2000`). |
| `GJC_TELEGRAM_REMOTE_POLL_TIMEOUT_SEC` | Bot API long-poll timeout (default `30`). |
| `GJC_TELEGRAM_REMOTE_API_BASE` | Override the Telegram API base URL. |
| `GJC_TELEGRAM_REMOTE_COORDINATOR_COMMAND` | Coordinator command (default `gjc`). |
| `GJC_TELEGRAM_REMOTE_COORDINATOR_ARGS` | Coordinator args (default `mcp-serve,coordinator`). |
| `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` | Optional explicit workdir allowlist; derived from presets otherwise. |
| `GJC_COORDINATOR_MCP_SESSION_COMMAND` | Optional explicit session command; derived from presets otherwise. |
| `GJC_COORDINATOR_MCP_PROFILE` / `_REPO` / `_STATE_ROOT` / `_ARTIFACT_BYTE_CAP` | Passed through to the coordinator namespace/state config. |

`GJC_COORDINATOR_MCP_MUTATIONS` is **forced** by the gateway and cannot be widened from the
environment: `sessions` (read + start) or `sessions,reports` (with `/stop`). `questions` is
never enabled.

## Status

Coordinator mode remains lifecycle + observation over the Coordinator MCP, with optional rich messaging and push notifications. RPC mode is a second backend for one persistent session, adding attach/detach keyboard control, gate/question buttons, final-answer delivery, and one-shot liveness/exit alerts. See [`docs/telegram-remote.md`](../../docs/telegram-remote.md) for the full contract, deferred decisions, and non-goals.
