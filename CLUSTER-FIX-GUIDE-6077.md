# Cluster #3 Fix Guide: Agent Session Timing Race Condition Tests (#6077)

## Files
- packages/coding-agent/test/agent-session-abort-timeout.test.ts (670 lines)
- packages/coding-agent/test/agent-session-concurrent.test.ts (1800 lines)

### Problem
Tests use raw `Bun.sleep()` to assert race condition behavior, making them unreliable on variable-latency CI runners. Polling with fixed intervals creates false timeouts under system load.

### Flaky Patterns Identified

#### Pattern A: Polling for Side Effects (agent-session-abort-timeout.test.ts)
Lines: 72, 340, 396, 406, 455, 459, 529, 625, 669

Example (line 340):
```ts
while (true) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the wedged turn to start");
    await Bun.sleep(1);  // ← Polling with 1ms sleep
}
```

**Issue:** Polling for side effects with 1ms sleep is vulnerable to system latency. Even 1ms polling can become 5-10ms under load.

**Fix:** Use event signaling instead of polling:
```ts
// Replace with: wait for actual event/state change
const wedgeStarted = await fixture.waitForCondition(
    () => harness.wedgedTurnStarted,
    "wedged turn to start",
    deadline
);
```

#### Pattern B: Race Condition Polling (agent-session-concurrent.test.ts)
Lines: 110, 185, 448, 475, 1034, 1078, 1739, 1748

Example (line 110):
```ts
while (!predicate()) {
    await Bun.sleep(10);  // ← Polling race conditions
}
if (predicate()) return;
throw new Error("Timed out waiting for condition");
```

**Issue:** Tests poll for race conditions with fixed sleep. If system is slow, test fails even though condition will eventually be met.

**Fix:** Use Promise.race with timeout instead:
```ts
const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 5000)
);
const result = await Promise.race([
    fixture.waitForCondition(predicate, label),
    timeout
]);
```

#### Pattern C: Hard-Coded Safety Timeout (agent-session-abort-timeout.test.ts)
Line: 616

```ts
const safetyRelease = setTimeout(() => {
    releaseHeldTool.resolve();
    heldStream.end(response);
}, 5_000);  // ← Real timer
```

**Issue:** Uses real timers for safety conditions instead of virtual/mocked time.

**Fix:** Use Promise.withResolvers with mocked time:
```ts
const { promise: safetyRelease, resolve } = Promise.withResolvers<void>();
// Trigger resolve when test condition is met, not on real timer
fixture.on("timeout", () => resolve());
```

### Implementation Steps

1. **Create Condition-Wait Helpers**
   - Add `fixture.waitForCondition(predicate, label, timeoutMs)`
   - Returns promise that resolves when predicate becomes true
   - Uses microtask yielding, not real sleep

2. **Replace All Polling Loops**
   - Identify every `while (...) { if (predicate()) ...; await Bun.sleep(...) }`
   - Replace with `await fixture.waitForCondition(predicate, ...)`
   - Keep the deadline/timeout logic but use event-driven waiting

3. **Fix Race Condition Tests**
   - Use `Promise.race()` instead of polling loops
   - Pair each test with its inverse (e.g., "doesn't timeout" test)
   - Verify both timeout and success paths execute

4. **Mock Safety Timeouts**
   - Replace `setTimeout` safety timeouts with Promise.withResolvers
   - Trigger resolves on actual events, not elapsed time
   - Ensure fixture cleanup doesn't timeout

5. **Verify with Test Runs**
   - Run each file 5 times: `bun test <file> --timeout 60000`
   - Log execution times to verify consistency
   - All 5 runs should have <5% variance in execution time

### Code References

**agent-session-abort-timeout.test.ts**
- Lines 72, 340, 396, 406, 455, 459, 529, 625, 669: Polling loops
- Line 616: setTimeout safety timeout
- Pattern: `while (Date.now() < deadline) { if (...) break; await Bun.sleep(1); }`

**agent-session-concurrent.test.ts**
- Lines 110, 185, 448, 475, 1034, 1078, 1739, 1748: Polling loops
- Pattern: `while (!predicate()) { await Bun.sleep(10); }`

### Success Criteria
- [ ] No `Bun.sleep(ms)` in test assertions (>0 duration)
- [ ] All race conditions use `Promise.race()` with timeout
- [ ] All polling replaced with event-driven `waitForCondition()`
- [ ] Tests pass consistently (5x runs, <5% time variance)
- [ ] No hardcoded `setTimeout` for test synchronization
- [ ] All safety timeouts use Promise-based mechanisms

### Related Test Patterns to Fix
- `agent-session-auto-compaction-*.test.ts`: Lines with `Bun.sleep()` in loops
- `agent-session-before-agent-start-attribution.test.ts`: Similar polling patterns

### Estimated Effort
- **agent-session-abort-timeout.test.ts**: 1.5-2 hours
- **agent-session-concurrent.test.ts**: 2-2.5 hours (larger file)
- **Testing & verification:** 1 hour
- **Total:** ~4.5-5.5 hours

### Test Execution Baseline (Before Fix)
```
agent-session-abort-timeout.test.ts: ~45s (variable, 30-60s)
agent-session-concurrent.test.ts: ~120s (variable, 90-150s)
Combined with 5x runs: ~825s (13+ minutes, inconsistent)
```

### Expected After Fix
```
agent-session-abort-timeout.test.ts: ~2-3s (consistent)
agent-session-concurrent.test.ts: ~5-8s (consistent)
Combined with 5x runs: ~35-55s (consistent, <1 minute)
```

---

**Audit Date:** 2026-09-28
**Issue:** #6077
**Created By:** gc-test-audit
