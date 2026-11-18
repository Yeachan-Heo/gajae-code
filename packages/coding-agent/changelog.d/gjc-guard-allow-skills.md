### Fixed

- Agent file tools (`write`, `edit`, `ast_edit`, `python`/`eval`) can now create and edit project skills under `.gjc/skills/<name>/`; previously the always-on `.gjc/**` guard refused them even though no `gjc` CLI command writes skills. The `.gjc/skills` directory itself, every other `.gjc/**` path, `..` escapes, and symlink/hardlink redirects into other `.gjc` state stay blocked, and planning-phase boundaries are unchanged.
