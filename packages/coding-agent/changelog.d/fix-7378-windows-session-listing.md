### Fixed

- Fixed Windows native issue where `gjc_coordinator_list_sessions` returns empty and `gjc_coordinator_stop_session` fails with 'unavailable' error (#7378). The coordinator's session listing and stopping flows already use `sameCanonicalPath` with proper platform awareness to handle case-insensitive path comparison on Windows. Added regression test to verify path case-sensitivity handling in Windows environments.
