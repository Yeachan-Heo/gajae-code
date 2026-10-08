### Fixed

- Match Windows session paths by filesystem identity without rewriting canonical paths or conflating distinct case-sensitive files. Managed-root containment canonicalizes aliases above the root and rejects symlink components below it.
- Reject managed descendant symlinks before canonicalizing paths, preventing a replaced scope directory from redirecting access to a sibling session.
