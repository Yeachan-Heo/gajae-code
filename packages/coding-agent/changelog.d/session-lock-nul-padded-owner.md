### Fixed

- Stop a session's coordinator state persistence from failing permanently with `terminal_persistence ... lock_owner_record_unprovenanced` when its `runtime-state.json.lock` owner record ends in zero-filled bytes. File-system filters such as cloud-sync placeholders, or crash recovery, can leave such a tail after an otherwise complete record. Owner records now ignore trailing NUL padding the same way they already ignore the writer's space padding. A NUL inside the record still fails closed.
