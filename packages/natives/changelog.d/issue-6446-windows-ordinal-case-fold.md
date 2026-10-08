### Added
- Export a Windows ordinal case-folding primitive for filesystem-aware path identity.
- Expose path metadata and ordinal folding through a lazy subpath so utilities can load before the native addon is built.

### Fixed
- Use volume capabilities as a conservative fallback when per-directory case flags are unsupported.
