# Telegram `/session_create worktree` isolation bug

## Baseline

- Branch: `fix/telegram-session-create-worktree-isolation`
- Reproduction base: `upstream/dev` at `12aa7ebd18752c338b55a6ddc0ca8945f6e555cb`
- Minimal-fix review base: `upstream/dev` at `38571d19a3c3210e517ebee1eaf201c5990efe51`
- Reported: 2026-07-22

## Reproduction

From the paired Telegram chat, run:

```text
/session_create worktree /home/jhchoi/clone/gajae-code fix-telegram-close
```

Then inspect the launched session:

```bash
git rev-parse --show-toplevel
git branch --show-current
git worktree list --porcelain
```

## Expected behavior

The lifecycle command parser should produce a `worktree` target with:

- repo: `/home/jhchoi/clone/gajae-code`
- branch: `fix-telegram-close`

The lifecycle launcher should start GJC with `--worktree=fix-telegram-close`. GJC should create or reuse an isolated sibling worktree under a path like:

```text
/home/jhchoi/clone/gajae-code.gajae-code-worktrees/fix-telegram-close
```

The new session's effective cwd and Git top-level should be that linked worktree, not the primary checkout.

## Observed behavior

The created Telegram session was attached to:

```text
/home/jhchoi/clone/gajae-code
```

Its current branch was the pre-existing PR branch:

```text
fix/telegram-session-resume-supervisor
```

`git worktree list --porcelain` contained no worktree corresponding to `fix-telegram-close`. As a result, work intended for an isolated session could modify the dirty primary checkout and its unrelated PR branch.

## Relevant code path

- `packages/coding-agent/src/sdk/bus/lifecycle-commands.ts`
  parses `/session_create worktree <repo> <branch>`.
- `packages/coding-agent/src/sdk/bus/lifecycle-control-runtime.ts`
  converts a worktree target into `cwd=<repo>` and `args=["--worktree=<branch>"]`.
- `packages/coding-agent/src/commands/launch.ts`
  calls `prepareLaunchWorktree()` and changes into the resulting cwd.
- `packages/coding-agent/src/gjc-runtime/launch-worktree.ts`
  plans and creates the sibling Git worktree.

The source path appears to describe the expected isolated behavior, so investigation must locate where the Telegram request, lifecycle frame, child argv, or effective launch cwd diverges at runtime. Do not assume this is merely a coordinator configuration issue: this reproduction uses the Telegram lifecycle command's explicit `worktree` target.

## Investigation requirements

1. Add an end-to-end regression test beginning with the exact Telegram command text.
2. Assert the parsed lifecycle target remains `kind: "worktree"` through daemon dispatch.
3. Assert child argv contains exactly `--worktree=fix-telegram-close` and the child cwd is the canonical repo root.
4. Assert the launched session reports a linked-worktree cwd and branch `fix-telegram-close`.
5. Verify no Git-managed files, index entries, HEAD, or branch state in the primary checkout are changed.
6. Check whether an installed/stale daemon binary can disagree with the source checkout and ensure diagnostics expose the exact supervisor/child runtime argv and final tmux cwd.

## Acceptance criteria

- The exact reproduction command always creates or safely reuses an isolated linked worktree.
- The session header, tmux project/branch metadata, and runtime cwd agree on the linked-worktree path and branch.
- Failure to create or enter the worktree fails closed; it must never silently continue in the source checkout.
- Existing `path` and `dir` targets retain their documented behavior.
- Lifecycle control state may remain under the primary checkout's ignored `.gjc`; this must not alter Git-managed primary content, index, HEAD, or branch state.
