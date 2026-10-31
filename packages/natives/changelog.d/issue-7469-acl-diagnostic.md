### Fixes

- Windows `gjc update` failures on `acl_present` now return structured diagnostic details: the offending principal (account name when resolvable, SID string otherwise) and whether the ACE is inherited. JavaScript layer formats these into actionable error messages that explain the security issue and how to remediate it (e.g. disable inheritance on `%LOCALAPPDATA%\gjc` and remove the offending principal's ACE). The stable error code `acl_present` remains unchanged for compatibility with existing callers and tests (issue #7469).
