### Fixed

- Retry validated pre-mutation Windows access-denied lock publications within a three-call publish budget and a separate two-attempt acquisition budget; report exhaustion with the lock path and failure code without labeling it proven live contention (issue #6618).
- Keep GC candidates withheld when Windows access denial prevents exact removal before detachment, rather than reporting the refused deletion as a GC failure.
- Stop retrying pre-mutation publication after bounded transient staging-cleanup retries fail, preventing repeated attempts from multiplying same-process residue; keep generic failures distinct from proven contention.
- Accept the distinct Windows `access_denied` code in managed-session security validation so ACL access refusals remain classified security errors.
- Map Windows canonical workspace-identity `access_denied` results to `permission_denied` for scope resolution and candidate diagnostics.
- Preserve candidate-invalid `permission_denied` diagnostics through lifecycle session-list validation.
- Remove staged info entries after identity-stat retries exhaust only through a handle-derived identity, and refuse recursive cleanup when that identity is unavailable.
- Defer transient Windows `access_denied` while detaching replacement receipts so a later managed-session mutation can retry cleanup.
