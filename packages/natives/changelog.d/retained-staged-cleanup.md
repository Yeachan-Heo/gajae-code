### Added

- Added creator-owned POSIX child-directory capabilities with exclusive creation, original-parent durability continuation, nonrecursive empty-directory retirement, live-child refusal, and checked final-parent release. Directory collision, replacement, ambiguous closure, and partial construction never authorize pathname-based cleanup. These primitives do not establish artifact-tree or runtime teardown by themselves.
- Added retained POSIX staged-file cleanup capabilities with explicit descriptor-close and directory-durability receipts. Published hard-link alias retirement is distinct from rollback, and stale native addons are rejected when required cleanup methods are missing.
