# Issue Backlog

Only the files at this level are live backlog. Everything else is archived under
`archive/` for provenance.

## Live (deferred architectural follow-ups)

| # | Severity | Disposition | Summary |
|---|----------|-------------|---------|
| [09](09-rpc-no-persistent-detached-session.md) | High | Deferred architecture | Persistent detached sessions require a replacement transport design (the stdio RPC mode they were filed against has since been retired; the design need generalizes to the SDK/daemon transport). |
| [10](10-rpc-no-session-registry.md) | High | Deferred architecture | Cross-process session discovery depends on the persistent-session support in 09. |

These two remain intentionally open: they are architectural work queued for their
own follow-up PR, not defects fixable in a backlog sweep.

## Archive

`archive/` holds the resolved and obsolete findings from the RPC control-plane
dogfood (issues 01–08, 11–21) plus low-fruit fixes #3594 and #3470:

- **Resolved (verified against current source, 2026-08-05):** 01–08, 14–18,
  20–21. Spot-checks re-confirmed on `dev`: credential-import root guards (14),
  web-search `canUseDirectProviderMapping` local-baseUrl guard (17), and
  `session.resumeModelBehavior` (21) are present; the RPC fixes (01–08) landed
  before the stdio RPC mode was retired.
- **Obsolete:** 11–13, 19 — the stdio RPC mode and its docs/config surfaces were
  retired, so the findings no longer have a live implementation target.

Historical issue descriptions remain in `archive/` for provenance only; they are
not active work.

## Stage 12 residual defect triage (durable goal G010)

| Issue | Disposition | Summary |
| --- | --- | --- |
| [22](22-verified-delete-partial-cleanup-evidence.md) | FIX — enforced, coverage proven | The named verified-delete defect does not reproduce at this commit; the typed `cleanup_pending` guarantee is enforced and the test is proven load-bearing by a mutation red→green receipt. |
| [23](23-broker-child-spawn-environment-block.md) | ENVIRONMENT BLOCK | The sandbox denies the broker child spawn (`spawn_failed`, then `terminal_uncertain`). Labelled honestly; no silent skip. |
| [24](24-cli-command-surface-missing-app-server.md) | FIXED | The CLI inventory guard did not list the shipped `app-server` command. Red→green receipt included; the guard keeps its exact-list strength. |
| [25](25-managed-migration-receipt-guards-residual.md) | FIX, owned elsewhere | Two managed-migration guard failures in `session-manager-resume-readonly`: source-identity drift is not rejected, and the wrong fail-closed guard fires on replaced authority. Owned by managed-session storage. |
| [26](26-stage12-residual-defect-inventory.md) | INVENTORY | All 46 full-suite failures across 23 suites with exact commands, plus the isolation runs that separate real defects from full-run interference and environment blocks. |
| [27](27-protected-gate-integrity-bypasses.md) | 1-2 CLOSED (verified), 3 FIXED | The three CRITICAL protected-gate integrity bypasses: status tamper and forged rotation are already enforced (probes exit 1); the coordinated provenance scrub was reproducible and is now closed by an ever-protected marker on the session audit journal, with a red→green regression test. Residual risk documented. |
