# 22 — Bash tool glob `*/` matches plain files (trailing-slash dir-only semantics violated)

- **Severity:** Medium (silent wrong results + spurious nonzero exits)
- **Scope:** bash tool session shell glob expansion (gjc 0.14.2)
- **Surface:** `bash` tool command execution

## Summary

In a gjc `bash` tool session, a glob with a trailing slash (`pattern*/`) expands
to **all** matching entries with `/` appended — including regular files — instead
of matching directories only, as POSIX/bash globbing requires.

## Reproduction (2026-08-22, gjc 0.14.2, macOS arm64)

Inside the gjc bash tool session, cwd `~/Projects/gajae-code`:

```
$ printf '%s\n' LICENSE*/ tsconfig.json*/
LICENSE/
tsconfig.json/
```

`LICENSE` and `tsconfig.json` are regular files. Control — real bash in the same
directory:

```
$ bash -c 'printf "%s\n" LICENSE*/'
LICENSE*/          # no match → literal (nullglob off), correct
```

Real bash 5.2 never matches a file against `*/`. The session shell reports
`BASH_VERSION=5.2.37` but its glob expansion is clearly not bash's — globs appear
to be pre-expanded by the harness (or a bash-emulating shell, e.g. Bun Shell
semantics) with trailing-slash directory-only filtering missing.

## Impact

- `ls -d some/path/*/` — the standard "list subdirectories" idiom — emits
  `ls: <file>/: Not a directory` for every plain file and **exits 1**, so the
  tool result renders as ✘ even though the directory listing itself succeeded.
  Observed in a live session against `~/Projects/gajae-code/*/`.
- Any `for d in */` loop iterates over files, feeding wrong paths downstream.
- Silent correctness hazard: scripts that rely on dir-only globs get files.

## Expected

`pattern*/` matches directories (and symlinks to directories) only, matching
POSIX shell and bash behavior. If a glob pre-expander is used, it must apply
trailing-slash directory filtering before substitution.

## Resolution (2026-08-22)

Root cause: the bash tool's session shell is the vendored brush shell
(`crates/brush-core-vendored`), whose `Pattern::expand` appended components
after the last glob component literally with no filesystem check / the trailing
`/` splits into a final empty component that was pushed without a directory
check. Fixed in `patterns.rs`: trailing-separator patterns now require
`is_dir()` (follows symlinks, matching bash) and literal suffix components
require lstat existence. Regression tests:
`test_trailing_slash_glob_matches_directories_only`,
`test_literal_suffix_after_glob_requires_existing_path` (verified RED on the
pre-fix expander, GREEN after). Same class fixed for `*/name` fabricating
nonexistent paths.
