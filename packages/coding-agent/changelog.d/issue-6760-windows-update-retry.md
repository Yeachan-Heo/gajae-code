### Fixed

- Retry transient Windows replacement failures only while the installed binary remains published; after a retained-publication denial, restore the predecessor before returning. Preserve and reuse verified candidates, surface retained cleanup paths even during rollback, and preserve the structured error code through `doctor install.restore-binary`.
