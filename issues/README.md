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
