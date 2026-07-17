# Slack notification onboarding

This is the managed Slack Socket Mode notification adapter. It is an SDK client:
local GJC sessions continue to own loopback SDK endpoints, and Slack provides a
per-session message thread for notifications and replies.

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
- `--slack-authorized-user-id` for the single Slack user authorized to submit replies and `/sdk` commands

Without `--slack-authorized-user-id`, the adapter remains outbound-only: every inbound envelope is acknowledged but denied before it can create a durable claim or reach an SDK endpoint. The user ID is an identifier, not a secret. It also accepts `--redact`. Provide secret values from an approved local secret mechanism, not shell history, committed configuration, tickets, screenshots, or chat. Setup writes:

- `notifications.enabled = true`
- `notifications.slack.botToken`
- `notifications.slack.appToken`
- `notifications.slack.workspaceId`
- `notifications.slack.channelId`
- `notifications.slack.authorizedUserId` when configured
- `notifications.redact = true` when requested

`gjc notify status` masks all token values. It is status output, not a credential
recovery mechanism.

## Socket Mode, threads, and resume

The daemon validates the configured workspace, channel, and paired user before durably claiming an inbound effect or sending its Socket Mode acknowledgement. The durable claim records the paired actor identity, replay identity, protected-effect reference, and captured endpoint generation; it never records Socket Mode cursors, endpoint tokens, or message bodies. Rejected, bot-authored, unauthorized, and already-claimed envelopes are acknowledged without an SDK endpoint call.

Acknowledgement latency is therefore bounded by local durable-claim work rather
than SDK availability or command execution. After the ACK, the worker dispatches
the claimed effect asynchronously; a restart can replay the claim, and a retry
cannot create a second injection. Do not treat an ACK as confirmation that the SDK
operation completed.

Each session starts with one root message. Root creation uses a caller-generated
client message ID and reconciliation lookup, preventing a duplicate root after
an uncertain post. When a session closes, the daemon posts a closure marker. A
resume starts a new immutable root, so replies to the old root are rejected and
cannot steer the resumed session.

Events, retried deliveries, event contexts, and interaction/message identifiers
are deduplicated in the durable claim before a reply is injected into the captured
current endpoint generation. After a Socket Mode reconnect, Slack may redeliver an
envelope; the new delivery is acknowledged after its claim is recognized and
cannot cause a second injection.

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
