### Fixed

- Report Windows retained-replacement `STATUS_ACCESS_DENIED` as `access_denied` and retry transient access-denied or sharing-violation renames within the bounded pre-mutation retry window.
