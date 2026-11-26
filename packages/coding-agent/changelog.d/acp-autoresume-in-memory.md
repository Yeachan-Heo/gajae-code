### Fixed

- `gjc acp` no longer fails at startup with "Unsupported under SDK-backed ACP: --continue" when `autoResume` is on and the working directory has a previous session with history. The ACP process now keeps only an in-memory session, so it never opens, or holds, the directory's newest session; ACP sessions still run in broker-launched hosts or attach to the process that owns them.
- `gjc acp --resume <session>` and `gjc acp --fork <session>` are rejected as unsupported before anything is opened or forked. Previously the session was opened, or the fork created, first, and then the launch failed.
