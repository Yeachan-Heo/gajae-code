### Added

- Added global `auth.credentialPreferences` (provider → `email:`/`account:` selector) and `auth.credentialPreferenceMaxUsedPercent` (greater than 0 and at most 100, default 100) config. A preferred account, such as a lower-cost plan, is used first and the provider falls back to normal ranking once that account reaches the usage threshold or hits a quota/rate-limit failure, without the session-blocking behavior of `auth.credentialPins`. Both keys are global-only and ignored in project settings.
