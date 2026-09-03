# Slack notification onboarding

This is the managed Slack Socket Mode notification adapter. It is an SDK client:
local GJC sessions continue to own loopback SDK endpoints, and Slack provides a
per-session message thread for notifications, pending-action replies, and new
user turns.

## Prerequisites

Create a Slack app in the target workspace, enable Socket Mode, and create an
app-level token with the Socket Mode connection scope. Install the app in the
workspace and invite it to the selected channel. Configure only the scopes and
event subscriptions the adapter needs:

- `chat:write` to post session roots, replies, and closure markers
- `channels:history` for a public channel, or the corresponding history scope
  for the channel type in use
- the message event subscription for the selected channel type
- Socket Mode enabled for Events API delivery

Keep the selected channel private to people authorized to see local session
metadata. Do not add broad workspace scopes or use an app token for ordinary Web
API calls.

## Configure the adapter

`gjc notify setup slack` is non-interactive. It requires these flags:

- `--slack-bot-token`
- `--slack-app-token`
- `--slack-workspace-id`
- `--slack-channel-id`
- `--slack-authorized-user-id` for the single Slack user authorized to submit thread messages and `/sdk` commands

Without `--slack-authorized-user-id`, the adapter remains outbound-only: every inbound envelope is acknowledged but denied before it can create a durable claim or reach an SDK endpoint. The user ID is an identifier, not a secret. It also accepts `--redact`. Provide secret values from an approved local secret mechanism, not shell history, committed configuration, tickets, screenshots, or chat. Setup writes:

- `notifications.enabled = true`
- `notifications.slack.enabled = true` (durable desired intent)
- `notifications.slack.botToken`
- `notifications.slack.appToken`
- `notifications.slack.workspaceId`
- `notifications.slack.channelId`
- `notifications.slack.authorizedUserId` when configured
- `notifications.redact = true` when requested

`gjc notify status` reports Slack completeness, repair/quarantine state, desired intent, effective enablement, destination identifiers, and masked token values. It is status output, not a credential recovery mechanism. A successful durable save is not rolled back when later daemon activation fails; the command reports the saved-but-runtime-degraded outcome and exits nonzero. In `/settings`, bot/app secret edits are explicit `keep`, `replace`, or `remove`; removing either required token turns Slack desired intent off without changing Telegram, Discord, or the global master.

## Socket Mode, threads, and resume

The daemon validates the configured workspace, channel, and paired user before durably claiming an inbound effect or sending its Socket Mode acknowledgement. The durable claim records the paired actor identity, replay identity, protected-effect reference, and captured endpoint generation; it never records Socket Mode cursors, endpoint tokens, or message bodies. Rejected, bot-authored, unauthorized, and already-claimed envelopes are acknowledged without an SDK endpoint call.

Within an active mapped thread, plain text answers the latest pending ask when
one exists; otherwise it starts a new `user_message` turn. `/sdk` prefixes retain
their command behavior. Idle notifications are status-only and never become
replyable actions. Messages outside the active root thread remain ignored, so a
shared channel does not route unrelated conversation or other bots into GJC.

Acknowledgement latency is therefore bounded by local durable-claim work rather
than SDK availability or command execution. After the ACK, the worker dispatches
the claimed effect asynchronously; a restart can replay the claim, and a retry
cannot create a second injection. Do not treat an ACK as confirmation that the SDK
operation completed.

Each session starts with one root message. Root creation uses a caller-generated
client message ID scoped to the configured workspace and channel, plus
reconciliation lookup, preventing both a duplicate root after an uncertain post
and accidental reuse of a root from a previous home channel. When a session
closes, the daemon posts a closure marker. A resume starts a new immutable root,
so replies to the old root are rejected and cannot steer the resumed session.

Event IDs, retried deliveries, and interaction/message identifiers are
deduplicated in the durable claim before input is injected into the captured
current endpoint generation. `event_context` is retained as routing metadata but
is not a dedupe key because Slack can reuse it across distinct messages in the
same channel context. After a Socket Mode reconnect, Slack may redeliver an
envelope; the new delivery is acknowledged after its claim is recognized and
cannot cause a second injection.

## Adopting an existing thread

Stock startup publishes a session's readiness immediately, so the daemon
surfaces the session and creates its own root before an operator could name an
existing one. Adopting an existing root therefore has an explicit, opt-in
three-phase lifecycle. Configuration is never part of it: the workspace and
channel come from `gjc notify setup` alone, and the operator supplies only a
session id and a thread timestamp.

```text
prepare session authority → bind the existing root through the live daemon → activate readiness
```

1. **Prepare.** Start the session prepared. A manually started session opts in
   with `GJC_NOTIFY_BIND_EXISTING_THREAD=1` in its environment; a broker
   lifecycle-managed session is prepared by its launch request instead (see
   below). Either way the session publishes its endpoint and registers with the
   broker exactly as usual, so its id and endpoint generation are discoverable
   authority, but it withholds the replayable `session_ready` signal. An
   attached daemon has nothing to surface, so no root is posted.
2. **Bind.** `gjc notify bind-thread --session-id <id> --thread-ts <root>`
   adopts the existing root through the running daemon owner, exactly as it does
   for any live session. The CLI never writes the mapping store itself: it
   proves the configured target and the exact current owner, then submits the
   mutation over the per-request chat-daemon command channel that owner serves
   in place. A reported success is accepted only after this process observes the
   exact mapping in the durable conversation store, so a stale or forged
   `status:"ok"` answer is reported as `binding_outcome_unknown` rather than as a
   success.
3. **Activate.** `gjc notify activate-thread --session-id <id>` asks
   `SessionRouter` to validate the exact indexed endpoint generation and invoke
   the session host internally. The host authorizes readiness against the
   provider-owned mapping through a redacted `{sessionId, endpointGeneration}`
   gate: activation before the binding is applied is refused (`not_bound`) with
   no grace period, and activation is idempotent, so an exact retry answers
   `already` rather than publishing a second readiness signal. The CLI never
   reads an endpoint URL/token or constructs an SDK client. When readiness is
   published, Slack adopts the bound root and posts zero replacement roots.

The opt-in is per session and explicit: only the exact value `1` prepares a
session, and a session without it keeps the stock immediate-ready root. The
existing global (`notifications.enabled`, `GJC_NOTIFICATIONS=0`) and per-session
opt-outs are unchanged and still authoritative.

Preparation has exactly two authorities and they never overlap. A manually
started session uses the environment opt-in above. A broker lifecycle-managed
session is prepared only by the session-scoped `readiness: "deferred"` intent on
its own `session.create` request: the child then publishes a distinct
`session_prepared` signal, the lifecycle wait completes on that instead of
readiness, and the create receipt reports `readiness: "prepared"`. The
environment opt-in is refused for lifecycle-managed sessions, so an inherited
process-global flag can never silently defer a broker-created session.

Either authority additionally requires a configured, session-enabled Slack
target, because the activation gate is the existing-thread presentation
mapping. The mapping stays provider-owned, while `SessionRouter` alone proves
the current endpoint generation and performs activation. A preparation request
that cannot build the configured mapping gate fails closed — the lifecycle child
settles a startup failure and the environment opt-in throws — rather than
degrading to ordinary immediate readiness or handing back a prepared session
that could activate with no binding at all.

Through the Coordinator MCP surface the same three phases are
`gjc_coordinator_start_session` with `prepare_existing_thread: true` (which
rejects an initial prompt and returns the session at state `prepared`), the
unchanged `gjc notify bind-thread` command, and
`gjc_coordinator_activate_session`. The Coordinator never writes the mapping
store: it proves exact endpoint authority and delegates to the same activation
exchange the CLI uses, and durable session state only becomes ready once the
session itself proves `activated`/`already`. A prepared session refuses
`gjc_coordinator_send_prompt` until it is activated.

### Trust boundary

The command channel proves *correlation*, never authorship: every field a
response echoes is copied verbatim out of the plaintext request published beside
it in the daemon's own owner-only command directory. GJC trusts same-UID local
processes, so nothing here defends against a hostile process running as the same
user; what it does guarantee is that a stale or forged answer with no matching
durable mapping never becomes a reported success.

## Operational safety

Treat rate limits, permission failures, and Socket Mode disconnects as transport
failures. Let the managed daemon reconnect or reconcile; do not run a competing
Socket Mode consumer against the same app/state, manually modify conversation
state, persist delivery cursors, expose loopback endpoints, or use Slack as a
general remote shell.

The adapter only sends notifications and routes SDK replies. It does not support
provider registration, retaining endpoint credentials, or arbitrary remote
control.

## Verification boundary

Acceptance coverage uses an injectable fake Slack provider plus a production
Session SDK host boundary proof. It covers durable-claim-before-acknowledgement
for accepted, rejected, duplicate, and reconnect-redelivered envelopes; root-post
reconciliation; event/retry/context/interaction dedupe; generation and restart
isolation; rate-limit/permission/disconnect failures; and the prohibition on
persisted Socket Mode cursors. No live Slack credentials or workspace is required.
