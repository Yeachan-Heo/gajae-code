### Fixed

- Accept a Windows executable owned by `BUILTIN\Administrators` and carrying the default profile DACL (`SYSTEM`/`Administrators` full control, read/execute for others) during exact replacement, so `gjc update` no longer fails with `owner_mismatch` or `acl_present` on elevated or stock `%LOCALAPPDATA%` installs. Write grants to any other principal are still refused (issues #6096, #6916).
