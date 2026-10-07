### Fixed

- Finalize every statement when closing owned auth and model-cache SQLite connections, releasing Windows file handles immediately without relying on garbage collection.
