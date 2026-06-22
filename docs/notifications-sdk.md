# Notifications SDK

A small, transport-agnostic way to get **action-needed** signals out of a GJC
session and deliver **replies** back — without scraping the terminal and without
the depth of the RPC / Coordinator / Bridge surfaces.

The stable contract is deliberately generic: every running session exposes one
loopback WebSocket endpoint, and integrations are user-written clients that
connect to that endpoint. Telegram, Discord, Slack, mobile apps, and local tools
all use the same JSON protocol. No upstream Rust, N-API, or wire-protocol change
is required for a new integration.

> Status: the Rust core (`crates/gjc-notifications`) provides the wire protocol,
> action lifecycle, loopback WebSocket server, and endpoint discovery file. The
> bundled Telegram daemon is a reference client layered on top of this SDK; it is
> not the upstream topology.

## Architecture

```
GJC session (upstream)                          your client (anywhere)
┌───────────────────────────────┐               ┌──────────────────────────┐
│ ask-tool fires / agent idle    │  action_needed │ Telegram / Discord / ... │
│   → notifications core         │ ─────────────▶ │  render + collect reply  │
│ ws://127.0.0.1:<port> (+token) │ ◀───────────── │                          │
│   reply → resolve ask gate     │     reply       │                          │
└───────────────────────────────┘               └──────────────────────────┘
```

- **One endpoint per session.** Each session runs its own loopback WebSocket
  server. Upstream does not maintain a shared daemon, singleton, or
  chat-to-session registry; multiplexing many sessions into one integration is a
  client-side concern.
- **Integrations are clients.** A client discovers endpoint files, connects to
  one or more WebSockets, renders `action_needed`, and sends `reply` messages.
- **Zero upstream change.** New transports do not require changes to
  `crates/gjc-notifications` or the JSON protocol.
- **Off unless configured.** No endpoint exists unless notifications are enabled
  and a token is present.
- **tmux-agnostic.** The endpoint behaves identically with or without tmux.

## Endpoint discovery

A running session writes a discovery file at:

```
<repo>/.gjc/state/notifications/<sessionId>.json
```

(`.gjc/state/` is git-ignored.) Shape:

```json
{
  "version": 1,
  "sessionId": "019edd41-...",
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 53124,
  "url": "ws://127.0.0.1:53124",
  "token": "<per-session token>",
  "startedAt": 1718760000000,
  "updatedAt": 1718760000000,
  "stale": false
}
```

- The file is created `0700`/`0600` (unix) and written atomically.
- The **token is in the file** because clients need it; never log it raw.
  Stale files (dead PID, past TTL, or explicitly marked) are cleaned up on the
  next start.

Connect with the token as a query parameter:

```
ws://127.0.0.1:<port>/?token=<token>
```

A wrong/missing token is rejected at the handshake with HTTP `401`.

## Protocol

JSON text frames. Field names are `camelCase`; the `type` discriminator is
`snake_case`.

### Server → client

`action_needed` — something needs attention:

```json
{ "type": "action_needed", "id": "wg_run_stage_1", "kind": "ask",
  "sessionId": "sess-1", "question": "Proceed?", "options": ["Yes", "No"] }
```

```json
{ "type": "action_needed", "id": "idle-sess-1-7", "kind": "idle",
  "sessionId": "sess-1", "summary": "finished refactor; awaiting next step" }
```

- `kind: "ask"` is answerable in both interactive/TUI and unattended/RPC modes.
  The `id` is the real workflow-gate id.
- `kind: "idle"` is notify-only and ephemeral (not replayed to clients that
  connect later).

`action_resolved` — a pending action is now terminal and **non-repliable**:

```json
{ "type": "action_resolved", "id": "wg_run_stage_1", "resolvedBy": "local" }
```

`resolvedBy` is `local` (answered in the CLI/TUI), `client` (a remote reply won),
or `timeout`.

`reply_rejected` — sent only to the client whose reply failed:

```json
{ "type": "reply_rejected", "id": "wg_run_stage_1", "reason": "already_answered" }
```

Reasons: `already_answered`, `unknown_action`, `invalid_answer`,
`resolver_unavailable`, `idempotency_conflict`, `unauthorized`.

### Client → server

`reply` — answer a pending `ask`:

```json
{ "type": "reply", "id": "wg_run_stage_1", "answer": 0, "token": "<token>" }
```

`answer` accepts:

- a number — zero-based option index (`0` = first option);
- a string — an option label, or free text;
- an object — `{ "selected": [0, "Maybe"], "custom": "..." }` for multi-select.

Optional `idempotencyKey` makes retries safe: the same key + same body re-acks;
the same key + different body is rejected with `idempotency_conflict`.

## Answer semantics

A remote reply answers a pending ask in **both** modes — RPC is not required:

- **Interactive / TUI mode:** the ask tool races the local selector against the
  remote reply (first valid answer wins). If you tap a button in the client, the
  ask resolves with that option; if you answer locally, the client receives
  `action_resolved` (`resolvedBy: "local"`) and the action becomes non-repliable.
- **Unattended / RPC mode:** the reply resolves the real workflow-gate, driving
  the session the same way a local answer would.

In both modes the first valid reply wins; later replies get `already_answered`.
Idle pings are notify-only.

## Minimal client example

```js
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const { url, token } = JSON.parse(
  readFileSync(`.gjc/state/notifications/${sessionId}.json`, "utf8"),
);

const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "action_needed" && msg.kind === "ask") {
    // present msg.question / msg.options to the human, then:
    ws.send(JSON.stringify({ type: "reply", id: msg.id, answer: 0, token }));
  } else if (msg.type === "action_resolved") {
    // mark this action as no longer answerable in your UI
  } else if (msg.type === "reply_rejected") {
    // e.g. reason === "already_answered" → the ask was answered elsewhere
  }
});
```

Swap `ws` for a Telegram bot's long-poll loop, a Discord gateway client, or a
Slack socket-mode app — the contract above is all you implement.

## Managed Telegram daemon (bundled reference client)

GJC also ships a managed Telegram reference client for the common phone-notify
workflow. It remains a client of the generic SDK: it scans session discovery
files, opens each session WebSocket, and routes Telegram replies back to the
matching endpoint.

### Setup and auto-connect

Run the setup command once:

```sh
gjc notify setup
```

The wizard validates the bot token with Telegram, waits for a private DM to the
bot, and writes canonical global Settings under `config.yml` in the GJC agent
directory. It enables:

- `notifications.enabled`
- `notifications.telegram.botToken`
- `notifications.telegram.chatId`
- `notifications.redact` (optional; default false)

After setup, sessions auto-connect when notifications are enabled. Each session
still publishes its own loopback endpoint; the daemon is only the Telegram-side
multiplexer.

### Singleton poller and trust model

Telegram `getUpdates` allows only one active long-poll owner per bot token. The
managed daemon enforces **one bot token = one getUpdates poller** with a local
lock/state file under the agent directory. New sessions attach to the existing
fresh daemon owner instead of starting another poller, preventing Telegram 409
conflicts.

The trust model is intentionally strict:

- setup pairs exactly one private Telegram chat;
- runtime accepts updates only from that paired chat id;
- groups, supergroups, channels, and unpaired users never receive session names,
  action ids, pending status, or configuration hints;
- daemon state stores a token fingerprint, not the raw bot token.

### Routing in shared chats

A single paired chat can receive actions from multiple sessions. The daemon tags
messages by session, stores compact callback aliases for inline buttons, and
routes replies back to the exact session/action.

Supported reply paths:

- tap an inline button on an ask notification;
- reply to the bot message in Telegram;
- use `/answer <session-tag> <answer>` when a session tag is needed.

Unknown, expired, or restart-unvalidated callback aliases fail closed: the daemon
sends guidance and does not guess a target session or action.

### Redaction

`notifications.redact` strips sensitive ask/idle content before remote delivery.
Ask option counts are preserved so index-based answers still resolve, but the
question text, option labels, and idle summaries are not sent to Telegram.

### Local `/notify`

Inside a GJC session, `/notify` controls the current session only:

- `/notify status` reports enabled/disabled state, daemon observation when known,
  and redaction state without printing secrets;
- `/notify off` disables the current session's notification endpoint and removes
  its discovery record without mutating global Settings;
- `/notify on` re-enables the current session when global setup is complete and
  `GJC_NOTIFICATIONS=0` is not forcing opt-out.

### Manual Telegram CLI is for debugging

`packages/coding-agent/src/notifications/telegram-cli.ts` remains as a manual
reference/debug client and template for other integrations. It is not the primary
Telegram UX.

```sh
bun run packages/coding-agent/src/notifications/telegram-cli.ts --bot-token "$BOT_TOKEN"
```

By default it refuses to start when a fresh managed daemon already owns the same
bot token for the same paired chat, because a second poller will cause Telegram
409 conflicts. Use `--force` only for deliberate debugging when you have stopped
or intentionally want to override the daemon guard.
