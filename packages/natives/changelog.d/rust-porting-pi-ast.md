### Added

- Full-language native AST support now includes Emacs Lisp and Fortran; default-language builds keep their existing language set and Perl remains gated by `full-langs`.
- AST search/edit now accepts multi-node JSON pair patterns and collapses byte-identical rewrite edits, avoiding false overlap errors when patterns produce the same replacement.
