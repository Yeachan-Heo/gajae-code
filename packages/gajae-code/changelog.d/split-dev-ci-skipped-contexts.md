### Fixed

- Dev CI workflow now publishes static check context names instead of raw expressions when jobs are skipped due to metadata-only changes. Split three jobs (affected, gjc-state-gates, virtual-integration) into pairs: the main validation job with a static canonical name, and a separate placeholder job with a static "not code evidence" name that runs only when the skip condition is true.
