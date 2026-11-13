### Added
- Add SDK-owned provider enrollment and flow lifecycle, safe provider status, and API-key storage behind exact secure-local Router grants, with single-use endpoint-bound attestations and credential-free shared observers/caches.

### Fixed
- Use identity-fenced native Windows ACL security for secure-local authority storage instead of POSIX mode bits; secure empty temporary keys before writing and refuse untrusted existing keys without repair or replacement.
- Preserve ordinary native command-result notifications through injected Router clients while keeping SDK reply envelopes and late duplicates private.
- Require affirmative installed authority before advertising secure-local operations in the shared public policy and factory.
- Report valid-grant replay-fence saturation as retryable `unavailable`, preserving invalid/replayed grant rejection, bounded retention, and expiry recovery.
