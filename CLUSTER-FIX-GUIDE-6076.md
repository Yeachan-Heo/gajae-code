# Cluster #2 Fix Guide: ACP Cancel Settlement Timing Flakiness (#6076)

## File: packages/coding-agent/test/acp-cancel-settlement.test.ts

### Problem
This test file (2800+ lines) uses `Bun.sleep()` for state synchronization in 50+ test assertions, causing intermittent CI failures when the system is under load.

### Flaky Patterns Identified

#### Pattern A: Hard-Coded State Sync Sleeps
Lines: 562, 685, 1202, 1591, 1992, 2064, 2158, 2295

Example (line 562):
```ts
fixture.sendFailed("prompt_failed");
await Bun.sleep(30);  // ← Hard-coded delay for state change
expect(settleCount).toBe(1);
```

**Issue:** Tests wait for observable state changes with fixed sleep durations. If the system is slow, the sleep is not enough. If fast, the sleep wastes test time.

**Fix:** Replace with event-driven waits:
```ts
fixture.sendFailed("prompt_failed");
await waitFor(() => settleCount === 1, "settle count after failed");
// OR: await Promise that resolves when condition is met
```

#### Pattern B: Direct setTimeout Calls
Lines: 257-259

Example:
```ts
setTimeout(() => void publishExactSessionAuthority(authorityOptions, authority), 10);
```

**Issue:** Uses real timers for publishing authority, not mocked.

**Fix:** Use mocked timer adapter or Promise-based triggering:
```ts
// Option 1: Promise-based (preferred)
const authorityPublished = Promise.withResolvers<void>();
publishExactSessionAuthority(authorityOptions, authority);
authorityPublished.resolve();

// Option 2: Mock timer adapter (if real timing is critical)
vi.useFakeTimers();
setTimeout(() => {...}, 10);
vi.runAllTimers();
```

### Implementation Steps

1. **Create Event-Driven Wait Helper**
   - Add a helper function that waits for state predicates without polling
   - Use: `const updateIndex = fixture.updates.length; await fixture.waitForUpdate(...)`
   - Alternative: Use Promise-based signals

2. **Replace `Bun.sleep(ms)` Calls**
   - Identify all `await Bun.sleep()` calls in test assertions
   - Replace with `await waitFor()` that checks actual state
   - Keep timeout bounds but use event-driven polling

3. **Mock setTimeout Calls**
   - In `createFixture()` setup, install mock timers for frame delivery
   - Replace lines 257-259 with event-driven publishing
   - Ensure mock timer respects fixture.clock advances

4. **Verify with Test Runs**
   - Run test 5 times: `for i in {1..5}; do bun test packages/coding-agent/test/acp-cancel-settlement.test.ts --timeout 60000; done`
   - All should pass without variance
   - Note execution time should be stable

### Code References

**Current problematic pattern (state sync):**
- Line 562: `await Bun.sleep(30)` after `fixture.sendFailed()`
- Line 685: `await Bun.sleep(2_500)` for state reconciliation
- Line 1202: `await Bun.sleep(60)` for cancel settle check
- Line 1591: `await Bun.sleep(20)` for provisional terminal
- Line 1992: `await Bun.sleep(20)` identity check
- Line 2064: `await Bun.sleep(20)` for terminal
- Line 2158: `await Bun.sleep(20)` for foreign frame
- Line 2295: `await Bun.sleep(0)` after clock advance

**Current problematic pattern (setTimeout):**
- Line 257-259: `setTimeout(() => void publishExactSessionAuthority(...), 10)`

### Success Criteria
- [ ] No `Bun.sleep(10+)` in test body (except bounded timeout wrapper at top)
- [ ] All state synchronization uses event-driven waits
- [ ] No setTimeout without mocking
- [ ] Test executes in <120s (currently varies based on load)
- [ ] Test passes 5x consecutively without flakiness
- [ ] No regression in coverage

### Related Files
- acp-fallback-cancel-completion.test.ts (similar pattern, ~1000 lines)
- acp-transcript-replay-*.test.ts (uses similar setTimeout pattern)

### Estimated Effort
- **Analysis:** 30 minutes (identify all patterns)
- **Implementation:** 60-90 minutes (replace all occurrences, test)
- **Verification:** 30 minutes (5x test runs, edge cases)
- **Total:** ~2-2.5 hours for expert, 4+ hours for first-time fix

---

**Audit Date:** 2026-09-28
**Issue:** #6076
**Created By:** gc-test-audit
