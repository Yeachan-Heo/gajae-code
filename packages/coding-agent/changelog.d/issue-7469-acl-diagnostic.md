### Fixes

- Windows `gjc update` failures on inherited ACL violations now report the offending principal and explain remediation steps. Instead of a bare `acl_present` error, the user sees actionable guidance: "Remove '<PrincipalName>' ACE from %LOCALAPPDATA%\gjc (inherited from parent; disable inheritance with `icacls '<dir>' /inheritance:d` first)" (issue #7469).

### Documentation

- Added Windows DACL requirements to install documentation: supported principals (current user, SYSTEM, Administrators), inherited ACL handling, and remediation steps for custom or sandbox-inherited ACLs.
