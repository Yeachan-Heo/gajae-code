### Fixed
- Detect project-declared `TMPDIR` from the workflow guard caller's cwd while retaining startup dotenv declarations after `.env` is removed or the process changes directories.
- Bound workflow-guard dotenv provenance reads to regular files no larger than 64 KiB; unsafe layers fail closed for non-system temp roots.
