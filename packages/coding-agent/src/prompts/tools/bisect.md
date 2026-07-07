Find the exact commit that introduced (or fixed) a behavior by driving `git bisect` with a shell predicate, then restore the working tree and report the culprit.

Use this instead of running `git bisect` by hand when you have a reproducible pass/fail check and a known-good and known-bad revision. The tool guarantees clean setup and teardown: it always runs `git bisect reset` and then discards any tracked-file edits the predicate made (`git reset --hard`), so it never leaves the repository stranded in a detached bisect state or with the predicate's tracked-file modifications behind. Untracked files the predicate creates are left in place (the tool never deletes files it did not create).

Parameters:
- `good`: the OLDER endpoint — a commit that must be an ancestor of `bad`.
- `bad`: the NEWER endpoint (defaults to `HEAD`).
- `run`: the shell command evaluated at each revision. Exit `0` = good, `125` = skip (untestable revision), any other non-zero = bad.
- `invert`: set true to find the commit that FIXED the behavior instead of the one that broke it.
- `maxSteps` / `stepTimeoutMs`: bounds; a step that exceeds `stepTimeoutMs` is treated as a skip.

Search direction:
- Default (find the regression): the predicate passes at `good` and fails at `bad`. The tool reports the first commit that turned it bad.
- `invert` (find the fix): the predicate fails at `good` and passes at `bad`. The tool reports the first commit that turned it good.

Rules:
- Requires a git repository and a clean working tree. Commit or stash uncommitted changes first — bisect checks out historical commits and would clobber them.
- `good` must resolve, `bad` must resolve, they must differ, and `good` must be an ancestor of `bad`.
- Make `run` self-contained and deterministic (build + test in one command). It always runs from the repository root (the top level of the working tree), even when the tool is invoked from a subdirectory — reference files by repo-relative paths, and do not assume the current subdirectory exists at every candidate commit.
- Prefer a narrow predicate that targets only the behavior you are hunting, so unrelated breakage does not mislead the search.

The result reports the first bad (or first fixing) commit with its author, date, subject, and changed files, plus every revision tested. Every tracked file is restored to its pre-bisect state; if the predicate created untracked files they are reported and left in place.
