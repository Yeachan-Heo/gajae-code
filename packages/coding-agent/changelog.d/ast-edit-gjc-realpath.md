### Fixed

- `ast_edit` apply checks the real write path and the original preview path, so a directory symlink such as `src` → `.gjc` cannot bypass the `.gjc/**` block, and a `.gjc` directory that points at another in-workspace directory stays blocked.
