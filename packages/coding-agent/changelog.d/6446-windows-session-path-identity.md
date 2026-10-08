### Fixed

- Match Windows session paths by filesystem identity without rewriting canonical paths or conflating distinct case-sensitive files. Managed-root containment now canonicalizes the nearest existing path prefix, so 8.3 aliases do not appear to escape their root.
