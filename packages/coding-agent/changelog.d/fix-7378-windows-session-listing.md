### Fixed

- Fixed Windows native issue where `gjc_coordinator_list_sessions` returns empty and `gjc_coordinator_stop_session` fails with 'unavailable' error (#7378). The root cause was case-sensitive string comparison of file paths in `scopeMatchesLocator`, which on Windows can fail when the filesystem returns different path casings. Now uses `normalizePathForComparison` for proper Windows case-insensitive path comparison.
