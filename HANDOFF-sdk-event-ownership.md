# Handoff: SDK event ownership — notifications extension → SDK core

- Branch: `refactor/sdk-event-ownership` (off `dev` @ `08c527fd8`)
- Worktree: `../gajae-code.gajae-code-worktree/sdk-event-ownership`
- Status: **Slice 1 landed** (unify duplicated durable terminal-retention writes,
  see `refactor(sdk): unify duplicated durable terminal-retention writes` +
  `fix(session): keep transitional reservations out of retention eviction`).
  Slices 2-5 (canonical event projection, ask bridging into SDK core, idle
  genesis, hosting de-gated) remain outstanding — do not re-derive or
  duplicate the landed retention-write unification below.
- Date: 2026-08-12

## Problem statement

Ownership between the notifications extension and SDK core is inverted by history:
the SDK grew *inside* the notifications extension, so the extension still owns
session→SDK **event genesis** (idle, activity, context updates, ask bridging) and
even endpoint **hosting**, while SDK core is supposed to be the product surface.

Target end-state: SDK core owns event derivation + hosting; the notifications
extension becomes a delivery adapter (subscribe → presentation policy → provider
transport).

## Evidence (verified against source, 2026-08-12)

### 1. `packages/coding-agent/src/sdk/bus/index.ts` (~8,380 lines)

File header literally says "Notifications extension", yet it owns:

- **Endpoint hosting**: per-session loopback WS server (Rust core via N-API,
  `NotificationServer` from `@gajae-code/natives`), enabled by notifications
  Settings / `GJC_NOTIFICATIONS=1` / `GJC_NOTIFICATIONS_TOKEN` — contradicting
  `docs/sdk.md` "Hosted by default. SDK hosting is independent of notification
  configuration."
- **Idle genesis**: `agent_end` → `action_needed { kind: "idle", id: "idle:<sess>#<seq>" }`
  with `idleSeq` (~line 6482, ~8020-8037), per-settle dedup. Comment at ~7923:
  "user-visible idle previously produced many idle pings (the flood); agent_end
  fires exactly once per settle, yielding exactly one idle notification."
- **Ask bridging**: registers `AskAnswerSource`; races local UI vs remote reply
  (first-valid-wins); observes workflow gates and resolves the real gate via
  `ctx.workflowGate`.
- **Presentation policy interleaved with fact derivation**: lean/verbose deferred
  settled answer (~7850, ~8049, ~8086, ~8264-8270), `activity` busy/idle frames
  (~8012), `context_update` on idle (~8054).

### 2. `packages/coding-agent/src/sdk/host/session-runtime.ts` (SDK-only host)

A **second, parallel** session→SDK runtime that also subscribes to
`agent_start`/`agent_end` (`emitLifecycle`, ~2526-2587) and independently
implements:

- prompt lifecycle + active-prompt-owner tracking (cleared at `agent_end`,
  review thread P1)
- terminal-abort durable reservations + `agent_end` publication capture
  (review thread P2), with comments like "mirroring the bus terminal-abort
  implementation (review thread P2)"
- reconciliation transitions (`noteTransition`, `agent_end`/`agent_failed`)
- bounded retention constants `SDK_ONLY_MAX_DURABLE_TERMINAL_RESERVATIONS = 256`,
  `SDK_ONLY_MAX_RETAINED_TERMINAL_KEY_TOMBSTONES = 4096` duplicated in spirit
  from the bus path.

This bus-vs-host duplication is the strongest architectural pain — two copies of
subtle race/ordering invariants that must be kept in sync by review-thread
comments.

### 3. Supporting layout

- Rust core `crates/gjc-sdk`: `actions.rs` already owns ask mechanics
  (buffering, replay, first-valid-reply-wins, idempotency, non-repliable
  resolution). The TS extension only *bridges* into it.
- `sdk/bus/` also contains the provider daemons (telegram-daemon.ts,
  slack-daemon.ts, chat-adapters.ts, engine.ts `NotificationEvent` fanout +
  redaction, rate-limit-pool.ts lanes `ask|finalized|live|idle`).
- Protocol note (`docs/sdk.md`): `kind: "idle"` is notify-only and **ephemeral**
  (not replayed to late attachments) — deliberately a delivery-flavored event,
  not a durable session fact.
- Related pre-existing branch (not this worktree): `fix/sdk-core-ask-idle`
  checked out at `/Users/bellman/tmp/gajae-code-streamdeck-docs` — inspect
  before starting to avoid duplicate/conflicting work.

## Design decision: split fact from presentation

**Move to SDK core (single session-runtime event projection):**
- Session lifecycle facts: "turn settled with answer Y", activity busy/idle
  transitions, context snapshots.
- Ask presentation lifecycle (registration, arbitration bridging,
  first-valid-wins TS side).
- Per-settle dedup ("one settle = one event") — fact-level invariant.
- Endpoint hosting, de-gated from notifications configuration.

**Stays in the notifications adapter:**
- Whether an idle *fact* becomes an idle *notification* (`kind: "idle"` remains
  notify-only/ephemeral delivery policy).
- Lean/verbose (`/verbose`, `/lean`), redaction, rate-limit lanes, rendering,
  thread/topic routing.

## Sequenced plan (each slice independently shippable, PRs target `dev`)

1. **Slice 1 — unify duplicated runtime logic (highest value, lowest risk):**
   **Landed (partial).** The durable terminal-retention write path (the
   four hand-rolled retention-transaction call sites, 256/4096 caps) used by
   both `bus/index.ts` and `host/session-runtime.ts` is unified; a follow-up
   fix keeps transitional reservations out of retention eviction. Remaining
   under this slice: the bus synchronous publication-capture path and the
   host `agent_end` waiter array are intentionally still separate (deferred
   to a later slice per commit `2c6cd6ecaa9`) and the broader
   `agent_end`/terminal-abort/reconciliation logic beyond the retention-write
   transaction has not yet been extracted into one shared session-runtime
   module. Existing tests in `host/session-runtime.test.ts` and bus tests
   pass unchanged (behavior-preserving, 600-case differential equivalence).
2. **Slice 2 — canonical event projection:** SDK core emits `session_settled` /
   activity transitions once; bus subscribes instead of deriving from raw
   extension events. Preserve the one-settle-one-event invariant (idle-flood
   regression risk).
3. **Slice 3 — ask bridging into SDK core:** move `AskAnswerSource`
   registration + workflow-gate observation out of the notifications-gated
   path; adapters consume presentations only.
4. **Slice 4 — idle genesis:** notifications engine renders `kind:"idle"` from
   the settled-fact projection; `idleSeq`/dedup moves with the fact layer.
5. **Slice 5 — hosting de-gated:** endpoint hosting independent of
   notifications config in code (matching the documented contract);
   `GJC_SDK_DISABLE=1` remains the opt-out.

## Risks / invariants that must not regress

- Idle-ping flood (one `agent_end` per settle → exactly one idle event).
- Ask arbitration: first-valid-wins, local answer → `action_resolved
  resolvedBy=local`, stale/terminal IDs never regain authority.
- Terminal-abort P1/P2 review-thread invariants (owner-connection authority,
  bounded durable reservations, observed-not-assumed `agent_end` publication).
- `action_needed.id ≠ gate_id` (SDK v3 contract).
- Zero wire-protocol change: `crates/gjc-sdk` protocol and managed-adapter
  frame surface stay byte-compatible.
- Docs (`docs/sdk.md`, `docs/sdk-app-guide.md`) must be updated per slice if
  observable contracts move.

## Verification per slice

- `bun --cwd=packages/coding-agent run check`
- Targeted: `bun test packages/coding-agent/src/sdk/host/session-runtime.test.ts`
  plus the bus/daemon test files touched by the slice
- `bun test packages/coding-agent/test/default-gjc-definitions.test.ts` only if
  default surfaces change (they should not)
- Full `bun run check` + relevant Rust suites before each PR
