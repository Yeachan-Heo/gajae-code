# Gajae-Code SDK

For embedding GJC in-process, see [the embedding SDK guide](./sdk-embedding.md).
For a beginner-friendly application development guide (recipes, customization, and surface selection), see [Building applications on the SDK](./sdk-app-guide.md).

<p align="center">
  <img src="../assets/telegram-mobile-hero.png" alt="Gajae Code mobile answers for coding agents hero illustration" width="100%" />
</p>

The SDK exposes a generic action/reply protocol without requiring integrations to scrape the terminal. SDK core owns all managed attachment discovery and credential-bearing clients through `SessionRouter`; Telegram, Discord, Slack, ACP, MCP, and CLI adapters receive only capability-scoped operations and never endpoint credentials.

> Status: the Rust core (`crates/gjc-sdk`) provides the session-local wire protocol and endpoint record. TypeScript SDK core provides Broker lifecycle authority and `SessionRouter` attachment authority. Endpoint records and tokens are internal implementation details, not an external attachment surface.

## External attachment policy

External and managed integrations attach through SDK-core surfaces only:

- lifecycle mutations use `SessionLifecycleService` and the Broker lifecycle ledger;
- live session controls use opaque `SessionAttachment` capabilities issued by `SessionRouter`;
- endpoint URL/token discovery, raw WebSocket relays, and `gjc sdk serve` are not public attachment mechanisms;
- lifecycle-equivalent per-session controls are prohibited on Telegram, Discord, Slack, ACP, MCP, and daemon CLI adapters.

For terminal-side session operation, use the broker-bound [SDK session CLI](./sdk-session-cli.md):
`gjc sdk session list|inspect|send|status|tail` plus the explicit `raw`
`control|query|global` hatch. The CLI resolves the exact attachment through SDK
core and emits credential-free JSON.

## Migration from removed external transports

The retired `--mode rpc`, `rpc-ui`, `bridge`, and `gjc sdk serve` transports
have no replacement wire client. Process-isolated controllers use Coordinator
MCP, `gjc sdk session`, or a configured managed adapter. In-process applications
use the [embedding SDK](./sdk-embedding.md).

## External-agent SDK skills

The generated `sdk-skills/` bundle provides host-neutral guidance for scripts
that invoke the broker-bound session CLI. It is intentionally separate from
GJC's four internal workflow skills, the coordinator MCP plugin, and the SDK MCP
adapter. Its TypeScript and Python templates do not discover endpoints or create
transport clients.

The bundle owns exactly six files:

- `manifest.json`
- `gjc-sdk-discover/SKILL.md`
- `gjc-sdk-operate/SKILL.md`
- `gjc-sdk-author/SKILL.md`
- `gjc-sdk-author/templates/direct-sdk.ts`
- `gjc-sdk-author/templates/direct-sdk.py`

Regenerate with `bun run generate-sdk-skills`; CI checks byte-for-byte content
and rejects unexpected files with `bun run check:sdk-skills`.

### Bundle format version

`manifest.json` is the versioned root of the on-disk bundle contract. It
identifies `formatVersion` (currently `1`) and the exact relative file closure
that regeneration owns. Consumers must treat a bundle whose manifest is missing,
malformed, or declares an unsupported version as unreadable and fail closed. The
skill prompts are authored as static Markdown sources under
`scripts/gjc-sdk-skills/prompts/`; the generator copies them verbatim and
`check:sdk-skills` proves the committed bundle matches the generated artifacts.

### Trust boundary

The templates invoke only the broker-bound CLI. `SessionRouter` keeps endpoint
resolution, credentials, SDK clients, replay, reconnect, and rotation inside SDK
core. The templates' fixed allowlists and nonce-bound approval are trusted-local
procedural safeguards, not capability isolation; lifecycle and attachment
authority remain enforced by Broker and Router.

No renderer-grade cross-process event stream is exposed to external scripts.
Use managed adapters or Coordinator MCP for event-driven orchestration; see the
[RPC-to-SDK v3 parity audit](./sdk-rpc-parity-audit.md) for remaining gaps.

## Architecture

```
Broker lifecycle → Session runtime endpoint → SessionRouter → opaque adapter capability
```

The Broker is the sole lifecycle executor and durable terminal authority. `SessionRouter` is the sole credential-bearing external attachment manager. Provider supervisors own only provider transport and presentation state.

- **One endpoint per top-level session.** Each top-level session runs its own loopback WebSocket server. Subagents do not host endpoints. The Broker index is the authoritative live-session catalog, and `SessionRouter` multiplexes managed provider attachments across indexed sessions.
- **Hosted by default.** SDK hosting is independent of notification configuration. Set `GJC_SDK_DISABLE=1` to opt out of hosting for a top-level session.
- **Notification delivery is optional.** Configure and enable a managed notification adapter only when remote delivery is needed; the SDK endpoint remains available without one.
- **Managed integrations use opaque attachments.** Telegram, Discord, Slack, ACP, MCP, and CLI adapters compose SDK-core services; they do not discover endpoint files or receive URL/token credentials.
- **Zero wire-protocol change.** New transports do not require changes to `crates/gjc-sdk` or the JSON protocol.
- **tmux-agnostic.** The endpoint behaves identically with or without tmux.

## Internal endpoint publication

A running session publishes an implementation-private credential record for Broker resolution. `SessionRouter` is the sole consumer of the resolved URL/token pair and the sole owner of per-session SDK clients, replay, reconnect, rotation, prepared activation, and opaque attachment capabilities.

The record path, schema, credential transport, and handshake are not public client contracts. ACP, MCP, Coordinator, CLI, provider daemons, extensions, and integrations must use Router-issued attachments or Broker lifecycle services; they must not scan state roots, parse discovery files, retain endpoint credentials, or open raw per-session WebSockets. Broker and Router validate process identity, endpoint generation, incarnation, and file integrity before attachment, and fail closed on stale or uncertain state.

### Internal broker launch isolation

When the SDK starts its default internal broker or session host from the published TypeScript source, GJC uses a fixed Bun launch policy: `--no-env-file`, a product-owned empty `bunfig.toml`, absolute product entrypoint paths, and no inherited `BUN_OPTIONS` or mutable compiled-mode markers. The broker bootstraps from the product SDK directory rather than the caller project; a session host still runs with the lifecycle-authorized workspace as its process cwd.

This boundary prevents a child from newly loading caller-cwd or user-global Bun preload/dotenv policy. It cannot determine how a value already present in the parent environment was originally loaded, so ordinary provider/GJC environment values remain inherited. Default internal children, including compiled self-spawns, remove inherited `BUN_OPTIONS` so parent eval/test/inspect/debug/runtime options cannot be replayed into a detached child. Compiled binaries otherwise retain their existing self-spawn command contract, corroborated by a dedicated embedded marker and exact anchored Bun virtual-filesystem identity. The explicit `GJC_SDK_SESSION_COMMAND` session-host override remains a trusted legacy operator boundary and is not parsed as a shell-safe general command API. There is no broker-command override.

Broker and per-session discovery tokens remain in their authoritative private discovery files for SDK-core resolution. Launch errors, logs, and diagnostics redact those tokens and never include the child environment or isolation configuration contents.

## Internal protocol

The following frame shapes are SDK-core implementation details for maintainers.
External integrations must not construct these frames, attach to session
transports, or receive endpoint credentials; use a Router-issued attachment, the
broker-bound CLI, or Coordinator MCP instead.

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

- `id` is an opaque, transient presentation/action ID. It is the **only** authority accepted by generic `reply.id` through the current Router-issued attachment. It is not a durable workflow ID.
- `workflowGateId?: string` is optional, additive SDK v3 correlation metadata, present only for the active presentation of a durable workflow gate. When present, it equals that gate's Q12 `gate_id`. Its public correlation key is `(sessionId, workflowGateId)` on the current Router-issued attachment; it never authorizes generic `reply`.
- `kind: "ask"` is answerable in interactive/TUI and SDK workflow-gate sessions. `kind: "idle"` is notify-only and ephemeral (not replayed to attachments that start later). Ordinary asks and idle frames omit `workflowGateId`.
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

`bash_folded` — a foreground bash wait left the foreground and became a background job. Emitted once per fold into the replayable session event ring (so late-connecting clients receive it on `event_replay`), with `generic_safe` adapter disposition:

```json
{ "type": "bash_folded", "sessionId": "sess-1", "jobId": "bg_3", "generation": "bg_3:1", "reason": "steer" }
```

- `reason` is `steer` (a user steer arrived while the command had run past the 2 s grace window), `chord` (the `app.tool.backgroundFold` keybinding), `timer` (`bash.autoBackground`), or `sdk_control` (the `bash.background` control).
- A replayed frame may describe a job that has since finished. `runtime.jobs.list` is the source of truth: each running/recent job carries `metadata.backgrounded` and, whenever it is `true` because of a fold, `metadata.foldReason` with the same values. The `bash.background` control (C52) returns `{ backgrounded: true, jobId }` on a fresh fold, `already_backgrounded` when no wait is foldable but a running job of this session was already folded (by steer, chord, timer, or a prior control call), `no_active_bash` when nothing is running or foldable, and `not_foldable` when a live wait refused the fold.
- A `turn.steer` that folds a running bash behaves exactly like a TUI steer: the steer is consumed by the same turn at the tool boundary immediately after the fold result; `turn.steer_status` is unchanged.

The frames above are the internal transport contract implemented by SDK-core attachments. Managed adapters may receive optional server → client frames they can render or ignore: `identity_header` (one-time per-session repo/branch/machine header; Telegram topic-capable sessions additionally carry `telegramTopicsEnabled`), `context_update` (last message, task, goal, token usage, model, diff), `turn_stream` (live/finalized turn output), `image_attachment` (agent-produced images), `activity` (busy/idle, drives the typing indicator), `inbound_ack` (delivery state of an injected user message), `session_closed` (endpoint teardown; threaded adapters may delete/archive the remote conversation), `config_update` (current verbosity/redact), `hello` (server capability/version), and `pong`.

### Internal inbound frames

SDK core creates inbound frames only after Router attachment checks. External
integrations must not construct or persist them. Managed adapters use their
opaque `SessionAttachment`, and process-isolated scripts use `gjc sdk session`;
neither path receives transport credentials.

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
### Model profiles as synthetic models (`gajae-code/<profile>`)

The Q10 catalog also exposes model profiles as logical synthetic models under
the reserved provider namespace `gajae-code`, e.g. `gajae-code/codex-eco`.
These rows let clients (such as ACP model pickers) offer presets like ordinary
models without provider-specific metadata:

```json
{
  "provider": "gajae-code",
  "id": "codex-eco",
  "name": "Codex Eco",
  "contextWindow": 222222,
  "maxTokens": 8888,
  "reasoning": false,
  "thinking": { "validLevels": ["off"] },
  "current": false
}
```

- `gajae-code/<profile>` is a **logical namespace, not a callable provider**. No
  API transport, credentials, or streaming route is registered for it; send the
  value back through the generic `model.set` control (or the ACP `Model`
  select) to activate the profile.
- Synthetic rows are **availability-filtered**: only profiles whose required and
  alternative providers have usable stored credentials are listed. The profile
  id suffix is parsed losslessly after the first namespace slash, so profile ids
  containing additional slashes or punctuation round-trip exactly.
- `contextWindow`/`maxTokens` mirror the profile's resolvable default model when
  available and otherwise fall back to the shared unknown-model constants
  (222222 / 8888); the profile's real default model remains authoritative.
- Synthetic rows are non-reasoning with `validLevels: ["off"]`: a `model.set`
  on a synthetic id with any thinking level other than `off` is rejected with
  `invalid_input`, and only an absent or `off` level is forwarded as a session
  override.
- **Current-state semantics:** while a profile is active for the session, exactly
  the synthetic row carries `current: true` with `currentThinkingLevel:
  "inherit"`, and the underlying concrete row is not marked current. A persisted
  `modelProfile.default` alone (without an in-session active marker) never
  creates a synthetic current row. Selecting a concrete `provider/model` clears
  the active marker and restores concrete current semantics.
- **Selecting a synthetic profile is session-scoped.** `model.set` with
  `gajae-code/<profile>` activates the full profile in the live session without
  writing `modelProfile.default`, `modelRoles`, or
  `task.agentModelOverrides`. Persisting a profile remains an explicit TUI
  choice (`/model` → default), mirroring `gjc --mpreset <profile> --default`.
  Unknown or ambiguous synthetic ids fail with `invalid_input`; missing profile
  credentials fail with the existing authentication-required error.
- `gajae-code` is **reserved**: a user-defined `models.yml` provider of the same
  name disables the synthetic facade (rows are omitted and synthetic selection
  is rejected) rather than being silently shadowed. Q27 (`models.profiles.list`)
  remains the full profile catalog with explicit `available` status; Q10 is the
  availability-aware facade for client selection.
`config.patch` mutations are serialized through the same session admission
boundary as profile activation and default-model selection, so a patch racing
a synthetic `gajae-code/*` selection (or another patch) is applied in a
deterministic order and is never lost or clobbered by an activation rollback.
The cost is the same as `model.set`: an external `config.patch` queues behind
any in-flight prompt admission rather than applying mid-turn.

## Prompt acceptance, termination, and reconciliation (Q26)

`runtime.capabilities.promptTerminalOutcomeVersion` is `1` when this contract is available. Its normalized TypeScript terminal outcome is:

```ts
type SdkPromptTerminalOutcome =
	| {
			kind: "stopped";
			reason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
			provenance: "agent" | "client_cancel";
	  }
	| {
			kind: "failed";
			code: "prompt_failed" | "prompt_deadline_exceeded";
			message: string;
			provenance: "agent_failed" | "deadline";
	  };
```

`turn.prompt` returns `{ accepted: true, commandId, turnId, clientRef? }` only after
its asynchronous preflight accepts the prompt. That receipt is a durable,
**non-terminal pending claim**, not a process-durable terminal result. The SDK
later finalizes that claim with exactly one `SdkPromptTerminalOutcome`; cleanup
may follow only after the claim is durable.

The authoritative public reconciliation query is `Q26` / `turn.result`, scoped
to the same live session runtime. Callers supply `kind: "prompt"`; its `outcome`
field is exposed only after finalization. A pending claim is never represented
or exposed as a terminal outcome. `turn.prompt_status` remains a legacy
prompt-only alias that injects the same `kind`.

Every prompt and skill status response includes `receiptState`: active records are `absent`; terminal records are `present`, `missing`, or `unknown`; unknown lookup is `unknown`. Ordinary success requires `status: "terminal_ok"`, `receiptState: "present"`, and readable non-empty text or an artifact path. A failed execution may retain a partial `present` receipt. Legacy version-1 reconciliation records without this additive field remain readable and project `unknown` rather than optimistic success.

Callers that must recover from a lost acknowledgement should assign one fresh
`clientRef` (a trimmed, non-empty string of at most 128 characters) to each
logical prompt, then reconcile through the broker-bound CLI:

```sh
gjc sdk session raw query <sessionId> --query turn.result \
  --json-input '{"kind":"prompt","clientRef":"request-018f"}'
```

The alternate selector uses the same `kind` with
`{"kind":"prompt","commandId":"command-id","turnId":"turn-id"}` as its JSON input.

The result status is `accepted`, `in_flight`, `terminal_ok`, `failed`, or
`unknown`. Known records include `acceptedAt`; in-flight and terminal records add
`startedAt` and/or `terminalAt`; finalized records include `outcome`; failed records
also include a bounded sanitized `error.code` and `error.message`. Cursors, partial
generated-ID pairs, mixed selectors, and extra selector fields are rejected.

Correlated `agent_end` and `agent_failed` frames carry the same finalized
`outcome`. Clients must correlate those frames and Q26 by the prompt identifiers,
not infer terminality from stream activity or an earlier pending claim.

Reconciliation state survives client disconnect/reconnect. With the session-private durable store (`.sdk-reconciliation/`), accepted and terminal prompt records also survive **GJC session-process restart** for the same session identity within capacity, subject to crash-consistent fsync. A non-terminal prompt record at restart finalizes its pending outcome and receipt state. A stopped prompt without receipt evidence becomes `terminal_ok + missing`; failed prompt or skill settlement without body evidence becomes `unknown`. Eviction or absence still returns honest `unknown`; that means the prior outcome is unknowable, not that execution did not occur. Active records are capped at 128 per kind and are never aged into terminal. Terminal records are capped at 256 per kind and evicted oldest-terminal first, with no age-based eviction. Reconciliation stores no prompt, transcript, credential, or provider-response body.

`turn.prompt` remains ordered and non-idempotent. Its envelope `idempotencyKey`
does not replay a response or produce `idempotency_conflict`. A retained duplicate
`clientRef` fails before execution with `client_ref_conflict`, but callers must not
reuse a `clientRef` as a retry mechanism: after eviction the same value can identify
a new prompt while the old outcome remains unknown.

`turn.abort` returns a typed disposition. A caller that does not own the target
receives `resource_gone`; it must not treat that result as cancellation of another
prompt.

`sdk.promptDeadlineMs` defaults to `1_800_000`. It accepts only safe integers in
`[60_000, 86_400_000]`; there is no disable value. The SDK snapshots the setting
when the prompt is durably accepted as the initial inactivity lease. Fresh
**attributable** progress for the exact accepted `commandId`/`turnId` — `tool_execution_start` /
`tool_execution_end` observed at the prompt/agent runtime boundary — renews the deadline to
`lastProgressAt + sdk.promptDeadlineMs`, bounded by the hard maximum `sdk.promptMaxRuntimeMs`
(default `21_600_000`, same `60_000–86_400_000` range). Only tool-execution boundaries for the
accepted turn count; heartbeats, streaming text/thinking deltas, retries, other turns/sessions, and
unrelated session noise do not renew the lease, and out-of-order delivery never shortens it. The
hard maximum is never unbounded: every renewal is capped at `acceptedAt + sdk.promptMaxRuntimeMs` so a
wedged or continuously noisy prompt still reaches a deterministic terminal outcome. Terminalization then has a fixed `10_000` ms
grace period, which is not configurable. A controlled terminal failure reaches ACP
as JSON-RPC `-32603` with `data.code` of `prompt_failed` or
`prompt_deadline_exceeded`.

## Skill invoke reconciliation

`skill.invoke` accepts optional `clientRef` and returns an early accepted receipt
`{ accepted: true, commandId, turnId, clientRef?, name, path, lineCount?, args? }` after
durable/preflight accept (SDK control path), not after skill completion. Query prior
status with `Q26` / `turn.result` and `kind: "skill"`. `skill.invoke_status`
remains a legacy skill-only alias that injects the same `kind`. Kind-scoped indexes
mean prompt and skill `clientRef` values never collide. Skill records use the same
capacity/retention limits, but an active skill record at restart settles with
`error.code = process_restart`.

## Correlated steer acknowledgement (Q30)

`turn.steer` accepts an optional `clientRef` (trimmed, non-empty, at most 128 characters). When present, GJC hashes the exact validated steer text with SHA-256 and durably reserves `dispatching` before queueing. The result contains `sessionId`, `clientRef`, `status: accepted | rejected | uncertain`, known `acceptedAt` or `terminalAt`, and bounded error metadata; it never echoes text.

Replay the same `clientRef` with the same text to recover the retained result without dispatching again. Reuse with different text returns `client_ref_conflict`. A live `dispatching` record and a restart during dispatch both project `uncertain`; GJC never automatically redispatches an ordered control whose first effect is unknowable. Query the same session with:

```json
{ "type": "query_request", "query": "turn.steer_status", "input": { "clientRef": "steer-018f" } }
```

Q31 returns `accepted`, `rejected`, `uncertain`, or `unknown` and never dispatches work. Settled steer records share the 256-record oldest-terminal-first capacity bound with no age-based eviction; live dispatching records are not terminal-evicted. Existing uncorrelated `turn.steer` calls retain their legacy non-idempotent behavior. Version-1 reconciliation remains additive, and only digest plus bounded metadata is stored—never steer text.

## Model profile discovery and validation (Q27)

`Q27` / `models.profiles.list` pages the effective model-profile catalog owned by
the attached session. Rows are sorted by exact ID and contain only:

```json
{ "id": "codex-medium", "displayName": "codex-medium", "source": "builtin" }
```

`source` is `builtin` or `configured`. Profiles from `<agentDir>/models.yml`
override built-ins with the same exact ID, including their display label. Profile
IDs are not trimmed, case-folded, sanitized, or restricted to safe-token names;
discover the exact ID and send it unchanged. The retired `codex-standard` alias is
fallback-only and never shadows a configured profile with that exact ID.

Q27 uses retained-revision, connection-bound pagination. Continue an issued cursor
to finish its stable snapshot; a fresh cursorless query observes the current
registry. The query accepts no root, path, or selector input. An invalid or
unreadable `models.yml` fails closed with `model_profile_registry_error` rather
than returning a plausible built-ins-only catalog.

Broker `session.create`, `session.fork`, and `session.resume` validate `modelPreset`
before spawning against the same `<broker.settings.agentDir>/models.yml` authority
that the child receives through `GJC_AGENT_DIR` / `GJC_CODING_AGENT_DIR`. Unknown
IDs return `unknown_model_profile`. Both typed errors include bounded `details`
with `requestedProfile` where applicable, whole exact `availableProfiles` entries
that fit the detail budget, and `discoveryQuery: "models.profiles.list"`. The
discovery pointer is authoritative when the bounded error cannot include every ID.

The same lifecycle operations accept an optional `modelId`: an explicit
`provider/model` pin with `gjc --model` grammar (#4707). Coordinators resolve it
against the full model registry (the CLI `--model` surface, not the
authenticated-only subset) before sending the create request, so unknown ids are
rejected before any session exists. The broker guards only its shape; the child
applies it exactly like a CLI `--model` selection, which also means an explicit
`modelId` wins over `modelPreset` when both are supplied — the same precedence as
`gjc --mpreset <profile> --model <model>`. The full effective order is:

```
modelId pin  >  modelPreset  >  configured modelProfile.default  >  role/resume/default
```

The pin is a guarantee, not a preference. The coordinator validates against its
own registry and the child owns the registry that actually serves requests, so
the two can drift (a model removed, a provider disabled, an extension that
failed to register). On drift the child fails session construction before
readiness and before any profile application, disposes the partial session, and
reports an error naming the pinned selector — it never publishes success on a
substituted model. Coordinator validation refreshes the registry per request
(offline, from the on-disk discovery cache) so ids added or removed after an
earlier pin are judged against current contents.

### Active provider query (Q29)

`Q29` / `providers.list/active` pages the providers currently eligible for model
selection through the same authenticated, retained-snapshot envelope as Q10. Each
row is the non-secret DTO `{ provider, connectionKind }`, where `connectionKind`
is `credential` or `credentialless`.

Provider IDs are returned exactly as they appear in Q10 `model.provider`: existing
mixed-case, spaced, punctuated, and long custom IDs are preserved without aliases
or normalization. Rows are deduplicated and ordered by UTF-8 provider bytes.
Join Q29 to Q10 by exact provider ID; Q10 remains the full configured catalog.

A credentialed discovery-only provider appears only after fresh discovery proves
the exact model is usable. Static configured models can appear without a network
probe. The query never invokes a model, refreshes credentials, probes a remote
account, or exposes credentials, account metadata, paths, or provider responses.

Resolver failures are atomic and return
`{ "code": "internal", "message": "Unable to resolve active providers." }`.
They omit a page and restart metadata. An expired continuation follows the shared
cursor contract and returns `error.code: "cursor_expired"` with
`error.restartQuery: true`. Malformed cursor strings return `invalid_cursor`;
cross-query or selector mismatches return `invalid_input`.

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

`workflow.gate_answer` and `workflow.plan_approve` operate on the durable Q12
`gate_id`, not `action_needed.id`. Managed adapters bind `expectedSessionId`
from their current Router-issued attachment. Process-isolated operators use the
raw-control flow documented in the [SDK session CLI guide](./sdk-session-cli.md); they do not construct protocol frames.

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

## Minimal provider adapter example

Provider integrations compose SDK core's `SessionRouter`; they never read endpoint files or retain URL/token credentials:

```js
import { router } from "@gajae-code/coding-agent/sdk";

const sessionRouter = new router.SessionRouter({
  agentDir,
  deps: {
    onAttachment: (attachment) => provider.bind(attachment.sessionId, attachment),
    onFrame: (attachment, frame) => provider.render(attachment.sessionId, frame.body),
    onSessionRemoved: (attachment) => provider.unbind(attachment.sessionId),
  },
});

await sessionRouter.start();
const attachment = sessionRouter.attachment(sessionId);
if (!attachment) throw new Error("session attachment unavailable");
await attachment.send({ type: "reply", id: actionId, answer });
```

Telegram, Discord, Slack, and third-party adapters own only their provider transport and presentation state. `SessionRouter` performs exact endpoint resolution, credential custody, replay, reconnect, rotation, and dispatch-time stale-lease rejection.

### Exact generation reconciliation

Managed consumers that close or delete a session can reconcile one previously
persisted attachment generation without retaining endpoint credentials:

```ts
const proof = await sessionRouter.generationStatus(sessionId, endpointGeneration);

switch (proof.status) {
  case "current":
    // This exact generation is the current live indexed authority.
    break;
  case "retired":
    // A retained host-unregister, close, or delete event positively retired it.
    break;
  case "replaced":
    // A different live generation is current; use proof.currentGeneration.
    break;
  case "unknown":
    // Do not infer retirement or retry a possibly-applied lifecycle mutation.
    break;
}
```

`generationStatus(sessionId, endpointGeneration)` is credential-free and may be
called after `SessionLifecycleService` returns from `session.close` or
`session.delete`, and after `SessionRouter.stop()`. Its evidence contains only
`source: "session_index"`, a coherent `observedIndexSeq`, the successful
state's `evidenceIndexSeq`, and, for positive retirement, the safe terminal
event kind. It never exposes endpoint URL/token data, process IDs, locators,
private Broker responses, or lifecycle cleanup payloads.

The result is an observation of one locked index reconciliation cut:

- `current` requires the queried generation to be the current live, unambiguous
  indexed authority.
- `retired` requires a retained exact-generation `host_unregistered`,
  `session_closed`, or `session_deleted` event. Missing attachment, missing
  endpoint publication, Router shutdown, or a dead/unreachable host never imply
  retirement.
- `replaced` requires both prior observation of the queried generation and a
  strictly greater current live generation. Same-generation reconnect remains
  current; reuse, regression, or safe-integer wrap is classified as unknown
  rather than manufacturing a successor relationship.
- `unknown` is fail-closed. Reasons distinguish invalid input, unavailable or
  incomplete index reconciliation, an unobserved session/generation, ambiguous
  authority, and detected generation reuse. Consumers must preserve uncertain
  lifecycle state rather than treating `unknown` as retired. Expired positive
  evidence is reported specifically as `proof_expired`.

Proof survives Broker, Router, and consumer process restart because it is read
from the durable session index, not Router attachment memory. Positive terminal
proof has the session-index `maxAgeMs` lifetime (30 days by default), even when a
delete tombstone is retained longer for audit. Row-bound compaction may evict a
whole session sooner. After proof expiry, compaction eviction, or loss of a
complete index, `generationStatus` returns `unknown`, never a synthetic
retirement proof. This bounds the public proof surface independently of durable
Broker audit retention.

## Fallback chains

Model-role selectors may be ordered fallback chains; see [Fallback chains](./models.md#fallback-chains) for configuration and retry-budget details. Resolution-time skips do not consume attempts. When a request-time retry advances to another eligible entry, the selected default fallback remains sticky for later prompts in that session until an explicit model selection or a chain reset changes it.

`model_fallback_switched { eventId, from, to, reason, role, scope, activeIndex, chainLength, attemptsUsed }` is the canonical session lifecycle event for every real fallback-model switch. It replaces the legacy `retry_fallback_applied` / `retry_fallback_succeeded` event names. Embedding clients can subscribe to this in-process session event; managed adapters receive only the status projections their SDK-core integration supports.


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

GJC ships managed SDK adapters for Telegram, Discord, and Slack. `SessionRouter` resolves one session-owned endpoint per attachment and keeps every endpoint credential inside SDK core. Provider daemons receive only opaque attachment capabilities; they neither change the wire protocol nor expose a remote shell.

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

Configuration completeness, provider-local quarantine, durable desired intent, effective enablement, runtime readiness, and delivery outcomes are separate contracts. The global `notifications.enabled` master never erases provider credentials or desired flags. `/settings` edits secrets through explicit `keep`, `replace`, or `remove` actions, commits only the selected provider in one CAS batch, and reports post-commit observer or activation failures without pretending the durable save rolled back. Malformed provider-local values are quarantined for explicit repair while safe sibling providers remain usable; malformed global notification structure remains fail-closed.

`GJC_NOTIFICATIONS=0` suppresses only automatic generic current-session admission. Explicit `/notify on` can opt the current session back in without mutating durable provider state, and direct provider APIs remain governed by provider effectiveness and their own runtime readiness. Telegram, Discord, and Slack attachments are reconstructed through `SessionRouter`; no provider receives the shared endpoint token.

- [Telegram notification onboarding](./telegram-onboarding.md) documents
  `gjc notify setup` and private-chat pairing.
- [Discord notification onboarding](./discord-onboarding.md) documents
  `gjc notify setup discord`, required configuration, thread lifecycle, and
  least-privilege permissions.
- [Slack notification onboarding](./slack-onboarding.md) documents
  `gjc notify setup slack`, Socket Mode configuration, immediate envelope ack,
  and thread lifecycle.

`gjc notify status` reports provider completeness, repair/quarantine state, desired intent, effective enablement, and masked tokens. Destination identifiers remain visible and may be sensitive. The Discord and Slack setup commands are non-interactive and require their documented identifier and token flags; supply secrets through an approved local mechanism, not examples, committed files, shell history, logs, or chat. `gjc notify health --provider <provider> --probe` performs a provider-owned REST diagnostic even when complete credentials are intentionally inactive, while `gjc notify test --provider <provider>` additionally requires effective enablement and runtime readiness.

Session lifecycle and attachment routing are SDK-core services shared by every
chat provider. `SessionLifecycleService` authorizes typed create, fork, resume,
close, delete, and list requests, derives the Broker idempotency identity, and
projects credential-free outcomes. The Broker remains the only lifecycle
executor and durable terminal authority.

`SessionRouter` consumes the Broker `SessionIndex`, resolves exact endpoint
authority, retains endpoint credentials and SDK clients, and owns replay,
reconnect, rotation, and stale-attachment revocation. Telegram, Discord, and
Slack receive only opaque current-generation attachments. Provider daemons own
transport leases, cursors, rate limits, threads/topics/messages, presentation
journals, and delivery receipts; they cannot read endpoint files or tokens,
allocate SessionIds, or perform session process lifecycle effects.


## Managed Telegram daemon (bundled reference client)

The managed Telegram client is a provider supervisor and presentation adapter.
It owns the single `getUpdates` poller and Telegram topic state, while
`SessionRouter` reconstructs SDK attachments from Broker state. A provider
restart never creates, resumes, closes, or mutates a GJC session by itself.

For Telegram forum topics, the daemon deletes the presentation topic through
`deleteForumTopic` (falling back to `closeForumTopic` when deletion is unavailable)
when `SessionRouter` retires the current attachment or when the daemon confirms
that no eligible local session still owns the topic. A resumed session creates or
rebinds a fresh current-generation topic before sending again. Topic cleanup is
best-effort and cannot change the Broker lifecycle result.

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

The paired private chat prefers Telegram topics for coordinator/lifecycle sessions
(Threaded Mode). The daemon tags messages by session, stores compact callback
aliases for inline buttons, and routes replies back to the exact session/action.
Ordinary sessions use flat delivery and do not create topics. A forum-enabled
supergroup is no longer required: when the bot owner enables Threaded Mode in
@BotFather, the daemon creates topics only for admitted orchestration sessions.
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
Because the flat private chat has no per-session topic, flat idle markers carry
a short session tag (`🟢 Agent idle · <tag>`, last six characters of the session
id) so concurrent sessions stay distinguishable. The tag never appears on asks
or in threaded/topic delivery, where the topic itself identifies the session.

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

## Session lifecycle and attachment surfaces

SDK core exposes two related provider-neutral capabilities:

1. **`SessionLifecycleService`** accepts an authenticated actor, an explicit
   operation capability, a stable caller request key, and a typed target. It
   derives one Broker idempotency key and invokes the canonical Broker lifecycle
   operation. Results never expose endpoint URLs, tokens, process identities,
   cleanup paths, or raw Broker receipts.
2. **`SessionRouter`** owns live attachment discovery and transport. It validates
   the exact indexed endpoint generation, keeps credentials and `SdkClient`
   instances private, replays from the attachment cursor, reconnects after
   rotation, and revokes stale capabilities. Provider-facing attachments expose
   only `sessionId`, `generation`, `isCurrent()`, and `send()`.

### Dispatch-boundary observers (managed router path)

`SessionRouter.request(sessionId, frame, expectedGeneration?, expectedAttachment?, options)`
accepts two optional synchronous observers in `options` — the supported
dispatch-boundary surface for transport-close-aware consumers (#4640):

- **`beforeDispatch(context)`** — fires immediately before the wire write.
  Throwing (or any synchronous failure) aborts the dispatch with nothing on the
  wire, no sent record, and a retryable rejection carrying the caller's own
  error. Returning a thenable (e.g. an `async` function) is a contract
  violation: the dispatch aborts pre-send and the eventual rejection is sunk.
- **`onDispatch(context)`** — fires synchronously immediately after the frame is
  handed to the socket, never before. `context.frame.id` is the exact correlated
  identity a response must carry; from this point a transport close before the
  response settles the request as `uncertain_after_send`. Observer throws and
  returned-thenable rejections are sunk; they can neither displace settlement
  nor reach the process unhandled-rejection channel.

The observer `context.frame` is a **deep-frozen, credential-redacted copy**: the
injected session endpoint `token` (and any other credential field) exists only
on the internal wire frame and is never handed to observer code, and mutation
attempts throw in strict mode. The raw credential-bearing `SdkClient` remains
unexported (`./sdk/client` is blocked in the package export map); the router is
the only supported path to this boundary.

There is no daemon-owned lifecycle control endpoint, provider lifecycle ledger,
notification-root scanner, or provider-created SessionId. Telegram `/session_*`
commands call the SDK lifecycle service directly. A Telegram update or topic
reservation supplies the stable provider request identity; the Broker allocates
the SessionId, and Telegram CAS-binds the returned opaque ID to its presentation
mapping.

### Lifecycle trust and recovery

- paired provider identity and operation capability are checked before the
  Broker call;
- retries reuse the same provider request key, so one request produces one
  Broker ledger identity and at most one lifecycle effect;
- `terminal_uncertain` remains uncertain and is reconciled from Broker ledger,
  effect marker, process incarnation, endpoint/index, readiness, and exact
  cleanup evidence only;
- provider transport restart reloads cursor and presentation state, while the
  Router reconstructs attachments from Broker state;
- stale endpoint generations and attachments fail closed;
- provider topic/thread/message cleanup cannot rewrite a confirmed lifecycle
  outcome.

### Phone test guide (create / close / resume from Telegram)

End-to-end manual check once `gjc notify setup` has paired your private chat:

1. Run `gjc notify setup` and start or reload the Telegram provider supervisor.
   The supervisor owns only the Telegram poller and presentation state.
2. Send `/session_create path <repo-dir>`, `/session_create worktree <repo>
   <branch>`, or `/session_create dir <newdir>`. The SDK lifecycle service submits
   one canonical Broker create request; the bot reports the credential-free
   outcome.
3. `/session_recent` lists verified recent managed sessions.
4. `/session_close <sessionId>` asks Broker lifecycle to close the exact managed
   session and preserves history.
5. `/session_resume <sessionId|prefix>` resolves verified managed history,
   reattaches a live session or performs canonical Broker resume, and refuses
   ambiguous prefixes.

Commands are accepted only from the paired chat. Duplicate Telegram updates and
replayed topic reservations reuse their original request identity; they never
allocate or spawn a second session.

## Master mode surfaces

`gjc --master [--scope repo|pwd|global]` launches an interactive-TUI-only
master session (default scope `repo`). The master receives one bundled
operating-guidance block appended after custom system-prompt transformation and
exactly one scoped, no-probe broker peer snapshot immediately before its first
accepted provider request; idle masters collect nothing.

Master orchestration is broker-routed and best effort: scoped discovery via
`gjc sdk search` (result-level scope envelopes, exact worktree/cwd identity,
no scope fallback) and task-seeded children via the local-only `gjc sdk spawn`
(see docs/sdk-session-cli.md). The broker is the sole authority for
master-created lifecycle: an opaque idempotency identity serializes each spawn
behind a durable create-or-join claim, seed delivery is Q26-correlated (never
blindly re-sent), close mutates only an exactly re-proven substrate, and
orphaned children converge through ordinary close after
`sdk.masterOrphanGraceMs`. Task text and master capability are transient
dispatch inputs and never persist in any durable store, log, or output.
