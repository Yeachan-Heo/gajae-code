### Fixed

- Workflow gate answers decode to one validated shape (`{decision}` or `{selected:[label]}`) instead of a bare string, so a remote answer can no longer satisfy a handler that skipped the compiled gate schema.
