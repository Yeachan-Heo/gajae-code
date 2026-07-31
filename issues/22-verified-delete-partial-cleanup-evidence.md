# 22 — verified-delete must preserve typed partial-cleanup evidence

- **Command:** `bun test packages/coding-agent/test/sdk-broker.test.ts --test-name-pattern "preserves typed verified-delete partial-cleanup evidence"`
- **Site:** `packages/coding-agent/test/sdk-broker.test.ts:1221`; implementation `packages/coding-agent/src/sdk/broker/lifecycle.ts:3320-3330`
- **Owner stage:** Stage 12 residual defect triage (durable goal G010)
- **Disposition:** FIX — not an environment block

## Expected behaviour

When `session.delete` cannot finish cleanup, the verified-delete path must return
typed `cleanup_pending` evidence naming the phase, the session, the roots, and the
recorded artifact/transcript identities, so the caller has exact retry evidence. It
must never report success for a partially-cleaned session.

## Current state at this commit

The defect does **not** reproduce here: the named test passes.

```
bun test packages/coding-agent/test/sdk-broker.test.ts \
  --test-name-pattern "preserves typed verified-delete partial-cleanup evidence"
 1 pass  52 filtered out  0 fail  7 expect() calls
```

Because the test was already green, a plain "it passes" claim would not prove the
guarantee is actually enforced — a vacuous assertion passes too. The coverage was
therefore proven load-bearing with a mutation check against the real
implementation.

## Red → green receipt (mutation check)

RED — change the failure code returned by the artifacts phase in
`lifecycle.ts:3320` from `cleanup_pending` to a different code, leaving the test
untouched:

```
 0 pass  52 filtered out  1 fail  1 expect() calls
```

GREEN — restore `lifecycle.ts` byte-for-byte and re-run:

```
 1 pass  52 filtered out  0 fail  7 expect() calls
```

The whole file is also green: `bun test packages/coding-agent/test/sdk-broker.test.ts`
reports 53 pass / 0 fail / 175 expect() calls.

## Root cause of the original regression

The verified-delete path returned early without carrying the typed cleanup record,
so a partially-cleaned session could surface as an untyped failure (or success)
with no retry evidence. The current implementation builds the `cleanup_pending`
failure with the full record — phase, session id, cwd, sessions root, transcript
path, metadata root, and the artifact/transcript identity tuples — at
`lifecycle.ts:3320-3330`, and the mutation check above shows the test fails the
moment that contract is broken.

## Follow-up

None. The behaviour is enforced and covered. If the guarantee is ever refactored,
the mutation check above is the cheapest way to re-prove the coverage is real.
