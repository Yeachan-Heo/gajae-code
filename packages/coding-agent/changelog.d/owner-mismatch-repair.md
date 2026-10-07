### Fixed

- **Windows session management**: permit repair of owner-mismatch errors when .gjc directories have mismatched owners. When a user lacks `SeTakeOwnershipPrivilege` (non-elevated), repair fails with a clear error message instead of a generic startup failure (#6420).
