### Fixed
- Bound committed GC retirement history in existing readers, publishers, discovery, and protocol inspection before retaining inventory or allocating oversized receipts; serialize appends across transcript targets and reject projected per-target capacity before publication and noncontiguous or expanding continuations without granting broader deletion authority.
- Revalidate every originally processed scope's receipt inventory or absence before discovery returns, refusing late journals and populated scopes without adopting new authority.
