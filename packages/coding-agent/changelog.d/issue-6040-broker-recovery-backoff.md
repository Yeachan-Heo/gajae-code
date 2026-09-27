# Issue #6040: Fix broker recovery backoff for replaced runtime image

## Fixed

- **Broker recovery prevents respawning when runtime image is replaced**: When a long-lived interactive TUI gjc has its on-disk binary replaced, the session no longer re-spawns the SDK broker continuously. Instead, it detects the replaced runtime image and surfaces a user-visible restart condition, stopping recovery attempts.

- **Added bounded exponential backoff for broker recovery failures**: Broker recovery now implements exponential backoff with a cap (initial 1s, max 30s, multiplier 2) to prevent repeated spawns from destabilizing the system. After 5 failed recovery attempts, recovery stops and surfaces a restart condition. A single successful recovery resets the backoff counter.

## Changed

- Session runtime now checks if the client's own runtime image is present before attempting broker recovery.
- Broker recovery respects a per-agent-dir backoff schedule to limit repeated spawn attempts.

## Details

- **File**: `packages/coding-agent/src/sdk/host/session-runtime.ts`
- **File**: `packages/coding-agent/src/sdk/broker/recovery-backoff.ts` (new)
- **Tests**: `packages/coding-agent/test/broker-recovery-backoff.test.ts` (new)

The fix prevents the issue where a process with a replaced binary would churn 120-140 broker spawns per hour, each living only 6-13s and repeatedly failing.
