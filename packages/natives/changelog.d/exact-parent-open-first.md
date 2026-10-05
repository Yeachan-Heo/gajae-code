### Fixed
- Avoid redundant ancestor metadata probes during POSIX exact deletion while retaining a fresh no-follow directory open for every ancestor, exact parent and file validation, and quarantine safeguards. Failed opens remain failures; symlink diagnostics never authorize retries or deletion.
