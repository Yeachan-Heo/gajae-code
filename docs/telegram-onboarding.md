# Telegram notification onboarding

This guide documents the current bundled Telegram notification setup path from
Gajae-Code source. It is for the managed reference client used by
`gjc notify setup`, not a separate remote-control product.

## What you are setting up

Gajae-Code notifications are a loopback WebSocket SDK plus a managed Telegram
reference daemon:

- each GJC session publishes a local notification endpoint under
  `.gjc/state/notifications/<sessionId>.json`;
- the managed Telegram daemon scans those endpoints, connects to them, and sends
  action-needed events to the configured Telegram chat;
- replies and inline button taps route back to the exact session/action through
  the same notification protocol. When the configured chat supports Telegram
  forum topics, each session is routed through its own topic.

The setup command stores global notification settings in your GJC agent config
and later sessions auto-connect when notifications are enabled.

## 1. Create a Telegram bot with BotFather

Use Telegram's official BotFather flow to create a bot and copy its HTTP API
token:

- Official BotFather documentation: <https://core.telegram.org/bots/features#botfather>
- General Telegram Bot API documentation: <https://core.telegram.org/bots/api>

In Telegram, open `@BotFather`, run `/newbot`, choose a display name and a unique
username ending in `bot`, then copy the token BotFather returns. Treat the token
like a password: do not paste it into logs, screenshots, issues, or shell history
that other people can read.

## 2. Run the interactive setup wizard

From any terminal where `gjc` is installed:

```sh
gjc notify setup
```

Current implementation path: `packages/coding-agent/src/cli/notify-cli.ts`.

The wizard does this:

1. prompts for `Telegram BotFather token:`;
2. validates the token with Telegram `getMe`;
3. asks you to message the bot from a private Telegram chat;
4. polls Telegram `getUpdates` until it sees a private chat message;
5. writes the paired chat id and enables notifications.

The setup pairing flow is private-chat only. If setup sees a `group`,
`supergroup`, or `channel`, it rejects that chat and keeps waiting for a private
DM. This is intentional for safe local discovery: group chats must not receive
session names, action ids, or pending status by accident.

Current limitation: the managed daemon's per-session remote delivery path uses
Telegram forum topics (`createForumTopic` + `message_thread_id`). Private chats
do not support forum topics, so the private-chat id discovered by setup is
sufficient for configuration discovery/status but is not enough for end-to-end
threaded delivery. Until setup grows a forum-chat onboarding path, operators who
want Telegram delivery must configure `notifications.telegram.chatId` to a
trusted forum-enabled supergroup that the bot can manage. If topic creation
fails, the daemon drops remote sends fail-closed rather than flattening session
traffic into a shared chat.

After setup succeeds, it prints a masked token and the paired chat id:

```text
Notifications enabled. botToken=1234…(len N) chatId=123456789
```

The raw token is never printed by GJC status/setup output after it is stored.

## 3. Non-interactive setup

For scripts or CI-style local provisioning, pass the bot token and known chat id
explicitly. For end-to-end daemon delivery, use a trusted forum-enabled
supergroup chat id; for private setup/status discovery only, a private chat id is
accepted:

```sh
gjc notify setup --token <botToken> --chat-id <chatId>
```

Optional redaction can be enabled during setup:

```sh
gjc notify setup --token <botToken> --chat-id <chatId> --redact
```

`--redact` sets `notifications.redact = true`. Under redaction, idle summaries
and streamed content are suppressed before remote delivery, but ask questions and
options remain readable because they must be answerable remotely.

## 4. Check status without leaking secrets

```sh
gjc notify status
```

The status command reads the typed notification settings and prints:

- `enabled`
- masked `botToken`
- paired `chatId`
- `redact`

It uses the same masking helper as setup (`first 4 chars + … + length`), so it is
safe to paste into a support thread if the chat id itself is not sensitive in
your environment.

## 5. What setup writes

`gjc notify setup` writes these settings through the GJC Settings layer:

- `notifications.enabled = true`
- `notifications.telegram.botToken = <token>`
- `notifications.telegram.chatId = <paired chat id>`
- `notifications.redact = true` only when `--redact` was passed

At runtime, notifications are considered globally configured only when all of
these are present:

- `notifications.enabled`
- `notifications.telegram.botToken`
- `notifications.telegram.chatId`

Environment/session precedence from `packages/coding-agent/src/notifications/config.ts`:

1. `GJC_NOTIFICATIONS=0` is a hard opt-out.
2. Local `/notify off` disables only the current session.
3. `GJC_NOTIFICATIONS=1` or `GJC_NOTIFICATIONS_TOKEN` enables the legacy explicit path.
4. A complete global setup enables notifications automatically.
5. Otherwise notifications stay off.

## 6. Start or reuse sessions

After setup, start GJC normally:

```sh
gjc --tmux
```

or use any other supported GJC launch mode. When the notification extension is
registered, the session writes its endpoint discovery file and ensures the
Telegram daemon is running.

The daemon is a singleton per bot token/chat pair. Telegram allows only one
active `getUpdates` long-poll owner for a bot token, so GJC keeps a local daemon
lock/state file and makes later sessions attach to the fresh owner instead of
starting a second poller. This avoids Telegram `409 Conflict` failures.

## 7. Use the Telegram chat

The current managed daemon uses Telegram forum-topic delivery for per-session
routing. Pairing still discovers a private chat id for the local setup path, but
threaded per-session delivery requires `notifications.telegram.chatId` to point
at a trusted forum-enabled supergroup where the bot can call
`createForumTopic`/`editForumTopic` and send messages with `message_thread_id`.
If Telegram refuses topic creation, the daemon drops remote sends fail-closed
instead of falling back to a flat shared chat.

The managed daemon can render:

- session identity headers;
- context updates;
- live/finalized assistant output;
- image attachments;
- ask prompts with inline buttons;
- activity/typing indicators;
- inbound delivery acknowledgements.

Reply paths:

- tap an inline button on an ask notification;
- reply in the session topic with free text when forum-topic routing is
  available;
- send in-topic config commands:
  - `/verbose`
  - `/lean`
  - `/verbosity <lean|verbose>`
  - `/redact <on|off>`

The removed legacy `/answer <session-tag> <answer>` flow is not the primary UX;
Telegram topic routing identifies the target session when the configured chat
supports it.

## 8. Local `/notify` inside a session

Inside a running GJC session:

- `/notify status` reports current session notification status without secrets;
- `/notify off` disables the current session endpoint and removes its discovery
  record without changing global setup;
- `/notify on` re-enables the current session when global setup is complete and
  `GJC_NOTIFICATIONS=0` is not forcing opt-out.

## 9. Debug-only manual bridge

The manual Telegram CLI remains a reference/debug tool:

```sh
bun run packages/coding-agent/src/notifications/telegram-cli.ts --bot-token "$BOT_TOKEN"
```

If a fresh managed daemon already owns the same bot token and paired chat, the
manual CLI refuses to start by default because a second poller would cause
Telegram `409 Conflict`. Use `--force` only for deliberate debugging after you
understand which daemon owns polling.

## Troubleshooting

### `Telegram getMe failed`

The BotFather token is invalid or was revoked. Re-copy the token from BotFather
or regenerate it in the official BotFather UI.

### Setup times out waiting for a private chat

Send any message directly to the bot from your Telegram user account. Do not add
it to a group for pairing; groups/supergroups/channels are intentionally rejected
by the current setup flow.

### Setup succeeds but no Telegram session messages arrive

Check whether `notifications.telegram.chatId` points at a forum-enabled
supergroup where the bot can manage topics. The setup-discovered private chat id
is not sufficient for current per-session threaded delivery because private chats
do not support `createForumTopic`/`message_thread_id`.

### Telegram 409 conflict

Only one `getUpdates` poller can own a bot token. Stop any old manual bridge or
external bot process using the same token, then let GJC's managed daemon own it.

### A session does not send notifications

Check, in order:

1. `gjc notify status`
2. `GJC_NOTIFICATIONS` is not set to `0`
3. the session has not run `/notify off`
4. the repo has `.gjc/state/notifications/<sessionId>.json`
5. the managed daemon state is fresh under the GJC agent notifications directory

Do not paste endpoint discovery files into public issues; they contain the
per-session WebSocket token needed by clients.
