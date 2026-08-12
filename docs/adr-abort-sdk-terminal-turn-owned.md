# ADR: SDK terminal abort — turn-origin fence with owned-completion enablement

## Decision

**ADOPT — origin-aware `TurnContinuationFence`/`TurnContinuationGate` plus normal owned-completion delivery.**

C04 `turn.abort` gains `mode:"terminal"` with typed `scope:"turn" | "owned"` (default `"turn"`)
and a required bounded idempotency key (≤128 UTF-8 bytes). Terminal abort stops the root
worker's current turn and blocks **only** that turn's own continuation routes; exact owned
background work (Bash/task jobs, detached subagents) that the caller deliberately leaves
running keeps running, and its completion/progress is delivered through the existing
`YieldQueue -> agent.followUp`/`agent.prompt` path as a **fresh** root turn with a new
attempt/lineage/worker epoch.

## Prominent corrected design note (mandatory)

> **ADR/design note — turn abort is not owned-delivery abort.** `scope:"turn"` closes the root
> worker's current turn and its own continuation routes, while exact owned work remains
> runnable and its completion/progress results are intentionally delivered through the
> existing `YieldQueue -> AgentSession -> agent.followUp`/`agent.prompt` path. The delivery
> starts a fresh root turn with a new attempt/lineage. The earlier stage-04 no-successor fence
> that suppressed or deferred those deliveries was a misunderstanding: it defeated the reason
> to expose a leave-running option. **Do not reinstate it under another name.**

## Naming rules

- Blocked routes are **turn-origin continuations**: `TurnContinuationFence`,
  `TurnContinuationGate`, `blockedContinuationIds`, `predecessorTombstones`. The gate denies
  only `turn-continuation` origins after close.
- Allowed left-running feedback is **owned-completion delivery**: `ownedCompletionPolicy`,
  `ownedCompletionDelivery`, `resumeFromOwnedCompletion`, `OwnedCompletionEnvelope`. A closed
  turn record never invalidates or denies an allowed owned-completion entry.
- **Prohibited names** (any code, test, or review text): `TurnDeliveryGate`,
  `suppressOwnedDelivery`, `closedOwnedDeliveryFence`, `selectedDeliverySuppression`,
  `deferredOwnedCompletion`, or any phrasing that says "closed turn means no owned-completion
  delivery". Finding any is a hard implementation blocker.

## Semantics

- `scope:"turn"` (default): `ownedWork:"left_running"`, `automaticDelivery:"enabled"`,
  `resumeOnOwnedCompletion:true`. Owned work keeps running; an owned completion resumes the
  root with a fresh attempt. Same-turn retry, TTSR/`agent.continue`, steering continuation,
  hidden-next-turn, maintenance/worker successor, and accepted-pre-close same-attempt
  continuations are blocked/tombstoned.
- `scope:"owned"`: additionally stops exact causal owned work with full quiescence proof and
  foreign-work uncertainty; nothing resumes from stopped work (`automaticDelivery:"none"`,
  `resumeOnOwnedCompletion:false`).
- Classification is **source/lineage-based, never timing-based**: the exact five-tuple
  (endpoint generation, lineage hash, attempt epoch, job id, job generation) is recorded
  before the job handle escapes; missing/mismatched metadata fails closed to ordinary.
- ultragoal/ralplan workflow stop is out of scope; ledgers/artifacts/handoffs stay untouched.
- No public surface widening: only the typed scope and bounded outcome metadata are exposed;
  lineage/fence/ticket/envelope machinery is private to the SDK session layers.

## Implementation state

Committed on `feat/abort-sdk-terminal` (lore `c04-terminal-*`), base `e92a04e3`:

- `c04-terminal-lineage`: lineage/attempt origin authority — per-turn lineage minted before
  model execution, `beforeToolCall` binding, task/Bash `registerOwnedIfLineaged` five-tuple
  capture; bounded registries, fail-closed.
- `c04-terminal-origin-delivery`: origin-aware async-result delivery —
  `classifyOwnedCompletion` before formatting/artifact allocation, `OwnedCompletionEnvelope`
  carrier, `resumeFromOwnedCompletion` fresh-attempt allocation; mandated boundary comments at
  `sdk/session.ts`, `yield-queue.ts`, and both `agent-session.ts` injectors.
- `c04-terminal-surface`: `turn.abort` terminal surface wired to the durable prompt
  terminalization; landed-terminal verification before claiming `stopped`; no-active-turn =
  `terminal_no_effect`; unfencible = `terminal_uncertain`; turn dispositions as above.
- `c04-terminal-scope-registration`: terminal scope registered + synchronously closed at abort
  (session `abortPromptAndWait` terminal option), epoch advanced so the fence never leaks onto
  later turns; `classifyOwnedCompletion` live end to end.
- `c04-acp-owned-cancel`: the ACP surface issues the C04 terminal abort on `session/cancel`.
  `AcpSdkAdapter.cancel(scope)` sends `turn.abort` `{mode:"terminal", scope}` with a fresh
  bounded idempotency key per call; `AcpAgent.cancel` resolves the scope from
  `_meta.gjc.abortScope` on the cancel notification (authoritative) then
  `GJC_ACP_ABORT_SCOPE` (process fallback), **defaulting to `"turn"`** (amended: the initial
  `"owned"` default was reverted so an ACP client cancel stops only the turn, matching the
  SDK `turn.abort` default and other ACP clients' cancel behavior; owned termination is an
  explicit opt-in via `_meta.gjc.abortScope: "owned"` or `GJC_ACP_ABORT_SCOPE=owned` —
  Paseo keeps owned cancels through its provider config env without source changes),
  accepts the terminal dispositions (`stopped` / `no_active_turn` /
  `no_effect` / `no_store` / `uncertain`) in addition to the legacy `{aborted:true}`
  plain-abort ack (broker-compat only: the C04 host always answers terminal dispositions,
  and the ack must echo the requested scope when it carries a `selection`), and keeps the
  bounded cancel settlement grace. With the default `scope:"turn"` an external client that
  ends a turn leaves owned subagents and background tasks running (their completion can
  resume the root worker as a fresh turn); `scope:"owned"`, the opt-in, terminates them,
  not just the turn.
- `c04-terminal-continuation-gate`: same-turn continuations denied at the final synchronous
  boundary (skip reason `terminal_turn`); fail-open without a scope.
- `c04-terminal-durable-record`: bounded `DurableTerminalScopeRecord` (selection, fence, policy,
  dispositions, response state, payload hash, key hash) through the v2 store; AC 5 no-store
  gate; same-key replay via dispatch + durable key-hash lookup.
- `c04-terminal-owned-stop`: `scope:"owned"` generation-verified exact cancel, fixed grace,
  second quiescence proof (generation-revalidated), delivery purge, `ownedWork:"stopped"` only
  after proof; `settleOwnedWork` unit-tested; event metadata on the correlated `agent_end`.
- `c04-terminal-gate-authority`: gate requires the exact registered five-tuple (forged/
  unregistered denied); injectors drop denied owned-completion deliveries entirely (AC 36
  zero final calls) and allocate a fresh attempt only on `allow-new-turn`.

Durable contract status (AC 6/18/19/41/42): the record persists selection, the
continuation fence (epoch + tombstones + policy), dispositions, the
normalized-input and key hashes, response state, and `terminalPublished`. Same-key
replay/conflict is deterministic across dispatch-LRU eviction and restart (the v2
store reloads terminal scopes from the single document), and response state
advances monotonic `pending -> sent` once the host writes the control response.
Not wired (tracked): a `pending -> failed` transition on host write rejection
(no surface-level host failure hook exists), a `sent -> delivered` transition
(client-acknowledgement protocol), and runtime re-hydration of the continuation
fence into the process registry. The last is architecturally bounded: lineage
registries are process-local and the per-session lineage secret regenerates on
restart, so a restarted session has NO lineage authority for a previous turn —
the plan's own AC 42 conditions fence installation on "runtime authority being
present", and missing authority failing closed (no auto-inject) is satisfied by
the durable replay/conflict gate alone.

## Reviewer / implementer checklist (mandatory)

Answer these against any change to this feature:

1. **Which origins are blocked?** Only `turn-continuation` origins of the aborted turn (same-turn
   retry, TTSR/`agent.continue`, steering, hidden-next-turn, maintenance/worker successor,
   accepted-pre-close same-attempt continuation). Not owned-completion, not foreign, not
   ordinary.
2. **Can a left-running owned completion reach `followUp`/`prompt`?** Yes — it must, through the
   normal `YieldQueue` path, after a closed `turn` record, as a fresh turn.
3. **Where is the fresh attempt allocated?** `AgentSession.#resumeFromOwnedCompletion` (fresh
   `promptAttemptEpoch` + opaque lineage id) immediately before the existing
   `followUp`/`prompt` call. It never reuses the aborted attempt's epoch.
4. **Is any six-path observer turn-only?** No. Any `OwnedDeliverySettlementObserver` is
   owned-scope-only proof of exact settlement; it never runs for a `turn` left-running
   completion and never emits `suppressed`/`deferred` turn receipts.
5. **Does any name imply suppressing owned delivery?** If yes (see prohibited names above), the
   change is blocked pending a fresh intent decision.
