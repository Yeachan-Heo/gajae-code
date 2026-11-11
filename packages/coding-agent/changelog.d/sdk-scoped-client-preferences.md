### Added
- Expose session-owned task-role model overrides and explicit model/profile/configuration scopes through canonical SDK controls, with durable commitment and live-application outcomes kept distinct.

### Fixed
- Renew cached views after native-authorized cwd/transcript moves, retiring raw views and old refs before publication and fencing retryable pending writer settlement without weakening immutable-owner or native cleanup admission guards; retain canonical logical-session cleanup renewal and reject native precommit reentry before nested abort effects.
- Let the canonical atomic configuration writer create project config directories, with read-only path/symlink checks before admission and revalidation under its queue/lock before publication.
