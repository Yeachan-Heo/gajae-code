### Fixed

- Windows exact-replace-retained binary update now requests READ_CONTROL access on both file handles, enabling GetSecurityInfo() to verify ownership-only ACL enforcement. Without READ_CONTROL, GetSecurityInfo() returned acl_unavailable on every real Windows update, blocking all retained installations with "acl_unavailable" status. (#6096)
