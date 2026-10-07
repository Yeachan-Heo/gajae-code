### Fixed
- Bound committed GC retirement history with a 50,000-entry receipt-directory limit shared across each scope and per-transcript limits of 50,000 state files and 512 MiB stored bytes (64 MiB per receipt); serialize cross-transcript appends under a scope-wide lease and reject projected capacity before candidate serialization, allocation, or publication while retaining continuation and authority checks.
- Revalidate every originally processed scope's receipt inventory or absence before discovery returns, refusing late journals and populated scopes without adopting new authority.
