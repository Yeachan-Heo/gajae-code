# Telegram notification onboarding

This guide documents the bundled Telegram notification setup path from Gajae-Code
source. In an interactive GJC session, use `/settings` → **Notifications** as the
recommended path; `gjc notify` remains the authoritative headless and automation
fallback. It is for the managed reference client, not a separate remote-control
product.

## What you are setting up

Gajae-Code notifications are a loopback WebSocket SDK plus a managed Telegram
reference daemon:

- each GJC session publishes a local notification endpoint under
  `.gjc/state/sdk/<sessionId>.json`;
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

## 2. Configure from `/settings` (recommended)

In an eligible running GJC session, open `/settings` and select the
**Notifications** tab. It provides the interactive Telegram setup/reconfigure
flow and the operational controls in one place:

- Enable globally with stored credentials or disable globally;
- turn notifications on or off for the current session only;
- refresh or probe health, send a test notification, recover dead-owner
  artifacts, and reconnect the Telegram runtime;
- remove Telegram credentials without removing configured Discord or Slack
  adapters.

Telegram token entry is a masked setup field. After entry, the token is never
prefilled, rendered, or shown by the tab; status and health use a masked value.
The tab also guides the BotFather Threaded Mode check and private-chat pairing.

### CLI setup fallback

`gjc notify setup` retains the same setup workflow for terminal-driven setup and
automation:

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
and otherwise deliver flat to the paired private chat with outbound notifications
and inline ask buttons only plus the one-time nudge shown below.

Setup verification is capability verification, not a delivery guarantee: even when
setup reports `threaded=verified`, the first runtime `createForumTopic` for the
paired chat can still fail if Telegram refuses it. When per-session topics are
unavailable, the daemon does **not** drop notifications — it routes them to the
normal (flat) paired chat and posts a one-time nudge: `Flat Telegram private chat
supports outbound notifications and inline ask buttons only. Enable Threaded Mode
in @BotFather > Bot Settings > Threads Settings for free-text replies and session
commands.` Because pairing is private-only, flat delivery lands in your own
private DM with the bot.

The final setup line reports a `threaded=` status:

- `threaded=verified`: the bot has Threaded Mode capability (`has_topics_enabled`
  was true during setup);
- `threaded=unverified`: Threaded Mode was off and you skipped, or setup ran
  non-interactively; setup is saved, topics are attempted when available, and
  runtime delivery falls back to the paired flat private chat with outbound
  notifications and inline ask buttons only when Telegram refuses topic creation;
- `threaded=unknown`: the Telegram response did not include `has_topics_enabled`,
  so capability could not be verified.

After setup succeeds, it prints a masked token and the paired chat id:

```text
Notifications enabled. botToken=1234…(len N) chatId=123456789 threaded=verified
```

The raw token is never printed by GJC status/setup output after it is stored.

## 3. Non-interactive setup and CLI operations

For headless provisioning, scripts, and automation, the authoritative commands
remain `gjc notify setup`, `gjc notify status`, `gjc notify health`, `gjc notify
test`, and `gjc notify recovery`. The `/settings` tab does not replace these CLI
subcommands.

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

## 5. Global configuration, adapters, and precedence

Telegram credentials and all `notifications.*` values are **global-only**. GJC
reads them from the user/global agent config with schema defaults; notification
keys from project config files are ignored, and runtime notification overrides
are rejected. A project cannot supply, shadow, or disable an outbound
notification identity.

`gjc notify setup` writes these global Telegram settings through the GJC Settings
layer:

- `notifications.enabled = true`
- `notifications.telegram.botToken = <token>`
- `notifications.telegram.chatId = <paired chat id>`
- `notifications.redact = true` only when `--redact` was passed

A complete global configuration is `notifications.enabled` plus at least one
complete adapter. Telegram needs its bot token and private-chat id; Discord and
Slack each need their own credential and destination. Removing Telegram in
`/settings` is adapter-local: it preserves a complete Discord or Slack adapter
and global enablement, and disables global notifications only when Telegram was
the last complete adapter.


Three lifecycle gates keep SDK hosting, setup, and managed delivery separate:

1. An eligible host receives the dormant notification control surface. `GJC_NOTIFY=off`,
   `0`, or `false` is a hard process opt-out; unsupported hosts and
   helper/subagent sessions are also ineligible.
2. Every eligible top-level session hosts its local SDK endpoint by default,
   independently of notification configuration. `GJC_SDK_DISABLE=1` opts out of
   SDK hosting for that session.
3. A managed Telegram daemon is ensured only for a complete global Telegram
   configuration with managed delivery enabled. Discord-only, Slack-only, and
   environment-only sessions do not start a Telegram daemon.

Environment/session precedence for managed delivery is implemented in
`packages/coding-agent/src/sdk/bus/config.ts`:

For a GJC-spawned child, `notifications.sessionScope=primary` suppresses managed
notification delivery to avoid duplicate topics; `all` permits it.
`GJC_NOTIFICATIONS=1` or `GJC_NOTIFICATIONS_TOKEN` explicitly opts that child in,
but never overrides a hard opt-out or a helper/subagent exclusion.

Managed-delivery precedence is highest first; it does not change independently
hosted SDK endpoints:

1. `GJC_NOTIFY=off`, `0`, or `false` prevents the notification control surface
   for that process.
2. `GJC_NOTIFICATIONS=0` is a hard managed-delivery opt-out.
3. Local `/notify off` disables managed delivery only for the current session.
4. `GJC_NOTIFICATIONS=1` or `GJC_NOTIFICATIONS_TOKEN` enables the legacy
   explicit managed-delivery path.
5. A complete global configuration enables managed delivery automatically.
6. Otherwise managed delivery stays off; the SDK endpoint remains hosted unless
   `GJC_SDK_DISABLE=1` is set.

## 6. Start or reuse sessions

After setup, start GJC normally:

```sh
gjc --tmux
```

or use any other supported GJC launch mode. Every eligible top-level session
writes its SDK endpoint unless `GJC_SDK_DISABLE=1`; when managed Telegram
delivery is configured and enabled, it also ensures the Telegram daemon is running.

The managed daemon is a singleton per bot token/chat pair. Telegram allows only
one active `getUpdates` long-poll owner for a bot token, so GJC keeps a local
daemon lock/state file and makes later sessions attach to the fresh owner instead
of starting a second poller. This avoids Telegram `409 Conflict` failures.

### Same-token and foreign-owner safety

Setup and reconfigure never compete with a live same-token daemon. When a live
owner already has the stored paired chat, GJC reuses it after non-polling
validation. If that owner has no stored chat or the chat changes, provide a
validated private chat id; GJC performs zero `getUpdates` discovery polls. For a
foreign or unknown owner, setup does not poll, kill, reload, or take over the
owner; the default is to cancel before writing configuration.

For a Telegram-only setup, an explicit **Save inactive for later** choice may
store the credentials with notifications disabled. That choice is unavailable
when a complete Discord or Slack adapter is active, because globally disabling
notifications would affect that adapter. A post-save identity race similarly
stops the current session before reporting that activation is blocked; the
foreign daemon remains untouched, and the editor offers an explicit restore or
retain-configuration choice.

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

### Ask-control capability negotiation

The production Telegram multiplexer is
`packages/coding-agent/src/sdk/bus/telegram-daemon.ts`. It already sends a
protocol-v3 ClientHello with `ask_controls_v1` and `ask_selected_ack_v1`. The
generic `packages/coding-agent/src/sdk/bus/managed-daemon.ts` is
liveness-only: it advertises `client_ping_pong` but is intentionally
non-capable for controlled asks.

Telegram navigation controls appear only after `ask_controls_v1` is negotiated
on that session connection. A non-capable or older third-party client receives
the non-actionable `action_unavailable` diagnostic instead of a controlled ask
with stripped option buttons, so it cannot be left with unusable controls.

Flat private chat is notification-only plus inline ask buttons. It is not a
free-text chat surface: replies typed as normal messages and session commands such
as `/verbose`, `/lean`, `/verbosity`, and `/redact` require Threaded Mode/topic
routing.

Flat private-chat fallback preserves outbound notifications and inline-button
answers, but it cannot provide a separate Telegram topic per GJC session. Free-
text replies and in-topic config commands depend on topic routing, so enable
Threaded Mode in @BotFather > Bot Settings > Threads Settings when you need
multi-session reply separation or session commands from Telegram. Do not
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

Tool activity updates such as `⚙ read — ok` are enabled by default. Send
`/toolactivity off` in the paired private chat to suppress them globally, or
`/toolactivity on` to restore them. The toggle is durable, works without a connected session, and
is also available under `/settings` → **Notifications** → **Preferences**.

Reply paths:

- tap an inline button on an ask notification;
- reply in the session topic with free text when forum-topic routing is
  available;
- send in-topic config commands:
  - `/verbose`
  - `/lean`
  - `/verbosity <lean|verbose>`
  - `/redact <on|off>`
  - `/btw <question>` is available only in an authorized, known private-session
    topic. It uses the current session context in an isolated side turn and never
    injects or persists either a user or assistant message in the main session
    history, so it can run while the main session is busy. It accepts no
    attachments; `/btw` with an attachment returns `Usage: /btw <question>`.
    Foreign bot-command suffixes are silently ignored.

    Each logical session permits at most two concurrent side questions. The host
    deadline is 120 seconds and cancels the actual provider work. Operational
    responses are: `Usage: /btw <question>` for an empty question; `Telegram
    /btw is disabled in local settings.` when disabled; `Restart this GJC session
    to enable /btw.` when the connected session does not support side turns; `Two
    /btw questions are already running. Wait for one to finish.` when busy; `This
    /btw question timed out after 120 seconds. Send it again to retry.` on
    timeout; `This /btw question stopped because the GJC session closed or
    changed. Reopen it and try again.` when stopped; and `This /btw question
    failed. Send it again to retry.` on failure.

    A transient reconnect to the exact session may deliver a result once.
    Graceful GJC or daemon shutdown cancels side questions. Crashes or identity
    changes do not promise delivery, and stale results are fenced.
    `/btw` rich replies use Telegram Bot API 10.1 Markdown only. An eligible,
    complete structured Markdown reply is sent once as
    `{rich_message:{markdown,skip_entity_detection:true}}`, correlated to the
    source message in the same topic; GJC does not send native `blocks` or
    `media`. Eligibility is conservative: valid Unicode; at most 32,768 scalars,
    131,072 UTF-8 bytes, 500 blocks, 16 nesting levels, and 20 table columns.
    Tables and math use Telegram's 10.1 Markdown support. Ineligible content and
    a definite rich rejection use the existing correlated HTML delivery.
    Ambiguous rich outcomes never retry or fall back; `/rich off` keeps HTML-only
    behavior.
- send paired-chat lifecycle commands from the Telegram command menu or by typing:
  - `/session_create path <dir>`
  - `/session_create worktree <repo> <branch>`
  - `/session_create dir <newdir>`
  - `/session_recent [create|resume]`
  - `/session_close <sessionId>`
  - `/session_resume <sessionId|prefix>`

The removed legacy `/answer <session-tag> <answer>` flow is not the primary UX;
Telegram topic routing identifies the target session when the configured chat
supports it.
### `/btw` operational rollback

`notifications.telegram.btw.enabled` defaults to `true` and is the local kill
switch. Disabling it consumes `/btw` without forwarding it to the session. To
roll back, restart the Telegram daemon, and probe health:

```sh
gjc config set notifications.telegram.btw.enabled false
gjc daemon restart telegram --json
gjc notify health --probe
```

## 8. Local `/notify` inside a session

Inside a running GJC session, `/notify` controls the current session only; it
does not edit global config or credentials:

- `/notify status` reports current session notification status without secrets;
- `/notify off` disables the current session endpoint and removes its discovery
  record without changing global setup;
- `/notify on` re-enables the current session when a complete global
  configuration or explicit environment path is available, unless
  `GJC_NOTIFICATIONS=0` is forcing opt-out.

Neither command changes `GJC_NOTIFY` or `GJC_NOTIFICATIONS` precedence. A
process with `GJC_NOTIFY=off`, `0`, or `false` has no notification control
surface to override.

## 9. Debug-only manual bridge

The manual Telegram CLI remains a reference/debug tool:

```sh
bun run packages/coding-agent/src/sdk/bus/telegram-cli.ts --bot-token "$BOT_TOKEN"
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
falls back to flat delivery in the paired private chat and posts a one-time nudge
that points to @BotFather > Bot Settings > Threads Settings. Flat fallback is
limited to outbound notifications and inline ask buttons; free-text replies and
session commands require Threaded Mode/topic routing.

### Third-party or older client lacks ask controls

A custom client that omits ClientHello, or sends one without `ask_controls_v1`,
will still receive ordinary empty-controls asks but receives
`action_unavailable` for controlled asks after the short Hello grace or explicit
non-capable negotiation. Upgrade it to send
`{ "type": "hello", "protocolVersion": 3, "capabilities": ["ask_controls_v1"] }`
on each WebSocket open; reconnecting starts a new negotiation.

### Telegram 409 conflict

Only one `getUpdates` poller can own a bot token. GJC never takes over a fresh
foreign or unknown owner. If you own the other process, stop or reconfigure it,
then use `gjc notify health`, `gjc notify recovery`, or `gjc notify reconnect`;
recovery removes only dead-owner artifacts and never touches a live owner.

### A session does not send notifications

Check, in order:

1. `gjc notify status`
2. `GJC_NOTIFICATIONS` is not set to `0`
3. the session has not run `/notify off`
4. the repo has `.gjc/state/sdk/<sessionId>.json`
5. the managed daemon state is fresh under the GJC agent notifications directory

Do not paste endpoint discovery files into public issues; they contain the
per-session WebSocket token needed by clients.
