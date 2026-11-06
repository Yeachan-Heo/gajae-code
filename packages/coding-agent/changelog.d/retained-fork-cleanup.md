### Fixed

- Failed transcript staging and fork construction retain exact cleanup ownership, including unpublished roots and publication uncertainty, instead of treating settled work or retained recovery files as completed rollback.
- SDK startup failures remain bounded while retaining actual late cleanup work. Session disposal joins already-admitted forks, rejects new forks, and attempts independent known-owned descriptor cleanup without erasing historical uncertainty.
- Internal family ownership refreshes only the physical transcript binding after authenticated strict closure; logical family and branch identities remain unchanged.
