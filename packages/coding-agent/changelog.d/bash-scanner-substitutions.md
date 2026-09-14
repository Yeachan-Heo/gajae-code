### Fixed

- `$(...)` and backtick command substitutions are scanned by the bash mutation guard. The mutation scanners anchor on statement boundaries, which never see inside a substitution, so `echo "$(rm -rf src/product.ts)"` passed the planning-phase guard while deleting the file. Substitution bodies are now rescanned like an `sh -c` payload under the same bounded depth, after syntax-aware masking removes inert data-heredoc bodies and shell comments; single-quoted spans stay inert because they suppress substitution.
