# 25 — two residual managed-migration guard defects in session-manager

- **Commands:**
  - `bun test packages/coding-agent/test/session-manager-resume-readonly.test.ts --test-name-pattern "rejects source identity drift at the final prepared migration receipt publication guard"`
  - `bun test packages/coding-agent/test/session-manager-resume-readonly.test.ts --test-name-pattern "fails closed at the final migration seam when captured managed authority is replaced"`
- **Sites:** `packages/coding-agent/test/session-manager-resume-readonly.test.ts` (`expectStrictFailure` at :219, authority assertion at :1287); implementation `packages/coding-agent/src/session/session-manager.ts:9600-9625` and `packages/coding-agent/src/session/internal/managed-session-storage.ts:640-648`
- **Owner stage:** managed-session storage / resume security (branch commits `b57b2b2d2`, `d9a7a663d`, `c22d25b13`, and the session-manager change in `9c0642f0e`) — NOT the Stage 11/12 app-server work
- **Disposition:** FIX, owned by the managed-session storage stage; not fixed here because the correct guard ordering is a security decision for that owner, and guessing would weaken a fail-closed invariant

## Defect A — source identity drift is not rejected at the publication guard

Expected: `prepareManagedCandidateForWrite` returns
`{ kind: "error", reason: "identity-mismatch" }` when the source identity drifts
before the prepared migration receipt is published.

Observed: it returns `{ kind: "opened", manager: SessionManager { … } }` — the drift
is not rejected and a manager is handed back. This is the more serious of the two: a
fail-closed guard is not firing at all.

## Defect B — the wrong fail-closed guard fires when captured authority is replaced

Expected: replacing the captured managed authority at the final migration seam
throws `Managed descendant root binding changed`
(`managed-session-storage.ts:648`).

Observed: it throws `Managed root authority changed: <tmp>/custom-agent`
(`session-manager.ts:9613`).

Severity is lower than A: the operation still fails closed, so no unauthorized
write happens. What is unproven is the specific invariant the test targets — that
the descendant-root binding check is what rejects a replaced authority. Either the
authority check legitimately now fires first (the test is stale and must assert the
new ordering) or the descendant binding check has been bypassed (the guard needs
restoring). That determination belongs to the managed-storage owner.

## Repro state at this commit

```
bun test packages/coding-agent/test/session-manager-resume-readonly.test.ts
 37 pass  1 skip  2 fail  129 expect() calls
```

Both failures are inside the managed-migration guards and are independent of the
app-server work in this session: nothing in Stage 11/12 touches
`managed-session-storage.ts`, and the app-server suites are green
(524 pass / 0 fail).

## Why this is not quarantined

No skip was added. The two tests keep failing loudly so the owning stage sees them,
which is the point of the Stage 12 contract: a residual defect is recorded with an
exact command, an owner, and a disposition rather than being silenced.
