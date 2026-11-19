### Fixed

- Configured `org:` credential preferences match the organization id only and are skipped when no active OAuth row or several active OAuth rows hold it, so an ambiguous or removed organization never fails credential selection or moves to another organization by display name.
- The auth-broker client's credential inventory now includes the email, account id, project id, and organization of active OAuth rows (no token material), matching the local store.
