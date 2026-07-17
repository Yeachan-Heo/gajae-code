# irc

> Send short prose messages to other live agents in the current process.

## Source
- Entry: `packages/coding-agent/src/tools/irc.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/irc.md`
- Key collaborators:
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global live agent directory.
  - `packages/coding-agent/src/session/agent-session.ts` — side-channel reply generation and history injection.
  - `packages/coding-agent/src/prompts/system/irc-incoming.md` — no-tools auto-reply prompt.
  - `packages/coding-agent/src/tools/index.ts` — tool availability gating.
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.enabled` default.
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` — renders IRC events into chat UI.
  - `packages/coding-agent/src/modes/utils/ui-helpers.ts` — formats `[IRC]` transcript lines.
  - `packages/coding-agent/src/task/executor.ts` — carries `irc.enabled` into subagents.

## Inputs

### `op: "list"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"list"` | Yes | Lists peers visible to the caller. |

### `op: "send"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"send"` | Yes | Sends one message to one peer or to `"all"`. |
| `to` | `string` | Yes | Peer id such as `0-Main`, or `"all"` for broadcast. Whitespace is trimmed. |
| `message` | `string` | Yes | Message body. Whitespace is trimmed; empty-after-trim is rejected. |
| `awaitReply` | `boolean` | No | Wait for prose replies. Defaults to `true` for direct messages and `false` for `to: "all"`. |

## Outputs
- Single-shot `AgentToolResult`; no streaming updates.
- `content` is one text block.
  - `list` returns either `No other live agents.` or a bullet list headed by `<n> peer(s):`.
  - `send` returns delivery summary text, then optional `## Replies`, `## Failed`, and `Unknown / unavailable peers:` sections.
- `details` is structured metadata:
  - `list`: `{ op, from, peers, channels }`
  - `send`: `{ op, from, to, delivered, replies?, failed?, notFound? }`
- The tool does not return raw IRC frames, message ids, or a transcript object.

## Flow
1. `IrcTool.createIf` only constructs the tool when `irc.enabled` is on and the session has both an `AgentRegistry` and `getAgentId` (`packages/coding-agent/src/tools/irc.ts`).
2. Tool discovery adds another gate in `packages/coding-agent/src/tools/index.ts`: if the caller is `0-Main` and `async.enabled` is off, `irc` is hidden because the main agent cannot talk to concurrent peers in sync mode.
3. `execute` resolves the process-global registry and sender id. Missing either returns a text error result instead of throwing.
4. `op: "list"` calls `registry.listVisibleTo(senderId)`, which exposes every other agent in flat namespace whose status is `running` or `idle` (`packages/coding-agent/src/registry/agent-registry.ts`).
5. `list` formats human-readable lines and returns `channels` as `['all', ...peerIds]`. These are logical targets only; there is no channel join state.
6. `op: "send"` trims `to` and `message`; missing values produce text errors.
7. `send` resolves targets:
   - `to === "all"`: all visible peers.
   - otherwise: one exact registry id, excluding self and excluding peers not in `running`/`idle`.
8. `send` chooses `awaitReply = params.awaitReply ?? !isBroadcast`.
9. Each target is dispatched in parallel via `target.session.respondAsBackground(...)`. One slow or failing peer does not block dispatch to the others.
10. `respondAsBackground` accepts each delivery into the recipient's volatile current-session exchange queue before observing it in the recipient or main UI, and before reporting sender delivery success:
    - `awaitReply === false`: accepts/queues the incoming message, then emits its `irc_message` event and forwards the display-only relay to the main session UI.
    - `awaitReply === true`: renders `packages/coding-agent/src/prompts/system/irc-incoming.md` and runs `runEphemeralTurn` with `toolChoice: "none"`. After a reply succeeds, it constructs and accepts/queues the ordered incoming + auto-reply pair, commits its IRC roster claim, then emits both `irc_message` events and forwards both display-only relays. A failed or aborted reply turn accepts and surfaces nothing.
11. Deferred injection waits until the recipient is no longer streaming; `#flushPendingBackgroundExchanges` appends accepted custom messages through normal `message_start`/`message_end` external events so persistence and listeners see them.
12. `send` aggregates `delivered`, `replies`, `failed`, and `notFound`, then returns one text summary plus matching `details`.

## Modes / Variants
- `list`: enumerate visible peers and logical channels.
- `send` direct message: one exact peer id, default synchronous auto-reply.
- `send` broadcast: `to: "all"`, default fire-and-forget (`awaitReply: false`) to every visible peer.
- `send` with `awaitReply: false`: recipient records the incoming message but does not generate a reply.
- `send` with `awaitReply: true`: recipient performs a no-tools ephemeral LLM turn and returns prose.

## Side Effects
- Session state
  - Reads from the process-global `AgentRegistry`.
  - Accepts each IRC delivery into a process-local, volatile recipient exchange queue before recipient/main observations and sender success. This acceptance is not durable delivery.
  - Emits `irc_message` session events on recipient sessions after acceptance.
  - Flushes accepted IRC custom messages into recipient history after the current stream finishes.
  - For non-main recipients, forwards display-only relay observations into the main session UI after acceptance; these relays are not persisted to the main agent history. Observer failures are isolated from accepted delivery.
  - Subagents inherit `irc.enabled` from task executor settings.
- User-visible prompts / interactive UI
  - IRC events render as `[IRC]` transcript lines in the TUI.
  - Auto-replies are generated from `packages/coding-agent/src/prompts/system/irc-incoming.md` and explicitly forbid tool use.
- Background work / cancellation
  - `send` starts one background `respondAsBackground` call per target.
  - The caller's `AbortSignal` is forwarded into each background reply turn.
- Network
  - No IRC server connection.
  - When `awaitReply: true`, the recipient may make model-provider API calls through `runEphemeralTurn`.
- Filesystem
  - No direct filesystem writes in the tool itself.

## Limits & Caps
- Availability gates:
  - `irc.enabled` defaults to `true` in `packages/coding-agent/src/config/settings-schema.ts`.
  - Main agent tool discovery suppresses `irc` when `async.enabled` is off (`packages/coding-agent/src/tools/index.ts`).
- Visibility scope: only peers in status `running` or `idle` are addressable via `listVisibleTo`.
- Reply execution:
  - No tools are available in auto-reply turns (`toolChoice: "none"` in `runEphemeralTurn`).
  - No internal timeout, retry, backoff, rate limit, or reply length cap is defined in `irc.ts`; behavior relies on the underlying model stream and any upstream API limits.
- Flush scheduling: deferred history injection polls every `50` ms while the recipient is still streaming (`#scheduleBackgroundExchangeFlush` in `packages/coding-agent/src/session/agent-session.ts`).

## Errors
- The tool returns text errors, not thrown exceptions, for:
  - missing registry: `IRC is unavailable in this session.`
  - missing sender id: `IRC is unavailable: caller has no agent id.`
  - missing `to`: `` `to` is required for op="send". ``
  - missing `message`: `` `message` is required for op="send". ``
  - unknown op: `Unknown irc op.`
- Unknown, self-addressed, non-running, and non-idle direct targets are reported under `details.notFound` and in the text footer `Unknown / unavailable peers:`.
- If a target has no attached session, it is treated as not found.
- Exceptions from reply generation before awaited-exchange acceptance are caught per-target and surfaced under `details.failed` as `{ id, error }`; other recipients still complete. A provider failure or sender abort therefore emits no `irc_message` observations and accepts no recipient exchange. Recipient/main observer failures after acceptance are isolated and do not turn a delivered exchange into a sender failure.
- If no target succeeds, `send` still returns normally with `No recipients received the message.` and optional `failed`/`notFound` metadata.

## Notes
- This is IRC-like naming only. There are no servers, sockets, nick registration, auth handshakes, channels beyond `all`, or commands such as join/part/topic.
- Addressing is by exact agent id from the registry; there is no fuzzy lookup or aliasing.
- `channels` in `list` is synthetic output: `all` plus visible peer ids. Nothing is persisted across calls as channel membership.
- Recipient history, not sender history, receives accepted IRC custom messages when the recipient flushes its current-session queue. Acceptance is process-local and volatile: it does not promise durable storage, fsync, recovery, deduplication, or replay across process loss.
- The main UI may show IRC relays for conversations it was not part of, but those relay records are explicitly display-only.
- Because reply generation snapshots in-flight assistant text, a recipient can answer based on partially streamed context.
- Direct self-messaging is rejected by resolving the target as unavailable.

## Sidebar

- `irc.sidebar.enabled` defaults to `true`: the read-only sidebar is available when `irc.enabled` is also enabled, but starts closed. `app.irc.sidebar.toggle` (default `Alt+I`, remappable) opens or hides it.
- The sidebar retains the active runtime UI session's IRC observations only. It is not written to disk or restored into another session. Each arrival decides its inline lifetime once: arrivals while the panel is visible expire 10 seconds after observation; arrivals while it is closed persist inline. Later toggles do not change that decision.
- An eligible first live inline arrival while the sidebar is closed shows a one-time hint using the resolved toggle key (for example, `Alt+I opens sidebar`). Rebuilds do not show or consume this hint.
- When open, the transcript/sidebar split targets 70:30. The sidebar keeps a 30-column minimum only while the transcript can retain at least half the usable width; below that boundary the sidebar yields completely and the transcript renders full width. Retained sidebar messages are Discord-style blocks: `sender → recipient · HH:mm`, followed by the retained body with a two-column indent and one blank row between messages. Sender and recipient display fields are normalized and bounded to 256 UTF-8 bytes at complete grapheme boundaries.
- The sidebar retains at most 10,000 observations and 16 MiB of UTF-8 message payload per runtime UI session, evicting the oldest observations first. An individual observation larger than the 16 MiB budget is omitted rather than truncated or admitted by evicting the rest of the backlog. Replay suppression tracks at most 100,000 unique observation identities and then fails closed for unseen arrivals until the runtime UI instance ends, preventing forgotten identities from resurrecting across eviction or fork cleanup while keeping memory bounded. Both inline transcript and sidebar body rendering independently materialize at most 2,048 rows from a bounded 64 KiB UTF-8 source projection, preferring recent retained content and showing explicit message/backlog elision markers when necessary. The bounded, runtime-only, read-only backlog does not affect welcome-screen row reservation, which counts transcript rows only.
- While the sidebar is visible, Kitty terminals keep rendering real images in the transcript (Kitty placements are cursor-neutral and compose safely with the split). Cursor-advancing protocols — iTerm2 inline images and raw SIXEL sequences — are represented by compact text placeholders so they cannot corrupt the split. Hiding the sidebar restores normal rendering for every protocol.
- A successful `/fork` starts a new logical UI session: it clears the sidebar ledger, hides the panel, and resets roster-delivery state. Failed or cancelled forks preserve the current runtime sidebar state.

## Hidden peer roster reminders

When the live peer roster changes, an eligible model turn receives one hidden single-line reminder listing stable agent ids and roster labels. The initial empty roster produces no reminder; a later transition to empty does. Running/idle status changes alone do not count as a roster change.

Normal turns and `/btw` ephemeral turns commit an atomic roster claim on successful completion. Awaited IRC auto-replies defer that commit until their incoming + auto-reply exchange is accepted; failed or aborted reply turns release the claim for a later retry. These reminders are context-only and never appear in the transcript or persisted history.