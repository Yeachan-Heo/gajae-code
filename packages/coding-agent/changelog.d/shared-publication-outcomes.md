### Fixed

- Preserve the attempted entry ID in an `unknown` shared-append outcome when publication, verification, or transaction release fails after staging. Callers can reconcile possible commitment instead of treating it as a safely retryable rejection.
