### Fixed

- Report a denied staged-source or destination-parent open in Windows `renameNoReplacePath` as a pre-mutation `access_denied` instead of `owner_mismatch`, so file-lock publication retries the transient denial rather than failing with `Failed to publish file lock: owner_mismatch` (for example `terminal_persistence` notices on cloud-synced or Administrators-owned `.gjc` directories).
