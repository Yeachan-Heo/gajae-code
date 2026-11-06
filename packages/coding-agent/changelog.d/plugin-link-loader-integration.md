### Fixed

- `gjc plugin link` now registers the linked plugin in the GJC links registry, making it discoverable by the plugin loader. Previously, the link command would succeed but the loader would never see the linked plugin because the registration was not persisted. The links registry keeps linked plugins separate from npm dependencies, so subsequent `bun install` calls preserve the symlinks instead of replacing them with copies.
