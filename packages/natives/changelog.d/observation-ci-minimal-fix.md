### Fixed

- `embed-native --reset` restores the constant null stub before the provenance gate runs, so an untrusted artifact in the directory can no longer block unembedding. Normal embedding still verifies the trusted record before any `require` or output mutation.
- The non-Darwin diagnostic snapshot stubs are lint-clean opaque types with `const` unsupported answers instead of uninhabited enums, and `NativeDiagnosticSnapshot.close` releases the lease without an explicit drop of a non-`Drop` value.
- The unsupported lease stubs keep their method receivers, with the `unused_self` suppression scoped to those two methods so the lease API stays identical on every target.
- Diagnostic loader, provenance and CI-shell test fixtures create their workspaces under the canonical absolute `os.tmpdir()`, so an unset `TMPDIR` no longer produces a relative path that the deletion guard refuses.
