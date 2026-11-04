### Fixed

- ACP `session/list` no longer advertises a session for every `gjc --mode=acp` process. The ACP process registered the unused startup session it never runs as a direct session, so each restart left an entry with no transcript that `session/load` rejected with `not_found`.
