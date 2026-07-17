# Non-compaction auto-retry policy

This document describes the standard API-error retry path in `AgentSession`.

It explicitly excludes context-overflow recovery via auto-compaction. Overflow is handled by compaction logic and is documented separately in [`compaction.md`](../docs/compaction.md).

## Implementation files

- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`sdk.md`](./sdk.md) for the external machine interface.

## Scope boundary vs compaction

Retry and compaction are checked from the same `agent_end` path, but they are intentionally separated:

1. `agent_end` inspects the last assistant message.
2. `#isRetryableError(...)` runs first.
3. If retry is initiated, compaction checks are skipped for that turn.
4. Context-overflow errors are hard-excluded from retry classification (`isContextOverflow(...)` short-circuits retry).
5. Overflow therefore falls through to `#checkCompaction(...)` instead of standard retry.

So: overload/rate/server/network-style failures use this retry policy; context-window overflow uses compaction recovery.

## Retry classification

`#isRetryableError(...)` requires all of the following:

- assistant `stopReason === "error"`
- `errorMessage` exists
- message is **not** context overflow
- `errorMessage` matches transient transport/envelope patterns or `isUsageLimitError(...)`

Current retryable inputs are regex/string-classified:

- transient transport/envelope failures, including Anthropic stream-envelope failures before `message_start`
- overloaded/provider-returned-error wording
- rate limit / usage limit / too many requests
- HTTP-like server classes: 429, 500, 502, 503, 504
- service unavailable / server/internal error
- provider-suggested retry wording, including OpenAI `retry your request` failures
- network/connection/socket failures, refused/closed connections, upstream connect/reset-before-headers, socket hang up, timeout/timed out, fetch failed, terminated, retry delay wording, and unexpected socket close messages

Managed fallback uses structured transport facts and typed provider error codes when available. A structured classification of `other` becomes the bounded `unknown` fallback class; error prose cannot promote it to quota or transient. Regex classification is retained only as a legacy fallback.

## Retry lifecycle and state transitions

Session state used by retry:

- `#retryAttempt: number` (`0` means idle)
- `#retryPromise: Promise<void> | undefined` (tracks in-progress retry lifecycle)
- `#retryResolve: (() => void) | undefined` (resolves `#retryPromise`)
- `#retryAbortController: AbortController | undefined` (cancels backoff sleep)

Flow (`#handleRetryableError`):

1. Read `retry` settings group.
2. If `retry.enabled === false`, stop immediately (`false`, no retry started).
3. Increment `#retryAttempt`.
4. Create `#retryPromise` once (first attempt in a chain).
5. Transient errors retry without an attempt limit; unknown/no-code errors stop after `retry.maxRetries`.
6. Compute exponential full-jitter delay capped at `retry.maxDelayMs`; legacy parsed provider retry-after values override computed backoff and are capped at `retry.maxDelayMs`, while managed typed Retry-After values are intentionally uncapped.
7. For usage-limit errors, call auth storage (`markUsageLimitReached(...)`); if credential switching succeeds, force delay to `0`, otherwise use the applicable backoff.
8. Eligible ordered role-array fallback chains advance on entry-budget exhaustion. A selected fallback entry remains sticky until the head selector's rate-limit cooldown expires, when `retry.fallbackRevertPolicy: cooldown-expiry` probes it again on a new turn.
9. Emit `auto_retry_start`.
10. Remove the trailing assistant error message from agent runtime state (kept in persisted session history).
11. Sleep with abort support.
12. Schedule `agent.continue()` through the post-prompt task scheduler (`delayMs: 1`) for the same prompt generation.

### What resets retry counters

`#retryAttempt` resets to `0` in these cases:

- first successful non-error, non-aborted assistant message after retries started (emits `auto_retry_end { success: true }`)
- retry cancellation during backoff sleep
- max retries exceeded path

`#retryPromise` resolves/clears when retry chain ends (success, cancellation, or max-exceeded), via `#resolveRetry()`.

## Backoff and max-attempt semantics

Settings:

- `retry.enabled` (default `true`)
- `retry.maxRetries` (default `3`)
- `retry.baseDelayMs` (default `2000`)
- `retry.maxDelayMs` (default `300000`)
- `retry.requestMaxRetries` (default `5`) — provider request retries before a stream is established; counts retries, not the initial request
- `retry.streamMaxRetries` (default `5`) — provider stream replay retries for replay-safe transient stream failures; counts retries, not the initial stream attempt

Attempt numbering:

- attempt counter is incremented before max-check
- start events use current attempt (1-based)
- max-exceeded end event reports `attempt: this.#retryAttempt - 1` (last attempted retry count)

Backoff uses capped exponential full jitter. With default settings the maximum jitter windows are:

- attempt 1: 2000 ms
- attempt 2: 4000 ms
- attempt 3: 8000 ms

`retry.maxDelayMs` caps every legacy session retry delay, including provider retry-after hints, which otherwise take precedence over computed backoff. Managed fallback intentionally does not cap typed Retry-After values because it retries within its separate per-entry budget. Legacy transient errors have unbounded attempts; unknown/no-code errors are bounded by `retry.maxRetries`.

## Abort mechanics

### Explicit retry abort

`abortRetry()`:

- aborts `#retryAbortController` (if present)
- resolves retry promise (`#resolveRetry()`) so awaiters are unblocked

If abort hits while sleeping, catch path emits:

- `auto_retry_end { success: false, finalError: "Retry cancelled" }`
- resets attempt/controller

### Global operation abort interaction

`abort()` calls `abortRetry()` before aborting the active agent stream. This guarantees retry backoff is cancelled when user issues a general abort.

### TUI interaction

On `auto_retry_start`, EventController:

- swaps `Esc` handler to `session.abortRetry()`
- renders loader text: `Retrying (attempt/maxAttempts) in Ns… (esc to cancel)`

On `auto_retry_end`, it restores prior `Esc` handler and clears loader state.

## Streaming and prompt completion behavior

`prompt()` ultimately waits on `#waitForRetry()` after `agent.prompt(...)` returns.

Effect:

- a prompt call does not fully resolve until any started retry chain finishes (success/failure/cancel)
- retry lifecycle is part of one logical prompt execution boundary

This prevents callers from treating a retrying turn as complete too early.

## Controls: settings and SDK actions

### Configuration knobs

The standard retry controls are defined in the settings schema under `retry`:

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.maxDelayMs`

Fallback candidates are configured as ordered selector arrays on preset `model_mapping` roles, top-level `modelRoles`, or `task.agentModelOverrides`; `fallback.maxAttempts` controls the total request-time attempts per concrete entry. Resolution-time unavailable, unauthenticated, and unknown entries advance immediately without consuming that budget.

On settings load, a source-aware one-shot migration still reads legacy `retry.fallbackChains` and combines the effective role chain with its ordered, deduplicated legacy tail into the corresponding role array. The legacy key is ignored after migration; it is not a retry configuration surface.

Programmatic toggles in session:

- `setAutoRetryEnabled(enabled)` writes `retry.enabled`
- `autoRetryEnabled` reads `retry.enabled`
- `isRetrying` reports whether retry lifecycle promise is active

### External control

External clients observe retry lifecycle through the [SDK machine interface](./sdk.md). The removed RPC command surface and `RpcClient` helpers are not supported.

## Event emission and failure surfacing

Session-level retry events:

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }`
- `auto_retry_end { success, attempt, finalError? }`
- `model_fallback_switched { eventId, from, to, reason, role, scope, activeIndex, chainLength, attemptsUsed }` — emitted once for each real fallback-model switch

Propagation:

- emitted through `AgentSession.subscribe(...)`
- forwarded to extension runner as extension events
- exposed to external clients through SDK event subscriptions
- in the TUI, `model_fallback_switched` updates the fallback-model status/notice and `EventController` consumes retry lifecycle events for loader/error UI

Final failure surfacing:

- On max-exceeded or cancellation, `auto_retry_end.success === false`
- TUI shows: `Retry failed after N attempts: <finalError>`
- Extensions/hooks receive `auto_retry_end` with same fields
- SDK clients receive the same event stream

## Permanent stop conditions

Retry stops and will not auto-continue when any of these occur:

- `retry.enabled` is false, or legacy retry settings have not been explicitly configured (`legacyRetryConfigured` fail-closed gate)
- error is not retry-classified
- error is context overflow (delegated to compaction path)
- max retries exceeded
- user cancels retry through the session/SDK action or `Esc` during retry loader
- global abort (`abort`) cancels retry first

A new retry chain can still start later on a future retryable error after counters reset.

## Operational caveats

- Managed fallback uses typed transport facts and provider error codes; regex text matching is limited to the legacy retry path.
- Retry strips the failing assistant error from **runtime context** before re-continue, but session history still keeps that error entry.
- SDK clients observe retry state through session events and state updates.
- Fallback state is driven by the configured ordered role array and remains on a selected fallback entry across later user prompts. A real model change emits the canonical `model_fallback_switched` event rather than a legacy retry-fallback event.
- Temporary provider-session scopes retain and restore their own fallback controller and provider state when unwound; an authoritative model selection commits those temporary scopes.

## Provider request/stream retry budgets

The provider budgets are deliberately separate from session auto-retry:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
```

`requestMaxRetries` maps to provider SDK/fetch retry counts for request setup failures such as retryable 5xx/408/429/network errors. `streamMaxRetries` maps to provider-specific stream replay loops that are safe to repeat without duplicating visible assistant output. Providers that cannot safely replay a stream continue to surface the terminal error so the session-level auto-retry layer can decide whether to retry the turn.

Fail-fast cases stay fail-fast: invalid credentials (after any credential-refresh path is exhausted), unsupported model/provider configuration, malformed requests, context overflow, explicit user aborts, and permanent quota failures are not treated as transient provider budget candidates.
