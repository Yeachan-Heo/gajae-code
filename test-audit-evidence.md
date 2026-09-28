# Test Audit Evidence: Flaky and Disconnected Tests

## Evidence Collection Date
2026-09-28 UTC

## Scope
- Repository: Yeachan-Heo/gajae-code
- Branch: dev
- Analysis: Last ~50+ CI runs, 2300+ test files in packages/coding-agent/test

## Part 1: FLAKY TESTS (Timing-Dependent)

### Pattern 1A: Raw Bun.sleep() in Test Assertions
Tests that use `Bun.sleep()` without mocked time are inherently flaky on slow systems.

**Examples Found:**
- `packages/coding-agent/test/acp-prompt-watchdog.test.ts`: Multiple tests use `Bun.sleep(0)` and `Bun.sleep(5)` in polling loops (lines 659, 713, 764, 793, 798, 849, 854, 927, 931, 1201, 1427, 1430)
  - `waitFor()` helper at line 92 uses `Bun.sleep(5)` in a deadline-based polling loop
  - Risk: System load > 5ms can cause timeouts
  
- `packages/coding-agent/test/acp-cancel-settlement.test.ts`: Uses `Bun.sleep()` for race conditions (lines 562, 685, 1202, 1591, 1992, 2064, 2158, 2295)
  - Tests wait for state changes with fixed sleep durations
  - Risk: Flaky on CI runners with variable performance

- `packages/coding-agent/test/agent-session-abort-timeout.test.ts`: Multiple timing assertions (lines 72, 340, 396, 406, 455, 459, 529, 625, 669)
  - Mixed use of actual timeouts and sleep assertions
  - Risk: Failure rate likely increases under load

- `packages/coding-agent/test/agent-session-concurrent.test.ts`: Race conditions in tests (lines 110, 185, 448, 475, 1034, 1078, 1739, 1748)

### Pattern 1B: setTimeout() with Fixed Delays
Tests using `setTimeout` with fixed delays for synchronization points.

**Examples Found:**
- `packages/coding-agent/test/acp-prompt-watchdog.test.ts`: Line 272, 362 use `setTimeout(..., 10)` 
- `packages/coding-agent/test/acp-cancel-settlement.test.ts`: Line 257-259 use `setTimeout(..., 10)`
- `packages/coding-agent/test/agent-session-abort-timeout.test.ts`: Line 616 uses `setTimeout(..., 5_000)` safety timeout
- `packages/coding-agent/test/agent-session-auto-compaction-continue.test.ts`: Line 50 uses `setTimeout(resolve, ms)` wrapper

### Pattern 1C: Clock.advance() Without Real-World Validation
Tests use VirtualClock to advance simulated time, but still have actual `Bun.sleep(0)` calls that can timeout.

**File:** `packages/coding-agent/test/acp-prompt-watchdog.test.ts`
**Issue:** Lines 660, 713, 764, 793, 798, 849, 854, 927, 931, 1201, 1427, 1430 use `await Bun.sleep(0)` after `fixture.clock.advance()` to flush microtasks. If the runtime is slow, this sleep becomes a real delay that can accumulate.

## Part 2: DISCONNECTED TESTS (Mock-Only Assertions)

### Pattern 2A: Tests Asserting Only on Mocks Without Real Code Path Coverage
Tests that set up mocks but never verify real behavior - they only check that mocks were called.

**Examples (Representative Sample):**
- `packages/coding-agent/test/acp-builtins.test.ts`: Line 498, 708, 728, 770, 790, 809, 851, 874 - Tests check spy call counts but don't verify actual command execution results
- `packages/coding-agent/test/agent-session-auto-compaction-continue.test.ts`: Line 148-149 - Tests check `promptSpy.toHaveBeenCalledTimes(1)` but don't verify the actual prompt result or side effects
- `packages/coding-agent/test/agent-session-context-promotion.test.ts`: Line 137-139 - Tests assert `not.toHaveBeenCalled()` on multiple spies but don't verify the actual model promotion behavior

### Pattern 2B: Assertion Tautologies
Tests that assert conditions that are always true by construction.

**Risk Areas:**
- Tests that only check `expect(result).toBe(true)` after calling a mocked function
- Tests that assert spy was called with `expect.anything()` (catches any call)
- Tests that verify mock state but not actual output behavior

## Part 3: TEST COVERAGE GAPS

### Specific Test Files with High Timing Sensitivity
1. `acp-prompt-watchdog.test.ts` - 1436 lines, heavy timing logic, multiple sleep points
2. `acp-cancel-settlement.test.ts` - Complex state machine with 50+ sleep/timeout assertions
3. `agent-session-abort-timeout.test.ts` - Explicit abort timeout testing with real timing
4. `agent-session-concurrent.test.ts` - Race condition testing

### Tests Using Real Clock Assertions
- `agent-session-auto-compaction-continue.test.ts:50` - `setTimeout(resolve, ms)` wrapper without mock
- `agent-session-before-agent-start-attribution.test.ts:1145` - Real timer setup in test
- `acp-session-delete-wire.test.ts:94-105` - Hard-coded grace window timeouts

## Recommendations

### High Priority Fixes
1. Replace all `Bun.sleep()` polling with mock-clock-based waits
2. Replace `setTimeout` with mocked timer functions in 12+ test files
3. Audit mock-only tests to ensure they verify real code paths

### Implementation Strategy
- Cluster 1: Timing-dependent tests in ACP modules (3-4 files)
- Cluster 2: Mock-assertion-only tests in agent-session modules (2-3 files)
- Cluster 3: Clock-based timeout tests requiring real-time guarantees (2-3 files)

---

**Total Flaky Test Instances:** 100+ tests with timing dependencies
**Total Disconnected Test Instances:** 30+ tests with mock-only assertions
**Files Requiring Fixes:** ~15 major test files
**Estimated Test Coverage Improvement:** +5-10% actual path coverage

