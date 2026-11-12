### Added
- Expose bounded owner-scoped jobs, detached tasks, cron entries, supported mutations and explicit failure acknowledgment through SDK activity controls.
- Expose bounded factory-manager MCP state and supported suspend/resume/reconnect controls with exact opaque targets and honest cleanup outcomes.

### Fixed
- Retire rejected SDK views without vetoing native cwd moves or committed cold-fork cleanup; retain permanent rejection and renew only from trusted native successor settlement with separate provider/manager identity fences.
- Renew cached views after native-authorized cwd/transcript moves, retiring raw views and old refs before publication and fencing retryable pending writer settlement without weakening immutable-owner or native cleanup admission guards; retain canonical logical-session cleanup renewal and reject native precommit reentry before nested abort effects.
