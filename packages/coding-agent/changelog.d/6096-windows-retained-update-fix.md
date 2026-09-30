### Fixed

- Windows binary update via exactReplaceRetained now succeeds with owner-only ACL enforcement. The retained update path required READ_CONTROL on both the staged source and current destination handles to query ACL ownership, but the handles were opened without READ_CONTROL, causing every real Windows update to fail with acl_unavailable. (#6096)
