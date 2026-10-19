### Fixed

- Ultragoal change-set capture no longer fails with "unable to resolve an authoritative integration base" when the repository's only integration ref is the checked-out branch (for example a trunk-only checkout or a single-branch clone). The checked-out branch is used as the fallback base, so the change set is exactly the working-tree diff.
