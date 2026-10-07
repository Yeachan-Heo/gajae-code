### Fixed

- Recover and release Windows config/SDK session index locks whose NTFS file IDs have the high bit set. Canonicalize signed runtime IDs to the native unsigned representation while preserving exact owner, content, and file-generation checks, including detached cleanup.
