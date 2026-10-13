# Anthropic Stream Stall Auto-Retry Investigation

## Root Cause Analysis

### Symptom
Session goes silent mid-turn when Anthropic stream idles for 10 minutes without semantic events. Session waits for user input instead of auto-retrying.

### Background Issues
1. **#3167**: Implemented timeout for "ping-only" streams (streams that only send keepalives, no semantic events)
2. **#6441**: Extended idle timeout from 5 min (300s) to 10 min (600s) because Anthropic Opus 5.5 with extended thinking needs longer
3. **#6481**: Proper fix - allow pings to count as progress ONLY when a thinking block is open and bounded to 3 idle windows (30 min total)
4. **fix/anthropic-stream-idle-reset (07523a2c5)**: WRONG attempt - makes ALL pre-message_start pings reset idle timer, breaking #3167

### Current Code State (origin/dev)
The current dev branch has the correct implementation from #6481:
- `ANTHROPIC_SILENT_THINKING_IDLE_WINDOWS = 3` - bounds silent thinking at 3x the idle timeout
- Pings only reset the idle timer when a thinking block is open
- If stream sends only pings without opening a thinking block, it still times out
- When timeout fires: error "Anthropic stream stalled while waiting for the next event" is thrown

### Auto-Retry Logic Analysis
When the idle timeout error is thrown:
1. Error message matches `isRetryableError()` check in utils (contains "stream stall")
2. Error message matches `#isTransientTransportErrorMessage()` in session (regex includes "stream stall")
3. Classification: `#classifyErrorForRetry()` returns "transient"
4. `#isRetryableError()` in session should return `true` for transient errors
5. `#handleRetryableError()` should be called and should initiate auto_retry_start event
6. Agent should call `continue()` to retry the request

### The Problem
After investigation, **auto-retry should be working**. The tests in `agent-session-resilient-retry.test.ts` confirm:
- Test "retries provider stream idle stalls under a bare default config" expects auto-retry to work
- The test creates a stall error, expects retry, and expects recovery

If auto-retry is not happening in practice, it could be because:
1. The error is being classified as terminal instead of transient (unlikely - regex matches)
2. A race condition where agent_end happens before retry can be scheduled
3. The TUI not displaying retry status properly

### Solution Strategy
1. Verify that auto-retry IS actually working (tests pass)
2. Ensure error message includes helpful hints about idle timeout configuration
3. Surface auto_retry_start and auto_retry_end events clearly in TUI
4. Consider whether 10-minute timeout is still appropriate now that retry exists
5. Remove the wrong fix/anthropic-stream-idle-reset branch

### Key Insight
The fix/anthropic-stream-idle-reset branch was an attempted WORKAROUND that prevented the timeout from firing in the first place. Instead of fixing the timeout firing, it made timeouts never fire (infinite streams of pings). This is fundamentally wrong.

The CORRECT approach is:
1. Let timeouts fire when appropriate (current dev branch does this correctly)
2. Ensure auto-retry works when timeouts fire (should already be working)
3. Make sure retry status is visible to users

## Recommendations
1. Delete the fix/anthropic-stream-idle-reset branch
2. Verify auto-retry is working in practice
3. Consider lowering the timeout back to 5-7 minutes now that auto-retry is in place (retries are cheap, long waits are expensive)
4. Improve TUI display of retry progress
