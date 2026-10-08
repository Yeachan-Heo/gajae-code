### Fixed

- Admit GC receipt-history bytes from the original descriptor before allocation, bound reads to its captured size, and reject named-file generation changes in leased and read-only receipt readers.
- Preserve a managed-file capture failure when reader cleanup also fails.
