### Fixed
- Pin an immutable parent identity for each managed remnant-reaping pass, while requiring genuine native no-follow and exact-identity validation for every removal. Refuse replacement directories instead of adopting them mid-pass, preserve failure accounting, and avoid redundant parent observations.
