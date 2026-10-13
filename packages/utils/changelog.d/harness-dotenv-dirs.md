### Fixed

- A project `.env` can no longer set `GJC_HARNESS_SOCKET_DIR` or `GJC_HARNESS_ROOT_REGISTRY_DIR`. A different literal shell value is kept. A shell value that matches the project declaration, or a dynamic project declaration, is dropped. A double-quoted escape Bun decodes is treated as dynamic and dropped the same way.
