### Fixed
- Restrict managed artifact rollback to exact issued files and attempt trees, preserve foreign native-looking residue, release owned attempt handles, and propagate genuine pending quarantine cleanup instead of treating it as physical reclamation.
- Preserve successful staged publication when its subsequent exact staging cleanup is pending; do not delete published artifacts or fail empty-artifact session commits for that cleanup disposition.
