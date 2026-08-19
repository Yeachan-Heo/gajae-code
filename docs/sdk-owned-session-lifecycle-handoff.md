# SDK-owned session lifecycle handoff

## Status

**Superseded (2026-08-19, issue #4530).** The SDK-owned lifecycle/attachment authority described below was extracted from `dev` under owner contract A (stub-and-preserve): `SessionRouter` is now a direct-attachment router without the broker-index attachment authority machinery, behind the identical exported surface. The coherent implementation is preserved on the durable ref `preserve/issue-4530-dev-06f0d4d` and is re-presented against post-revert `dev` as an owner-controlled Draft PR. This document remains as the historical record of the extracted design.

- Extraction issue: #4530
- Preservation ref: `preserve/issue-4530-dev-06f0d4d` (at `06f0d4d67eeaa5ea7a8a2a0976afdfa8c1eaf155`)

Historical status at authoring:

- Branch: `refactor/sdk-owned-session-lifecycle`
- Worktree: `../gajae-code.gajae-code-worktrees/refactor-sdk-owned-session-lifecycle`
- Base: `origin/dev` at `31c00c2d5bb462464046208a94a4597c27260a4c`
- Review target: `dev`
- Verdict: sound direction, with a required ownership qualification

## Decision

GJC SDK core must be the sole authority for coding-agent session lifecycle and external session attachments. Provider daemons must not create, resume, close, delete, signal, recover, or allocate identities for GJC sessions.

> SDK core owns session lifecycle and attachment authority. Provider supervisors own provider transport authority.

Telegram `getUpdates`, Slack Socket Mode, Discord Gateway, provider cursors, rate limits, and provider topic/thread/message state remain provider-owned because they are external transport and presentation resources, not AgentSession lifecycle resources.

## Problem

The Broker and per-session SDK runtime already provide lifecycle idempotency, target serialization, a durable lifecycle ledger, startup admission, process-incarnation fencing, effect markers, readiness proof, endpoint-generation checks, exact cleanup evidence, and honest `terminal_uncertain` outcomes.

The chat-daemon path nevertheless has a second set of session authorities:

- daemon-owned lifecycle control server, credential, pending table, and sequence;
- chat lifecycle ledger and audit path;
- tmux/session spawn, close, and resume effects;
- intended session-ID allocation before Broker creation;
- notification-root registration as the provider discovery universe;
- direct endpoint discovery, credentials, reconnect, and action routing.

A provider crash can therefore occur between provider-ledger persistence, Broker-ledger persistence, process effects, endpoint publication, and topic binding. Authority is divided by ingress process instead of by the mutated resource.

## Non-goals

- Do not move provider transport ownership into the Broker.
- Do not weaken incarnation, generation, effect-marker, readiness, or exact-cleanup checks.
- Do not add a compatibility lifecycle executor or dual writer.
- Do not infer completion from terminal output, tmux, or provider delivery state.
- Do not make topic/thread cleanup part of session lifecycle terminality.

## Current ownership

### Broker and lifecycle executor

Primary files:

- `packages/coding-agent/src/sdk/broker/broker.ts`
- `packages/coding-agent/src/sdk/broker/lifecycle.ts`

Retain and strengthen:

- Broker root lock/discovery/heartbeat;
- `SessionIndex` and `LifecycleLedger`;
- lifecycle idempotency and target serialization;
- create/fork/resume/close/delete execution;
- worktree, transcript, and managed-session validation;
- effect marker and process-incarnation evidence;
- readiness and endpoint-generation proof;
- close escalation and exact cleanup reconciliation.

The Broker lifecycle executor becomes the only executor and durable terminal authority for session lifecycle mutations.

### Per-session SDK runtime

Primary file: `packages/coding-agent/src/sdk/host/session-runtime.ts`.

Retain:

- AgentSession-local host/transport startup and shutdown;
- endpoint URL, token, and generation publication;
- control, query, event, replay, and reverse-provider semantics;
- readiness and activation;
- exact generation registration and unregistration with Broker.

The runtime owns live local resources; Broker owns the global transaction and permission to create or retire the runtime.

### Provider-owned transport and presentation

Retain outside SDK session lifecycle:

- provider credential/account fingerprint;
- one active provider poller or connection;
- cursor, conflict handling, rate limit, retry, and backoff;
- topic/thread/message/callback/attachment state;
- provider delivery receipts and presentation reconciliation;
- provider process lease, heartbeat, restart, and shutdown.

### Authority to remove from Telegram/chat daemon

Primary files:

- `packages/coding-agent/src/sdk/bus/telegram-daemon.ts`
- `packages/coding-agent/src/sdk/bus/lifecycle-orchestrator.ts`

Remove:

- lifecycle control server ownership;
- lifecycle endpoint credential and pending request ownership;
- chat-owned lifecycle outcome ledger;
- tmux/process lifecycle effects;
- logical SessionId allocation or preallocation;
- direct endpoint credentials and endpoint discovery;
- provider-owned session discovery roots;
- provider-specific endpoint-generation and reconnect authority.

Provider update IDs may remain idempotency inputs, but not a second lifecycle result ledger.

## Target architecture

```text
Provider boundary
┌─────────────────────────────────────────────────────────────┐
│ ChatDaemonSupervisor                                        │
│  provider lease, poller/connection, cursor, retry/rate limit│
│                                                             │
│ ProviderAdapter                                             │
│  provider update → ChatIntent                               │
│  PresentationEvent → provider payload                       │
│  topic/thread/message/callback mappings                     │
└────────────────────────┬────────────────────────────────────┘
                         │ opaque intents/events
                         ▼
SDK core
┌─────────────────────────────────────────────────────────────┐
│ SessionRouter                                               │
│  Broker-index discovery, endpoint credential custody,       │
│  SDK connections, replay/reconnect, attachment leases,      │
│  prompt and ask-answer routing                              │
│                                                             │
│ SessionLifecycleService                                     │
│  actor/capability authorization, canonical requests,        │
│  idempotency namespace, lifecycle certainty                 │
│                                                             │
│ Broker                                                      │
│  one ledger, one executor, index, process/effect recovery   │
│                                                             │
│ SessionSdkSessionRuntime                                    │
│  AgentSession, endpoint generation, controls/events/teardown│
└─────────────────────────────────────────────────────────────┘
```

Dependency direction:

```text
ProviderAdapter
  → SessionRouter
  → SessionLifecycleService
  → Broker
  → SessionSdkSessionRuntime
```

Forbidden paths:

- Broker/runtime depending on provider concepts;
- provider adapter calling Broker lifecycle internals;
- provider adapter invoking tmux or process signals for session lifecycle;
- provider adapter reading endpoint files or tokens;
- provider adapter generating SessionIds;
- provider state participating in Broker recovery proof.

## Target components

### SessionLifecycleService

Recommended under `packages/coding-agent/src/sdk/lifecycle/`. It is a provider-neutral facade over existing Broker operations, not another state machine or ledger.

Responsibilities:

- authenticated actor and explicit capability input;
- operation-specific authorization;
- canonical lifecycle request normalization;
- idempotency derived from actor namespace, caller request key, operation, and target;
- invocation of the existing Broker path;
- bounded lifecycle result and certainty;
- no provider, topic, thread, tmux, or shell concepts.

### SessionRouter

Recommended under `packages/coding-agent/src/sdk/router/`.

Responsibilities:

- consume Broker `SessionIndex` snapshots and index sequence;
- resolve exact endpoint authority through Broker;
- remain the sole non-runtime holder of endpoint credentials;
- own SDK connections, event replay, and reconnect;
- revoke attachment leases when endpoint/index/router generation changes;
- route provider-neutral prompts and answers through standard SDK operations;
- reconcile prompt acceptance and terminal outcomes;
- emit provider-neutral presentation events;
- never perform process lifecycle effects.

Attachment authority must bind session identity, endpoint generation/incarnation, and router epoch. Its provider representation should be opaque.

### ChatDaemonSupervisor

Owns only the provider-account process lease, poller/connection, cursor, API retry/backoff/rate limits, and independent provider restart/shutdown. It never creates, resumes, closes, or signals a GJC session.

### ProviderAdapter

Validates inbound provider identity, normalizes `ChatIntent`, renders `PresentationEvent`, owns provider-created presentation bindings and delivery receipts, and stores returned SessionIds only as opaque mapping keys.

## Ownership matrix

| Authority | Creator | Mutator/retirer | Persistence | Provider role |
|---|---|---|---|---|
| Logical SessionId | Broker lifecycle | Broker lifecycle | Broker/managed session | Store returned opaque ID |
| Lifecycle idempotency | Service derives, Broker records | Broker ledger | `LifecycleLedger` | Supply stable request identity |
| Broker root lease | Broker | Exact owner | lock/discovery/heartbeat | None |
| Effect marker | Broker | Broker | ledger/lifecycle artifacts | None |
| Process incarnation | OS, observed by core | Immutable | effect evidence | None |
| Endpoint URL/token/generation | Session runtime | Session runtime | endpoint/index | Must not receive |
| Attachment lease | SessionRouter | SessionRouter | Prefer ephemeral | Use opaque handle |
| Provider transport lease | Supervisor | Supervisor | provider state | Full owner |
| Provider cursor/rate state | Supervisor | Supervisor | provider state | Full owner |
| Topic/thread/message binding | Adapter | Adapter CAS | provider mapping | Full owner |
| Session lifecycle result | Broker | Broker ledger | `LifecycleLedger` | Read only |
| Provider delivery result | Adapter | Adapter | provider delivery state | Cannot alter lifecycle |

## Lifecycle flows

### Create

1. Adapter validates provider identity and policy.
2. Existing topic/thread adoption creates a provider-local reservation keyed by `providerRequestKey`, not a SessionId.
3. Adapter sends a create intent to Router.
4. Router calls lifecycle service with actor, capability, target, and stable idempotency.
5. Broker begins the sole ledger entry, allocates SessionId, records effect identity, spawns, and proves readiness.
6. Router attaches to the exact endpoint authority.
7. Adapter CAS-binds its reservation to the returned SessionId.
8. Retry of the same provider request returns the same Broker result and cannot spawn another session.

### Attach

Router reads Broker index, resolves exact generation/incarnation, opens the authenticated SDK connection, replays from its cursor, and issues an attachment lease. Provider stores only the opaque attachment and presentation mapping.

### Prompt and ask answer

Adapter sends an authenticated intent with provider request identity and attachment lease. Router validates authority and invokes standard SDK controls. Runtime reconciliation remains authoritative for accepted, in-flight, terminal, unknown, and one-shot answer outcomes. Provider retries query/replay rather than duplicate effects.

### Close

Adapter submits intent only. Lifecycle service authorizes and Broker persists the effect, uses the exact endpoint first, escalates only with incarnation/effect fencing, and requires unregister, endpoint removal, and process-exit proof. Router revokes attachments. Provider presentation cleanup happens afterward and cannot make a confirmed close uncertain.

### Resume and endpoint rotation

Broker validates saved-session ownership and returns an exact live endpoint or performs canonical spawn/readiness. Runtime owns token/generation rotation and Broker registration. Router revokes old leases, resolves the new endpoint, reconnects, and replays. Provider never receives old or new credentials.

### Provider restart

Supervisor reacquires only provider transport authority and reloads cursor/presentation state. Router reconstructs attachments from Broker index. Provider restart alone never creates, resumes, closes, or mutates a session. Submitted operations replay through the same Broker idempotency identity.

### Broker/runtime recovery

Broker reconciles only from its ledger, effect markers, process incarnation, endpoint/index registration, readiness/failure records, and exact cleanup evidence. Provider records are never lifecycle proof. Unprovable effects remain `terminal_uncertain`.

## Migration plan

Each stage cuts over one authority and deletes the obsolete path in the same logical change. No dual writers or fallback executors.

### Stage 1: canonical lifecycle service

- Add provider-neutral lifecycle service over existing Broker operations.
- Define actor/capability, canonical request, idempotency, and certainty contracts.
- Reuse `Broker.handleRequest`, `executeLifecycle`, and `LifecycleLedger`.
- Add focused authorization, replay, conflict, and uncertainty tests.

### Stage 2: chat lifecycle cutover

- Route Telegram create/close/resume through Router and lifecycle service.
- Preserve provider parsing, authentication, policy, and rendering.
- Remove daemon lifecycle server, token, client, pending table, request sequence, chat lifecycle ledger/audit, and tmux/process effects.
- Verify one chat operation creates one Broker ledger identity.

### Stage 3: remove provider SessionId allocation

- Replace `intendedSessionId` with a provider-local reservation keyed by provider request identity.
- CAS-bind the provider resource to the Broker-returned SessionId.
- Test crashes before Broker call, after Broker intent, after readiness, and before binding.

### Stage 4: SDK-owned SessionRouter

- Route discovery through Broker index and exact endpoint resolution.
- Move credentials, connections, replay, reconnect, and attachment generation into Router.
- Introduce opaque attachment leases.
- Remove notification-root registration, provider root scanning, and direct endpoint access.

### Stage 5: provider supervisor/adapter boundary

- Retain provider lease, cursor, connection, retry/backoff, rate limits, delivery, mappings, callbacks, and attachments.
- Apply the Router contract to Telegram, Discord, and Slack.
- Remove provider edges to lifecycle execution, tmux, process signaling, Broker cleanup, and endpoint credentials.

### Stage 6: singular recovery and deletion

- Broker owns lifecycle recovery.
- Router reconstructs attachments.
- Provider supervisor reconstructs only transport and presentation.
- Delete obsolete lifecycle orchestrator/control-runtime modules.
- Leave no feature flag, dual writer, silent fallback, or compatibility shim.

## Required invariants

1. Only Broker lifecycle may spawn, signal, close, resume, delete, or persist lifecycle terminality.
2. Provider retry cannot create two sessions or effects.
3. Stale endpoint/router/attachment authority cannot submit prompt or answer.
4. Provider transport failure or restart cannot mutate session lifecycle.
5. Provider presentation state is recoverable but non-authoritative.
6. Endpoint credentials remain inside runtime, Broker resolution, and Router.
7. Provider cleanup failure cannot rewrite a lifecycle result.
8. Recovery cannot signal or delete a successor process, endpoint, or transcript.
9. Prompt acceptance remains distinct from completion.
10. Timeout never invents success or failure.

## Verification

### Static architecture gates

Fail provider modules that import lifecycle execution internals, tmux/session process lifecycle, process signals for session lifecycle, direct endpoint discovery/credentials, or logical SessionId generation.

### Crash matrix

Inject provider-triggered create failures after reservation, lifecycle admission, Broker ledger begin, effect persistence, child spawn, endpoint publication, readiness/index registration, and provider binding. Retry must produce one SessionId, one effect identity, at most one live owned process, and one Broker result.

### Endpoint rotation

Render work under generation N, rotate to N+1, reject the N lease, reconnect through Broker exact resolution, and replay without duplicate prompt or answer effects.

### Provider restart

Restart the supervisor during active prompt, unanswered ask, create, close, and endpoint rotation. Broker/process/runtime evidence changes only for operations already submitted; provider delivery alone is reconciled.

### Close and cleanup

Confirm close independently of topic/thread deletion. Exercise PID reuse, endpoint replacement, stale index generation, and exact cleanup races. Preserve `terminal_uncertain` when proof is unavailable.

### Credential boundary

Router/adapter payloads and provider state must not contain endpoint URL/token, Broker token, or lifecycle effect credentials.

Start focused verification with `packages/coding-agent/test/sdk-broker-lifecycle-e2e.test.ts`, Telegram ownership/lifecycle/restart/reconciliation suites, SDK host/runtime lifecycle tests, Coordinator lifecycle/idempotency tests, and ACP create/load/resume/cancel tests when shared paths change.

## Implementation order

Prefer atomic commits:

1. lifecycle-service contract and tests;
2. Telegram lifecycle cutover and old server/ledger deletion;
3. provider reservation and Broker-owned SessionId;
4. Router contract and direct endpoint-access removal;
5. Telegram supervisor/adapter split;
6. Discord and Slack Router adoption;
7. obsolete-path deletion, architecture gates, and docs.

Do not mix provider rendering, topic UX, or unrelated notification features into this migration.

## Primary files

Expected existing files:

- `packages/coding-agent/src/sdk/broker/broker.ts`
- `packages/coding-agent/src/sdk/broker/lifecycle.ts`
- `packages/coding-agent/src/sdk/host/session-runtime.ts`
- `packages/coding-agent/src/sdk/bus/telegram-daemon.ts`
- `packages/coding-agent/src/sdk/bus/lifecycle-orchestrator.ts`
- shared chat-daemon/session-control modules under `packages/coding-agent/src/sdk/bus/`
- Coordinator and ACP adapters where they consume the same core contracts

Expected new core areas:

- `packages/coding-agent/src/sdk/lifecycle/`
- `packages/coding-agent/src/sdk/router/`

Move or rename existing services where possible instead of introducing parallel abstractions.

## Risks

- **High:** temporary dual authority during cutover.
- **High:** provider, Router, and Broker idempotency namespace drift.
- **High:** endpoint credential duplication or leakage.
- **High:** successor destruction if existing fences are simplified.
- **Medium:** crash-safe reservation-to-session binding.
- **Medium:** event replay duplication versus effect duplication.
- **Medium:** Telegram-specific requirements leaking into SDK core.

## Definition of done

- TUI, CLI, ACP, Coordinator, Telegram, Discord, and Slack lifecycle mutations enter one Broker path.
- One durable ledger determines lifecycle terminality.
- Provider daemons cannot allocate SessionIds, signal session processes, or read endpoint credentials.
- Providers retain only transport and presentation ownership.
- Router is the sole external attachment authority and credential-bearing SDK client manager.
- Provider restart cannot create, resume, close, or mutate a session by itself.
- Stale attachments fail closed.
- Crash, retry, rotation, and cleanup tests pass.
- Obsolete lifecycle server, chat lifecycle ledger, root scanning, and compatibility paths are removed.
- SDK, bot integration, notification, ACP, and Coordinator docs describe the final ownership model consistently.
