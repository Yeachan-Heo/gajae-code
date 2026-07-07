# `bisect` tool

`bisect` finds the exact commit that introduced (or fixed) a behavior by driving
`git bisect` with a shell predicate, then restores the working tree and reports
the culprit. It is a discoverable built-in tool (activated on demand through
`search_tool_bm25`, like `debug`, `recipe`, and `checkpoint`).

## Why a tool instead of raw `git bisect`

Running `git bisect` by hand is error-prone for an agent: it is easy to forget
`git bisect reset`, misread which commit is culpable, or strand the repository
in a detached bisect state. The tool:

- validates preconditions before touching repo state,
- always runs `git bisect reset` in a `finally` block and then discards any
  tracked-file edits the predicate made with `git reset --hard`, so the working
  tree's tracked files are restored to their pre-bisect state even on error or
  abort (untracked files the predicate created are left in place — the tool
  never deletes files it did not create),
- returns a structured, durable result (culprit + per-step verdicts) instead of
  scrollback that must be re-parsed.

## Parameters

| Name | Default | Meaning |
| --- | --- | --- |
| `good` | — (required) | The **older** endpoint; must be an ancestor of `bad`. |
| `bad` | `HEAD` | The **newer** endpoint. |
| `run` | — (required) | Shell command evaluated at each revision. |
| `invert` | `false` | Find the commit that *fixed* the behavior instead. |
| `maxSteps` | `40` | Maximum bisection steps before giving up. |
| `stepTimeoutMs` | `600000` | Per-step timeout; a timed-out step counts as a skip. |

### Predicate exit-code contract

`run` is executed as `sh -c <run>` from the repository root (the top level of the
working tree) at each candidate commit — even when the tool is invoked from a
subdirectory. Its exit code is mapped to a verdict:

| Exit code | Verdict |
| --- | --- |
| `0` | good |
| `125` | skip (revision cannot be tested) |
| any other non-zero | bad |

### Search direction

`git bisect` requires `good` to be an ancestor of `bad`, so `good` is always the
older endpoint and `bad` the newer one, in both modes.

- **Default (find the regression):** the predicate passes at `good` and fails at
  `bad`. The tool reports the first commit that turned it bad.
- **`invert: true` (find the fix):** the predicate fails at `good` and passes at
  `bad`. Internally the good/bad verdict of each intermediate commit is flipped,
  so the search reports the first commit that turned it good. A skip is never
  reinterpreted.

## Preconditions

- The current directory must be inside a git worktree.
- The worktree must be clean (no uncommitted tracked changes). Commit or stash
  first — bisect checks out historical commits and would clobber uncommitted
  work.
- `good` must resolve, `bad` must resolve, they must differ, and `good` must be
  an ancestor of `bad`.

## Result

On success the tool reports the first bad (or first fixing) commit with its
author, date, subject, and changed files, plus every revision it tested and
their verdicts. When the search cannot converge (only skipped commits remain, a
`git bisect` step fails, or `maxSteps` is reached) it reports the reason and the
revisions tested. In all cases every tracked file is restored to its pre-bisect
state; if the predicate created untracked files, the result says so and leaves
them in place.

## Examples

Find the commit that broke a specific test (older `v1.4.0` passes, `HEAD` fails):

```json
{ "good": "v1.4.0", "bad": "HEAD", "run": "bun test test/login.test.ts" }
```

Find the commit that fixed a bug (older `v1.0.0` fails, `HEAD` passes):

```json
{ "good": "v1.0.0", "bad": "HEAD", "run": "bun test test/login.test.ts", "invert": true }
```

## Implementation

- Tool + pure loop controller + parsers: `packages/coding-agent/src/tools/bisect.ts`
- `git bisect` wrappers: the `bisect` namespace in `packages/coding-agent/src/utils/git.ts`
- Description: `packages/coding-agent/src/prompts/tools/bisect.md`

The bisect loop is a pure function (`runBisectController`) with all git and
predicate effects injected, so it is unit-tested without a real repository;
`parseFirstBadCommit` and `classifyExit` are tested independently, and an
integration test drives the whole tool against a real temporary git repository.
