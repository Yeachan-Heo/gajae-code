# Codex bridge expanded RED/GREEN evidence

## 1. Atomic wake creation
Already green: new test `creates exactly one wake across concurrent Bun processes` passed against the existing exclusive-create implementation; no production change was required.

```text
bun test packages/coding-agent/test/coordinator-codex-handoff.test.ts
6 pass
0 fail
18 expect() calls
```

## 2. Shared Codex thread delegates
Already green: new test `serializes two delegates sharing a Codex thread and drains the pending wake` passed; no production change was required.

```text
bun test packages/coding-agent/test/coordinator-codex-bridge.test.ts
11 pass
0 fail
45 expect() calls
```

## 3. Production question.opened
Already green: new test `emits one bounded question.opened event and records its Codex wake` passed, proving canonical creation, idempotent journaling, bounded summary, and durable wake recording; no production change was required.

## 4. Isolated parallel ask answers
Already green: new test `keeps parallel pending questions isolated when one answer is submitted` passed, proving the other namespace's question, binding, timestamps, journal, and wake state remain untouched; no production change was required.

```text
bun test packages/coding-agent/test/coordinator-mcp-server.test.ts
54 pass
0 fail
272 expect() calls
```

## 5. Per-thread wake serialization
RED test added: `publishes different Codex threads independently`.

GREEN transcript:
```text
bun test /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-bridge.test.ts /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-handoff.test.ts
15 pass
0 fail
47 expect() calls
Ran 15 tests across 2 files.
```

## 6. Restart drain
RED test added: `drains persisted failed wakes at server startup`.

GREEN transcript:
```text
15 pass
0 fail
```

GREEN: server construction schedules a best-effort registration scan and enqueues pending/failed wakes without blocking construction.

# Mutation-based assertion validity proofs (fault injected, RED captured, reverted, GREEN rerun)
## M1b atomic wake creation (loser reports created:true)
      at <anonymous> (/Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-handoff.test.ts:170:52)
(fail) Codex handoff durable state > creates exactly one wake across concurrent Bun processes [133.80ms]

 0 pass
 5 filtered out
 1 fail
 2 expect() calls
Ran 1 test across 1 file. [224.00ms]

## M2 question.opened emission suppressed

 0 pass
 53 filtered out
 1 fail
 2 expect() calls
Ran 1 test across 1 file. [283.00ms]

## M3 per-thread serialization collapsed to namespace-wide
(fail) Coordinator Codex resume bridge > publishes different Codex threads independently [13.77ms]

 0 pass
 10 filtered out
 1 fail
Ran 1 test across 1 file. [195.00ms]

## M4 startup drain removed

 0 pass
 10 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [210.00ms]

## M5 idle-only gating removed (shared-thread pending fallback broken)

 0 pass
 10 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [195.00ms]

## M6 isolation invariant broken (reconciliation touches updated_at)

 0 pass
 53 filtered out
 1 fail
 2 expect() calls
Ran 1 test across 1 file. [310.00ms]

## Final GREEN after all reverts

 90 pass
 0 fail
 437 expect() calls
Ran 90 tests across 6 files. [7.45s]
