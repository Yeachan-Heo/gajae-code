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
3. verifies private-chat Threaded Mode capability via `getMe.has_topics_enabled`
   and, when it is off in an interactive run, prints @BotFather guidance and
   lets you retry or continue unverified;
4. asks you to message the bot from a private Telegram chat;
5. polls Telegram `getUpdates` until it sees a private chat message;
6. writes the paired chat id and enables notifications.

The setup pairing flow is private-chat only. If setup sees a `group`,
`supergroup`, or `channel`, it rejects that chat and keeps waiting for a private
DM. This is intentional for safe local discovery: group chats must not receive
session names, action ids, or pending status by accident.

Telegram private-chat topics: the managed daemon's per-session delivery uses
Telegram forum topics (`createForumTopic` + `message_thread_id`). Telegram now
supports forum topics in **private chats** when the bot owner enables **Threaded
Mode** for the bot in @BotFather. GJC cannot enable Threaded Mode through the Bot
API; setup only detects the capability (`getMe.has_topics_enabled`) and guides the
manual BotFather toggle. A forum-enabled supergroup is no longer required.

Note: enabling topics in private chats may require an additional Telegram Stars
purchase fee, per Telegram's Terms of Service for Bot Developers.

If BotFather's **Bot Settings** menu does not show **Threads Settings** or
**Threaded Mode**, do not treat that as a setup blocker. Telegram exposes this
capability unevenly across clients/accounts/bot states, and GJC cannot force the
menu to appear through the Bot API. The safe fallback is to continue setup with a
private DM pairing: choose `skip` in the interactive prompt (or use
`--token <botToken> --chat-id <chatId>` for non-interactive setup). GJC will save
`threaded=unverified`/`threaded=unknown`, try topics at runtime when possible,
and otherwise deliver notifications flat to the paired private chat with the
one-time nudge shown below.

Setup verification is capability verification, not a delivery guarantee: even when
setup reports `threaded=verified`, the first runtime `createForumTopic` for the
paired chat can still fail if Telegram refuses it. When per-session topics are
unavailable, the daemon does **not** drop notifications — it routes them to the
normal (flat) paired chat and posts a one-time nudge: `turn on threaded mode from
botfather miniapp to receive gjc notification!`. Because pairing is private-only,
flat delivery lands in your own private DM with the bot.

The final setup line reports a `threaded=` status:

- `threaded=verified`: the bot has Threaded Mode capability (`has_topics_enabled`
  was true during setup);
- `threaded=unverified`: Threaded Mode was off and you skipped, or setup ran
  non-interactively; setup is saved, topics are attempted when available, and
  runtime delivery falls back to the paired flat private chat when Telegram
  refuses topic creation;
- `threaded=unknown`: the Telegram response did not include `has_topics_enabled`,
  so capability could not be verified.

After setup succeeds, it prints a masked token and the paired chat id:

```text
Notifications enabled. botToken=1234…(len N) chatId=123456789 threaded=verified
```

The raw token is never printed by GJC status/setup output after it is stored.

## 3. Non-interactive setup

For scripts or CI-style local provisioning, pass the bot token and known private
chat id explicitly. Non-interactive runs cannot prompt for the BotFather toggle,
so if Threaded Mode is off (or the capability is unknown) setup is still saved
with a warning and a `threaded=unverified`/`threaded=unknown` status:

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

The managed daemon prefers Telegram forum-topic delivery for per-session routing
in the paired private chat. When Threaded Mode is available for the bot (verified
during setup via `getMe.has_topics_enabled`), the daemon calls
`createForumTopic`/`editForumTopic` and sends messages with `message_thread_id`
against the paired `notifications.telegram.chatId`. If BotFather does not show
**Threads Settings**/**Threaded Mode**, or if Telegram refuses topic creation even
after setup reported `threaded=verified`, the daemon routes notifications to the
normal (flat) paired private chat and posts a one-time nudge to enable Threaded
Mode rather than dropping them.

Flat private-chat fallback preserves outbound notifications and inline-button
answers, but it cannot provide a separate Telegram topic per GJC session. Free-
text replies and in-topic config commands depend on topic routing, so use
Threaded Mode when you need multi-session reply separation from Telegram. Do not
pair a group, supergroup, or channel as a substitute: setup intentionally accepts
only a private DM, and hand-edited non-private chat ids remain fail-closed to
avoid leaking session data. If you specifically want group topics, create a
forum-enabled Telegram group and use a separate/custom notification integration;
the bundled `gjc notify setup` onboarding path is private-chat only.

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

Check the `threaded=` status from the last `gjc notify setup` run. If it is
`threaded=unverified` or `threaded=unknown`, first try the current Telegram
client's @BotFather flow for this bot. If BotFather's **Bot Settings** menu lacks
**Threads Settings**/**Threaded Mode**, continue with the saved private-chat
pairing; this is supported. GJC cannot enable Threaded Mode through the Bot API,
and no paid/Stars option is required just to receive flat private-chat
notifications. When `createForumTopic` is refused for the paired chat, the daemon
falls back to flat delivery in the paired private chat and posts a one-time
`turn on threaded mode from botfather miniapp to receive gjc notification!` nudge.

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
