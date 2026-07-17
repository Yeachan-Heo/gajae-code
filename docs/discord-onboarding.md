# Discord notification onboarding

This is the managed Discord notification adapter. It is an SDK client: every
local GJC session retains its own loopback SDK endpoint, while the daemon maps
that session to one Discord thread under a configured parent channel.

## Prerequisites

Create a Discord application and bot through Discord's developer portal, install
the bot in the target guild, and create or select the parent channel that will
contain GJC session threads. Configure the bot with only the permissions it
needs in that channel:

- View Channel
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Manage Threads (needed to archive, unarchive, and lock session threads)
- Read Message History

Enable the Gateway intents required to receive the configured thread messages
and interactions. Do not grant Administrator merely to make setup work. Keep
the bot and parent channel private to people permitted to see local session
metadata.

## Configure the adapter

`gjc notify setup discord` is non-interactive. It requires these flags:

- `--discord-bot-token`
- `--discord-application-id`
- `--discord-guild-id`
- `--discord-parent-channel-id`

It also accepts `--redact`. Supply secret flag values from an approved local
secret mechanism rather than placing them in shell history, files committed to
the repository, chat transcripts, or screenshots. The setup command writes:

- `notifications.enabled = true`
- `notifications.discord.botToken`
- `notifications.discord.applicationId`
- `notifications.discord.guildId`
- `notifications.discord.parentChannelId`
- `notifications.redact = true` when requested

`gjc notify status` shows configured Discord identifiers and masks token values.
It must not be used as a way to recover a token.

## Threads, resume, and replies

A session gets one Discord thread. For a generic text-channel parent, the daemon
first posts a nonce-bearing starter message and then uses Discord's **Start
Thread from Message** endpoint. It never sends the protocol-invalid nested
`message` field to the **Start Thread without Message** endpoint. A notification
creates a durable local mapping before remote work begins; a retry first finds
the nonce-bearing starter message and attached thread, reconciling an uncertain
create instead of intentionally creating a second thread. The nonce is only an
opaque correlation marker and never contains credentials.

When a session is archived, the daemon archives its thread. On resume it first
tries to unarchive that thread. If Discord refuses unarchive, the daemon creates
a replacement thread and marks the old mapping superseded. Inbound events from a
superseded thread, stale endpoint generation, unknown route, bot author, or
missing local endpoint fail closed and are not routed to a session.

Reply controls carry the session endpoint generation. Discord interaction IDs
and event IDs are deduplicated locally. A reply is sent to the loopback SDK only;
the daemon never stores endpoint tokens or message bodies in its conversation
state.

## Operational safety

Discord API permission failures, rate limits, disconnects, and uncertain creates
must be retried through the managed daemon's reconciliation path. Do not use a
second bot process against the same managed state directory, manually edit
conversation files, scrape a session terminal, expose the loopback endpoint, or
turn Discord into a general remote shell.

The supported surface is notification delivery and replies to the SDK protocol.
Provider registration, provider secrets in session state, and arbitrary remote
control are out of scope.

## Verification boundary

The shipped acceptance coverage uses an injectable fake Discord provider. It
covers uncertain create reconciliation, durable restart behavior, archive/
unarchive-or-replacement resume, stale/superseded inbound rejection, permission
and rate-limit failure paths, and disconnect handling. It deliberately does not
require live Discord credentials, a live guild, or live-provider end-to-end
tests.
