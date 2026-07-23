# Gajae-Code SDK

For embedding GJC in-process, see [the embedding SDK guide](./sdk-embedding.md).
For a beginner-friendly application development guide (recipes, customization, and surface selection), see [Building applications on the SDK](./sdk-app-guide.md).

<p align="center">
  <img src="../assets/telegram-mobile-hero.png" alt="Gajae Code mobile answers for coding agents hero illustration" width="100%" />
</p>

A small, transport-agnostic SDK for receiving **action-needed** signals from a
GJC session and sending **replies** back without scraping the terminal.

The stable contract is deliberately generic: every top-level running session
hosts one loopback WebSocket endpoint by default, and integrations are
user-written clients that connect to that endpoint. Telegram, Discord, Slack,
mobile apps, and local tools all use the same JSON protocol. No upstream Rust,
N-API, or wire-protocol change is required for a new integration.

> Status: the Rust core (`crates/gjc-sdk`) provides the wire protocol, action
> lifecycle, loopback WebSocket server, and endpoint discovery file. The bundled
> Telegram daemon is a reference client layered on top of this SDK; it is not the
> upstream topology.

## TypeScript transport client

Install the standalone transport-only client when connecting to the v3 SDK WebSocket endpoint from TypeScript:

```bash
bun add @gajae-code/bridge-client
```

```ts
import { SdkClient } from "@gajae-code/bridge-client";
```

`@gajae-code/coding-agent/sdk` remains a compatibility re-export of this same `SdkClient` class and associated types, so both entry points preserve class identity. The package is a client for the documented v3 transport only: it does not restore the historical BridgeClient backend protocol, handshake/commands/SSE endpoints, or any direct host-control path.

## Migration from the removed RPC mode

The retired `--mode rpc`, `rpc-ui`, and `bridge` modes are removed. The SDK v3
WebSocket endpoint is now the canonical external control/query bus.

| Retired RPC commands | SDK v3 control/query operations |
| --- | --- |
| `prompt`, `steer`, `follow_up`, `abort` | `turn.prompt`, `turn.steer`, `turn.follow_up`, `turn.abort` |
| Model, thinking, queue, retry, and compaction controls | `model.*`, `thinking.*`, `queue.*`, `retry.*`, and `compaction.*` |
| Session and transcript queries | `session.*`, `transcript.*`, `context.get`, and `session.stats` |
| Workflow-gate response | `workflow.gate_answer` |

See the [RPC-to-SDK v3 parity audit](./sdk-rpc-parity-audit.md) for the full
matrix, partial equivalents, and evidence.

For a local non-WebSocket transport, run one of these commands:

```sh
gjc sdk serve --stdio
```

```sh
gjc sdk serve --socket <path>
```

It relays the identical SDK v3 frames over stdio or a Unix socket. Socket
clients send an authentication preface and the socket is mode `0600`; stdio is
one parent-owned connection.

Python clients install the `gjc_sdk` package from `python/gjc-sdk`:

```sh
python -m pip install ./python/gjc-sdk
```

Import `SdkClient` with `from gjc_sdk import SdkClient`, then use
`SdkClient.connect_ws`, `SdkClient.connect_socket`, or `SdkClient.connect_stdio`.
The client supplies `reply.token` for replies.

Phase 2 still does **not** provide unattended negotiation, a cross-process
reattach/registry, or a renderer-grade full event stream. No event-plane parity
is claimed; see the audit's [ranked Phase-2 register](./sdk-rpc-parity-audit.md#ranked-phase-2-follow-up-register--not-implemented).

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

- **One endpoint per top-level session.** Each top-level session runs its own
  loopback WebSocket server. Subagents do not host endpoints. Upstream does not
  maintain a shared daemon, singleton, or chat-to-session registry;
  multiplexing many sessions into one integration is a client-side concern.
- **Hosted by default.** SDK hosting is independent of notification
  configuration. Set `GJC_SDK_DISABLE=1` to opt out of hosting for a top-level
  session.
- **Notification delivery is optional.** Configure and enable a managed
  notification adapter only when remote delivery is needed; the SDK endpoint
  remains available without one.
- **Integrations are clients.** A client discovers endpoint files, connects to
  one or more WebSockets, renders `action_needed`, and sends `reply` messages.
- **Zero upstream change.** New transports do not require changes to
  `crates/gjc-sdk` or the JSON protocol.
- **tmux-agnostic.** The endpoint behaves identically with or without tmux.

## Endpoint discovery

A running session writes a discovery file at:

```
<repo>/.gjc/state/sdk/<sessionId>.json
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

### Internal broker launch isolation

When the SDK starts its default internal broker or session host from the published TypeScript source, GJC uses a fixed Bun launch policy: `--no-env-file`, a product-owned empty `bunfig.toml`, absolute product entrypoint paths, and no inherited `BUN_OPTIONS` or mutable compiled-mode markers. The broker bootstraps from the product SDK directory rather than the caller project; a session host still runs with the lifecycle-authorized workspace as its process cwd.

This boundary prevents a child from newly loading caller-cwd or user-global Bun preload/dotenv policy. It cannot determine how a value already present in the parent environment was originally loaded, so ordinary provider/GJC environment values remain inherited. Default internal children, including compiled self-spawns, remove inherited `BUN_OPTIONS` so parent eval/test/inspect/debug/runtime options cannot be replayed into a detached child. Compiled binaries otherwise retain their existing self-spawn command contract, corroborated by a dedicated embedded marker and exact anchored Bun virtual-filesystem identity. The explicit `GJC_SDK_SESSION_COMMAND` session-host override remains a trusted legacy operator boundary and is not parsed as a shell-safe general command API. There is no broker-command override.

Broker and per-session discovery tokens remain in their authoritative private discovery files because clients need them. Launch errors, logs, and diagnostics redact those tokens and never include the child environment or isolation configuration contents.

## Protocol

JSON text frames. Field names are `camelCase`; the `type` discriminator is
`snake_case`.

### Server → client

`action_needed` — something needs attention:

```json
{ "type": "action_needed", "id": "act_9e31", "kind": "ask",
  "sessionId": "sess-1", "workflowGateId": "wg_run_stage_1",
  "question": "Proceed?", "options": ["Yes", "No"], "recommendedIndex": 1 }
```

```json
{ "type": "action_needed", "id": "act_a42f", "kind": "ask",
  "sessionId": "sess-1", "question": "Choose a target", "options": ["A", "B"] }
```

```json
{ "type": "action_needed", "id": "idle-sess-1-7", "kind": "idle",
  "sessionId": "sess-1", "summary": "finished refactor; awaiting next step" }
```

- `id` is an opaque, transient presentation/action ID. It is the **only** authority accepted by generic `reply.id`; use it only with the current authenticated endpoint. It is not a durable workflow ID.
- `workflowGateId?: string` is optional, additive SDK v3 correlation metadata, present only for the active presentation of a durable workflow gate. When present, it equals that gate's Q12 `gate_id`. Its public correlation key is `(sessionId, workflowGateId)` at the current authenticated endpoint; it never authorizes generic `reply`.
- `kind: "ask"` is answerable in interactive/TUI and SDK workflow-gate sessions. `kind: "idle"` is notify-only and ephemeral (not replayed to clients that connect later). Ordinary asks and idle frames omit `workflowGateId`.
- `recommendedIndex?: number` is optional, zero-based display metadata for `options`. Clients must validate that it is an in-range integer and ignore malformed values. Raw option labels and reply indices remain authoritative; never decorate submitted answers or infer a recommendation from position. The additive field is wire-compatible, but Rust consumers constructing the public `ActionNeeded` struct by literal must provide `recommended_index: None` when no recommendation exists.
- This corrects the pre-v3 documentation invariant that `action_needed.id == gate_id`: they are deliberately different values. Clients must not preserve that invariant, infer a relationship from question/options/order, or retain private route, claim, receipt, epoch, token, or endpoint-generation maps.

`action_resolved` — a pending action is now terminal and **non-repliable**:

```json
{ "type": "action_resolved", "id": "act_9e31", "resolvedBy": "local" }
```

`resolvedBy` is `local` (a local/direct control retired the presentation), `client` (a remote generic reply won), or `timeout`.

`reply_rejected` — sent only to the client whose reply failed:

```json
{ "type": "reply_rejected", "id": "act_9e31", "reason": "already_answered" }
```

Reasons: `already_answered`, `unknown_action`, `invalid_answer`,
`resolver_unavailable`, `idempotency_conflict`, `unauthorized`.

The frames above are the minimal contract every client implements. Threaded
clients (like the managed Telegram daemon) may also receive optional
server → client frames they can render or ignore: `identity_header` (one-time
per-session repo/branch/machine header), `context_update` (last message, task,
goal, token usage, model, diff), `turn_stream` (live/finalized turn output),
`image_attachment` (agent-produced images), `activity` (busy/idle, drives the
typing indicator), `inbound_ack` (delivery state of an injected user message),
`session_closed` (endpoint teardown; threaded clients may delete/archive the
remote conversation), `config_update` (current verbosity/redact), `hello`
(server capability/version), and `pong`. A minimal client only needs
`action_needed`, `action_resolved`, and `reply_rejected`.

### Client → server

`reply` — answer a pending `ask`:

```json
{ "type": "reply", "id": "act_9e31", "answer": 0, "token": "<token>" }
```

`answer` accepts:

- a number — zero-based option index (`0` = first option);
- a string — an option label, or free text;
- an object — `{ "selected": [0, "Maybe"], "custom": "..." }` for multi-select.

Optional `idempotencyKey` makes retries safe: the same key + same body re-acks;
the same key + different body is rejected with `idempotency_conflict`.

Threaded clients may also send optional client → server frames: `user_message`
(inject/steer a turn with free text), `config_command` (toggle verbosity/redact
in-thread), `hello` (capability/version), and `ping`. A minimal client only
needs `reply`.

## Model catalog query (Q10)

The SDK exposes the model catalog through the paged Q10 registry query. `Q10`,
`models.list/current`, `models.list`, and `models.current` are exact aliases:
each returns the same paged registry array, not a current-model singleton or a
filtered list. Continue using the returned cursor until `page.complete` is
true.

Each row preserves the five legacy fields (`provider`, `id`, `name`,
`contextWindow`, and `maxTokens`) and additively includes `reasoning`,
`thinking`, and `current`. `currentThinkingLevel` appears only on the current
row when the live session has a thinking level. The exported DTO types are
`Q10Model`, `Q10ThinkingCapabilities`, `Q10ThinkingEffort`,
`Q10SettableThinkingLevel`, `Q10CurrentThinkingLevel`, and
`Q10ThinkingMode`, all from `@gajae-code/coding-agent/sdk`; there is no public
`/sdk/models` subpath.

```json
{
  "provider": "runtime-provider",
  "id": "reasoning-model",
  "name": "Reasoning Model",
  "contextWindow": 128000,
  "maxTokens": 8192,
  "reasoning": true,
  "thinking": {
    "validLevels": ["off", "minimal", "low", "medium", "high"],
    "minLevel": "minimal",
    "maxLevel": "high",
    "mode": "effort",
    "defaultLevel": "low"
  },
  "current": true,
  "currentThinkingLevel": "high"
}
```

`thinking.validLevels` is always present and starts with `"off"`; it is the
canonical menu for `model.set` and never contains `"inherit"`. For a
non-reasoning model it is exactly `["off"]`. Successful reasoning rows always
include `minLevel`, `maxLevel`, and `mode`; only `defaultLevel` and raw `levels`
are optional. Raw `levels` deliberately keeps its descriptor order and
duplicates, while `validLevels` is the canonical, deduplicated menu clients
should render. `"inherit"` is a current-state readback value only and is rejected
as a `model.set` input.

Malformed reasoning descriptors are not client-recoverable catalog data. The
query returns the SDK's safe `internal` error rather than exposing a partially
formed row or descriptor details.

## Answer semantics

A remote reply answers a pending ask in every session state:

- **Interactive / TUI mode:** the ask tool races the local selector against the
  remote reply (first valid answer wins). A client submits generic `reply` using
  the active presentation `id`; a local answer emits `action_resolved`
  (`resolvedBy: "local"`) and that presentation becomes non-repliable.
- **SDK workflow gate:** generic `reply` still uses the active presentation
  `id`, never `workflowGateId`. The resolved gate drives the session the same
  way a local answer would.

A session has at most one active answerable presentation. Interactive asks and durable workflow gates are serialized; further Q12 gates wait in a durable queue. A same-server reconnect replays the active `action_needed` with the same presentation ID. After a process restart, previously pending or accepted-but-unadvanced records are quarantined diagnostics and a reconstructed workflow remints fresh durable gate and presentation IDs. Terminal, stale, and reissued action IDs never regain authority.

Generic and direct controls may race. Once the native generic claim is acquired, it wins; a direct control that atomically retires the exact unclaimed active presentation first wins instead. Losing direct controls fail without advancing the gate, and losing generic replies are stale/non-repliable. Clients must not retry by matching text, durable IDs, or presentation history; they must fail closed rather than guess when session or action identity is unsafe or ambiguous.

### Durable workflow controls and Q12

`workflow.gate_answer` and `workflow.plan_approve` operate on the durable
Q12 `gate_id`, not `action_needed.id`. Both accept optional
`expectedSessionId`; clients should always send the `sessionId` observed from
the current authenticated endpoint:

```json
{ "type": "control_request", "operation": "workflow.gate_answer",
  "input": { "id": "wg_run_stage_1", "response": "approve", "expectedSessionId": "sess-1" } }
```

```json
{ "type": "control_request", "operation": "workflow.plan_approve",
  "input": { "id": "wg_run_stage_1", "choice": "approve", "expectedSessionId": "sess-1" } }
```

`expectedSessionId` omission remains accepted and audited for the entire SDK v3 line so deployed v3 control clients continue to work; new clients must send it now. It cannot become mandatory, or be removed from the controls, before SDK v4 and at least one full published deprecation release/window with deployed-client notice. A supplied session mismatch is rejected before the gate resolver runs. Neither control accepts a presentation ID, remaps an old ID to a reminted gate, or uses heuristic matching.

Q12 (`workflow.gates.list`) exposes durable query records and additive SDK v3 diagnostics. A pending record preserves its workflow fields including `gate_id` and adds `id: "pending:<gate_id>"` and `tag: "pending"`. A restart quarantine diagnostic uses `id: "diagnostic:<gate_id>"`, `tag: "quarantined"`, and optional `lifecycle` containing `state: "quarantined"`, its restart reason, `quarantinedAt`, and an optional `supersededByGateId` after a remint. Diagnostics are query-only: they cannot be routed, answered, or promoted. Treat Q12 as the durable status surface, not as generic-reply authority.

### Coordinator MCP question pull loop

The Coordinator MCP bridge is a separate, public-safe pull surface for external coordinators. `gjc_coordinator_list_questions` requires `session_id` and reconciles pending `workflow.gates.list` rows on every call, returning bounded public `questions`, `diagnostics`, and `reconciliation`. It accepts `status: "pending"`; `status: "open"` remains a compatibility alias. Multiple pending rows can be returned. A pending row carries its safe question shape, public option ids, and `answer_binding`, never raw/private gate payloads or values.

`gjc_coordinator_submit_question_answer` requires `session_id`, `turn_id`, `question_id`, `answer_binding`, `answer`, `idempotency_key`, and `allow_mutation: true`. It re-lists/revalidates after restart and resolves through `workflow.gate_answer`, not generic `ask.answer`. An incomplete reconciliation returns `terminal_uncertain`; stale, terminal, missing, or ownership-mismatched rows cannot be answered. Re-list after restart rather than retaining old identifiers. An identical retry with the same idempotency key replays the accepted result; conflicting reuse returns `idempotency_conflict`.

This contract does not change #2549/#2551 or unattended plain-CLI behavior.

### Rust and N-API compatibility

The Rust `ActionNeeded`, `ServerMessage`, and `register_ask` APIs remain
legacy-compatible and uncorrelated. Correlation is available through additive
Rust workflow-frame decoding/current-reader APIs and the workflow registration
path; consumers that need correlation must opt in explicitly. N-API likewise
retains `registerAsk`, and adds `registerWorkflowGateAsk` for a correlated wire
frame plus `registerArbitratedAsk` and `retireIfUnclaimed` for in-process
presentation arbitration. The arbitration lease and all claim/receipt/epoch
state remain private: these APIs do not create a public authority value.

### Runtime and native addon release pairing

The `@gajae-code/coding-agent` runtime and `@gajae-code/natives` native addon ship from the same source release at exact matching package versions. The native loader requires the matching version sentinel; mixed native/runtime versions are unsupported and must not claim SDK compatibility.

## Minimal client example

```js
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const { url, token } = JSON.parse(
  readFileSync(`.gjc/state/sdk/${sessionId}.json`, "utf8"),
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

## Fallback chains

Model-role selectors may be ordered fallback chains; see [Fallback chains](./models.md#fallback-chains) for configuration and retry-budget details. Resolution-time skips do not consume attempts. When a request-time retry advances to another eligible entry, the selected default fallback remains sticky for later prompts in that session until an explicit model selection or a chain reset changes it.

`model_fallback_switched { eventId, from, to, reason, role, scope, activeIndex, chainLength, attemptsUsed }` is the canonical session lifecycle event for every real fallback-model switch. It replaces the legacy `retry_fallback_applied` / `retry_fallback_succeeded` event names. Embedding clients can subscribe to this session event; generic WebSocket clients should use only the protocol frames documented above and any adapter-specific status updates they support.


## Managed session-directory adapter guidance

SDK adapters that need to inspect saved sessions must import only the supported public surface from `@gajae-code/coding-agent/sdk`:

```ts
import {
  SESSION_DIRECTORY_API_VERSION,
  listManagedSessionCandidates,
  resolveManagedSessionScope,
} from "@gajae-code/coding-agent/sdk";

if (SESSION_DIRECTORY_API_VERSION !== 1) throw new Error("Unsupported session-directory API");
const resolved = await resolveManagedSessionScope({ cwd: process.cwd() });
if (resolved.kind === "resolved") {
  const listing = await listManagedSessionCandidates({ scope: resolved.scope });
  // Consume only listing.kind === "complete" and its owned candidates.
}
```

This is a readonly resolver/listing contract. Do not import `@gajae-code/coding-agent/session/internal/*`, derive `v2-…` names, write bindings, or implement migration/cleanup in an adapter; private internal subpaths are intentionally unavailable from the packaged module. Treat `network_unsupported`, binding/security errors, incomplete listings, invalid candidates, and foreign candidates as non-authoritative results rather than retrying with a guessed path.

The resolver uses canonical native identity: supported POSIX and Windows local aliases can designate one scope, while UNC/network workspaces are unsupported. Scope digests are collision-resistant identifiers, not injective aliases, credentials, or authentication. The owner-only checks protect managed local storage paths but do not authenticate an adapter or make hostile concurrent filesystem races safe. Adapters that need mutations must use the higher-level lifecycle/session APIs rather than the readonly directory API.
## Managed notification adapters

GJC ships managed SDK-client adapters for Telegram, Discord, and Slack. They use
one local SDK endpoint per session; the adapters do not change the wire protocol,
keep endpoint credentials in provider state, or expose a remote shell.

The recommended interactive path is `/settings` → **Notifications**. It owns
setup, health, test, recovery, reconnect, local enablement, and Telegram
removal without exposing stored credentials.
`gjc notify setup` remains the authoritative CLI fallback for headless and
automated environments.

Notification credentials and `notifications.*` settings are global-only.
Project notification keys are
ignored and runtime notification overrides are rejected. Telegram pairing
revalidates the complete bot-token/chat identity immediately before polling and
again before activation. A foreign or unknown owner is never killed, reloaded, or taken over;
setup fails closed without saving or exposing the raw token.

- [Telegram notification onboarding](./telegram-onboarding.md) documents
  `gjc notify setup` and private-chat pairing.
- [Discord notification onboarding](./discord-onboarding.md) documents
  `gjc notify setup discord`, required configuration, thread lifecycle, and
  least-privilege permissions.
- [Slack notification onboarding](./slack-onboarding.md) documents
  `gjc notify setup slack`, Socket Mode configuration, immediate envelope ack,
  and thread lifecycle.

`gjc notify status` reports configured providers while masking every token. The
Discord and Slack setup commands are non-interactive and require their documented
identifier and token flags; supply secrets through an approved local mechanism,
not examples, committed files, shell history, logs, or chat.

The daemon/session engine is shared. Session discovery, WebSocket protocol,
redaction decisions, rate-limit pooling, reply routing, singleton ownership, and
lifecycle control are not reimplemented by each chat surface. Telegram, Discord,
and Slack adapters are thin presentation layers: they render internal notification
events into transport payloads and map transport interactions back to `{sessionId,
actionId,answer}` replies.

Discord maps a session to an archiveable thread; resume unarchives it or creates
a replacement, and stale/superseded thread input fails closed. Slack maps a
session to an immutable root thread; resume creates a new root, acknowledges all
Socket Mode envelopes immediately, and does not persist a Socket Mode cursor.

The Discord and Slack acceptance suites use fake providers only. They exercise
provider failure, reconciliation, restart, dedupe, lifecycle, and reconnect paths
without live credentials or live-provider end-to-end tests.

## Managed Telegram daemon (bundled reference client)

GJC also ships a managed Telegram reference client for the common phone-notify
workflow. It remains a client of the generic SDK: it scans session discovery
files, opens each session WebSocket, and routes Telegram replies back to the
matching endpoint. Run `gjc notify setup` once to complete Telegram's interactive
private-chat pairing flow.

For Telegram forum topics, the daemon deletes the per-session topic when the local
notification endpoint shuts down, so it disappears from the topic list. A resumed
session creates a fresh topic before sending again. The bot must be allowed to
delete messages in that chat; without that permission, deletion is best-effort and
delivery continues.

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

### Routing in private-chat topics

The paired private chat prefers per-session Telegram topics (Threaded Mode). The
daemon tags messages by session, stores compact callback aliases for inline
buttons, and routes replies back to the exact session/action. A forum-enabled
supergroup is no longer required: when the bot owner enables Threaded Mode in
@BotFather, the daemon creates one topic per session in the paired private chat.
GJC cannot enable Threaded Mode through the Bot API; setup only verifies the
capability and guides the manual BotFather toggle.

If BotFather's per-bot **Bot Settings** menu does not show **Threads Settings**
or **Threaded Mode**, the supported fallback is the normal private-chat pairing.
Setup can be saved as `threaded=unverified`/`threaded=unknown`, and the daemon
still tries topics when Telegram allows them. When `createForumTopic` is refused,
the daemon does not drop the send: it routes the notification to the normal
(flat) paired private chat and posts a one-time nudge: `Flat Telegram private chat
supports outbound notifications and inline ask buttons only. Enable Threaded Mode
in @BotFather > Bot Settings > Threads Settings for free-text replies and session
commands.` Pairing is private-only, so flat delivery stays within the user's own
private DM.

Supported reply paths:

- tap an inline button on an ask notification;
- reply inside the session's thread/topic (replies are thread-native; the
  topic identifies the session, so no session tag is needed).

In threaded mode the user can also adjust per-session behaviour with in-thread
config commands: `/verbose` (per-tool-turn assistant text), `/lean` (settled
assistant answer at idle plus immediate ask lead-ins; the default),
`/verbosity <lean|verbose>`, and `/redact <on|off>`. The legacy
`/answer <session-tag> <answer>` command is removed — replies are routed by the
topic they arrive in.

Flat fallback keeps outbound notifications and inline-button answers working, but
plain free-text never guesses from the global pending-ask set. Free-text replies
and `/verbose`/`/lean`/`/verbosity`/`/redact` commands are thread-native and
require Threaded Mode/topic routing. Enable Threaded Mode in @BotFather > Bot
Settings > Threads Settings when you need free-text replies or session commands.
Do not pair a group, supergroup, or channel to work around a missing BotFather
menu; the bundled setup flow is
private-chat only, and non-private chat ids remain fail-closed to avoid session
data leaks.

Unknown, expired, or restart-unvalidated callback aliases fail closed: the daemon
sends guidance and does not guess a target session or action.

### Discord and Slack setup

Discord and Slack use the same internal notification events and reply protocol as
Telegram. Store only runtime credentials in local GJC settings or environment;
never paste bot tokens, webhook URLs, transcripts, prompts, host paths, or raw logs
into docs, tests, issues, or PR comments.

Configuration keys:

```yaml
notifications:
  enabled: true
  discord:
    botToken: "<local Discord bot token>"
    applicationId: "<Discord application id>"
    guildId: "<Discord guild id>"
    parentChannelId: "<Discord parent channel id>"
  slack:
    botToken: "<local Slack bot token>"
    appToken: "<local Slack app-level token>"
    workspaceId: "<Slack workspace id>"
    channelId: "<Slack channel id>"
    authorizedUserId: "<Slack user id authorized for inbound replies and commands>"
  redact: true
```

The bundled adapters intentionally render public-safe message bodies and return
route metadata only for pending internal actions. They do not own polling,
session scans, daemon locks, rate limits, or SDK lifecycle. Production transport
senders should consume the adapter payloads and keep all credential-bearing HTTP
or gateway details outside logged payloads.
### Redaction

`notifications.redact` strips sensitive content before remote delivery, but
**asks are exempt**: an ask is an interactive prompt the human must read and
answer remotely, so its `question` and `options` are always sent unredacted
(otherwise it would be unanswerable). When redaction is enabled, `idle`
summaries are removed and streamed content frames (`turn_stream`,
`context_update`, `image_attachment`) are suppressed at their emit sites. When
redaction is disabled, all content is delivered unchanged.

### Local `/notify`

Inside a GJC session, `/notify` controls the current session only:

- `/notify status` reports enabled/disabled state, daemon observation when known,
  and redaction state without printing secrets;
- `/notify off` disables the current session's notification endpoint and removes
  its discovery record without mutating global Settings;
- `/notify on` re-enables the current session when global setup is complete and
  `GJC_NOTIFICATIONS=0` is not forcing opt-out.

### Manual Telegram CLI is for debugging

`packages/coding-agent/src/sdk/bus/telegram-cli.ts` remains as a manual
reference/debug client and template for other integrations. It is not the primary
Telegram UX.

```sh
bun run packages/coding-agent/src/sdk/bus/telegram-cli.ts --bot-token "$BOT_TOKEN"
```

By default it refuses to start when a fresh managed daemon already owns the same
bot token for the same paired chat, because a second poller will cause Telegram
409 conflicts. Use `--force` only for deliberate debugging when you have stopped
or intentionally want to override the daemon guard.
## Two client surfaces: per-session vs daemon-owned lifecycle control

The SDK now exposes **two distinct surfaces**. Do not confuse them:

1. **Per-session notification clients (the normal, documented contract above).**
   A client discovers `<repo>/.gjc/state/sdk/<sessionId>.json`, connects
   to that session's loopback WebSocket, and handles `action_needed`,
   `action_resolved`, `reply_rejected`, and the optional threaded frames. This is
   all an ordinary integration (Telegram, Discord, Slack, mobile, local tools)
   needs. It requires **zero** upstream changes.

2. **The daemon-owned session *lifecycle* control endpoint (privileged).**
   A separate, **session-independent**, loopback-only, authenticated control
   endpoint that accepts `session_create` / `session_close` / `session_resume`
   frames. It exists because creating a session cannot use a per-session socket
   (none exists before the session does). It is **not** part of the normal
   integration contract: ordinary clients never implement it. Only the bundled,
   trusted daemon (e.g. the managed Telegram daemon) speaks it.

### Lifecycle control endpoint

- **Discovery:** `<agentDir>/notifications/control.json` (daemon-owned, mode
  `0600`), distinct from per-session endpoint files. It carries only non-secret
  endpoint metadata (url/host/port/pid/owner). The control token is held **in
  memory** by the daemon (the sole client) and is **never** written to disk.
- **Auth and routing:** the loopback SDK broker requires
  `?token=<control-token>` (HTTP `401` otherwise) and re-checks every
  lifecycle frame's `token` (`unauthorized` on mismatch). It routes accepted
  requests through the canonical SDK lifecycle operation.
- **Frames:** `session_create` (target `existing_path` | `worktree` |
  `plain_dir`), `session_close` (hard-kill, history preserved, recoverable),
  `session_resume` (reattach if alive, else cold-restart from history); responses
  `session_create_response` / `session_close_response` / `session_resume_response`
  / `session_lifecycle_error`. The protocol also defines a replayable
  `session_ready` per-session frame for readiness-gated creates; the current MVP
  daemon replies once the tmux launch is requested (see the phone guide) rather
  than waiting on it. Inline prompt text (`-- <prompt>`) is rejected in the MVP.

### Trust model and hardening (daemon side)

The control endpoint trusts the configured paired chat for any path (an accepted
risk). It is hardened around that boundary:

- **Strict paired-chat gating** — non-paired chats are rejected *before* any path
  parsing, filesystem, or process action.
- **Durable idempotency** — a locked, atomic, fsynced ledger keyed by
  `chatId:updateId` + request hash (`telegram-lifecycle-idempotency.json`).
  Duplicate updates never repeat side effects, including across daemon restart; a
  duplicate while in-progress reports pending (never a second spawn); a same id
  with a different body is `duplicate_conflict`; an effect failure is recorded
  `terminal_uncertain` (never auto-respawned).
- **Per-chat create rate limit.**
- **Audit log** — append-only `telegram-lifecycle-audit.jsonl` (`0600`) recording
  every accept/reject/duplicate/rate-limit/spawn/success/failure. Raw control
  tokens and raw prompts are never logged (prompt hash + byte length only).
- **Inline prompts rejected (MVP)** — `session_create` with `-- <prompt>` text is
  rejected with usage; no prompt is ever placed in argv, audit, or responses. (A
  redacted prompt-ref flow is reserved for a future revision.)
- **GJC-managed-only close** — force-close re-reads the exact `@gjc-profile`
  immediately before kill and requires the `@gjc-session-id` (and optional
  `@gjc-session-state-file`) tag to match; it never touches non-GJC tmux.
- **Recent-activity picker** — sessions are ranked by history-file mtime and
  enriched with terminal breadcrumbs so the operator picks a recent repo/session
  instead of typing raw paths. Ambiguous resumes fail closed with candidates.
### Phone test guide (create / close / resume from Telegram)

End-to-end manual check once `gjc notify setup` has paired your private chat:

1. **Pair + start.** Run `gjc notify setup` (BotFather token, DM the bot to pair).
   Start any GJC session with notifications enabled so the daemon owner is
   running (`gjc launch` in a repo, or `GJC_NOTIFICATIONS=1`). The owner starts
   the loopback control endpoint and accepts `/session_*` while running; with zero
   active sessions it still idle-exits after the inactivity timeout.
2. **Create.** From your paired chat, pick `/session_create` from the Telegram
   command menu or send `/session_create path <repo-dir>` (or
   `/session_create worktree <repo> <branch>`, or `/session_create dir <newdir>`).
   `<repo-dir>`, `<repo>`, and `<newdir>` may use `~`/`~/...` for your own home
   directory; named-user forms such as `~alice/repo` are rejected. The bot replies
   once the tmux launch is requested; the session shows up in `/session_recent`
   once it is ready. (Inline prompts via `-- <text>` are rejected for now with
   usage text.)
3. **List.** `/session_recent` shows recent sessions (most-recent first) to copy
   an id from.
4. **Close.** `/session_close <sessionId>` hard-kills the GJC-managed session
   (history is preserved); the bot confirms.
5. **Resume.** `/session_resume <sessionId|prefix>` reattaches if it is still
   alive, otherwise cold-restarts it from saved history. An ambiguous prefix
   replies with the matching candidates instead of guessing.

Commands are accepted **only** from the paired chat; **create** is rate-limited,
and all lifecycle commands are idempotent per Telegram update id and audited (no
tokens or prompts are logged).
For an automated proof of the wire path without a real bot, see
`packages/coding-agent/scripts/g011-daemon-path-smoke.ts` (real native control
endpoint + loopback WebSocket).
