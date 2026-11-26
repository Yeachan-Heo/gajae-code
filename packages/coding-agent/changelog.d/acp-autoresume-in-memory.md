### Fixed

- `gjc acp` no longer fails at startup with "Unsupported under SDK-backed ACP: --continue" when `autoResume` is on and the working directory already has a session. The ACP process now keeps only an in-memory session, so it never opens, or holds, the directory's newest session; ACP sessions still run in broker-launched hosts or attach to the process that owns them.
