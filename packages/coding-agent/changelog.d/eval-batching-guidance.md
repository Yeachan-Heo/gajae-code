### Changed

- Eval's tool description now recommends batching `tool.<name>()` calls in one cell only for read-only, approval-free tools (`read`, `search`, `find`, `ast_grep`, `lsp` lookups). It tells the model not to batch through eval when the session asks for approval on tool calls, and to call `bash`, `edit`, `write`, and other side-effecting tools directly (#6237).

### Fixed

- Conditional TTSR rules scoped to `tool:<name>` now apply to nested eval `tool.<name>()` calls. A match folds the rule reminder into the eval result, and an interrupting match keeps the nested call from running (#6237).
