### Added

- **diff_comment tool**: New tool for leaving structured comments on specific diff lines, inspired by [JetBrains/thinkrail](https://github.com/JetBrains/thinkrail) (Apache-2.0).
  - `add`: Annotate a specific file and line range with a comment
  - `resolve`: Mark a comment as addressed after you've fixed it
  - `list`: View all unresolved and resolved comments
  - Session-scoped storage: Comments persist across turns in the same session
  - Supports optional resolution notes to document what you did about each comment
