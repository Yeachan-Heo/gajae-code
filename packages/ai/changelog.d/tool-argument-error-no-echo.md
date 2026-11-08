### Fixed

- A rejected tool call no longer echoes the caller's arguments. The validation failure used to end with `Received arguments:` and a copy of the whole payload — files, paths, free text and any credential a caller put in an argument — which then reached the transcript and every journal that stores errors. The message now ends with `Rejected fields:` and the paths that were rejected (bounded to 12, then `… and N more`), which is what repairs the call; the per-issue lines still name the constraint without repeating the value.
