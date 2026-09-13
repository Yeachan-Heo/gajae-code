### Fixed

- Report a managed session lock already removed or replaced before release as `migration_busy`, preserving the successor file and existing descriptor-recovery security checks instead of masking ordinary ownership loss as a Linux security error.
