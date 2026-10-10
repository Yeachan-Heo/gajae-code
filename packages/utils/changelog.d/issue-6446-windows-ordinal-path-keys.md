### Fixed
- Build stable Windows path keys with ordinal filesystem casing and proven volume-level case-insensitive semantics so distinct Unicode filename spellings do not collide.
- When a parent lacks a usable file ID, canonicalize its path when possible and fold only the final entry name, preserving ancestor casing.
- Keep stable path identity in a dedicated subpath so importing the utils root barrel does not load native bindings.
- Normalize ordinary Win32 trailing-dot and trailing-space aliases when deriving keys for missing path entries.
