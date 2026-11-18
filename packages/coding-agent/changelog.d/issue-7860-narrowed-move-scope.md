### Fixed

- Restored `moveTo` relocation for non-shared sessions to simpler header patch + rewrite approach, reverting header-only patch complexity that drew multiple P1s (#7860)

### Removed

- Move Session tool in shared root TUI sessions returns to unsupported (pre-#7858 behavior); move in shared sessions requires fenced design pending #7856 follow-up
