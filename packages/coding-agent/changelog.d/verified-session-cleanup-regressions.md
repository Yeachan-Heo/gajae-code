### Fixed

- Restore SDK deletion and restart reconciliation for owner-free legacy sessions without creating a v2 scope or task-artifact owner.
- Preserve prepared artifact authority when task-owner validation refuses deletion before artifact effects, allowing safe retries after temporary protocol obstructions are removed.
- Retry initial task-owner evidence capture after a managed writer finishes, without replacing already-captured evidence or adopting changed transcripts and retained cleanup authority.
- Keep owner-free disk GC usable after a historical workspace is deleted while retaining fail-closed validation for malformed bindings, substituted protocol paths, and owner-retirement journals.
