### Fixed

- Match Windows session paths by filesystem identity without rewriting canonical paths or conflating distinct case-sensitive files. Managed-root containment canonicalizes aliases above the root and rejects symlink components below it.
- Reject managed descendant symlinks before canonicalizing paths, preventing a replaced scope directory from redirecting access to a sibling session.
- Keep native-backed endpoint key derivation out of the broadly imported async barrel so idle startup does not load path identity bindings.
