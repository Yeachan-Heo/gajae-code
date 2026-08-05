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

Committed on `feat/abort-sdk-terminal` (lore `c04-terminal-*`):

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

Still pending (explicit, not silently omitted): owned-scope exact cleanup + six-path
settlement observer, terminal scope registration bound to the aborted turn's lineage
(feeding `classifyOwnedCompletion`), durable terminal-scope record consumption, publication
/replay/retention, and the full race matrix.

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
