### Fixed
- Authenticate managed GC protocol roots, roles, journals, locks, and file identities through read-only stores before task-owner cleanup can obtain sibling-inspection authority. Reject unknown or replaced protocol entries without repair or filesystem mutation.
