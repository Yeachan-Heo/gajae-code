### Fixed

- `spawnedBy` on `gjc sdk search`, `gjc sdk session list`, and master peer snapshot rows is matched against the canonical (symlink-resolved) state root recorded when the spawned child registered. Previously the stored path spelling was re-resolved at listing time, so retargeting a symlinked state root could attach the old owner to a different host that later reused the child's session id. Spawn authority recorded before this change carries no canonical root and no longer names an owner on any row.
