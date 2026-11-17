### Fixed

- Join retained native OPEN calls across reconciliation, real runtime construction, and publication, preventing a second factory invocation while the first is held.
- Check presentation branch/reset transcript bytes before each operation and after queued settlement, independently from explicit null execution selection.
