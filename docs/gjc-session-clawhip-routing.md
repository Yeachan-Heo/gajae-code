# Clawhip-routed GJC sessions

This guide documents the visible tmux session pattern used by operator bots such as Clawhip, Hermes, and OpenClaw when repository work must stay observable in a routed channel.

Use this pattern when a human or chatops router needs to watch the session, receive stale-session alerts, and send follow-up prompts into the same visible GJC pane.

For pure machine control, prefer the Coordinator MCP tools in [`docs/hermes-mcp-bridge.md`](./hermes-mcp-bridge.md). For a single embedded worker process, prefer [`docs/rpc.md`](./rpc.md). This visible-session pattern is the operator-facing fallback/interop lane.

## Contract

1. Create or verify a dedicated git worktree for the issue or PR.
2. Register a named tmux session with the host router before launching GJC.
3. Start interactive `gjc` inside the worktree.
4. Wait until the GJC TUI is ready.
5. Inject the real task prompt separately.
6. Verify acceptance from actual work evidence, not from a visible pasted prompt.

Do not launch visible routed work in the canonical repo checkout. Use a worktree so branch changes, generated files, tests, and cleanup stay scoped to the task.

## Session naming

Use stable names that include the project and artifact id:

```text
gajae-code-issue-905-ctrl-shift-enter-newline
gajae-code-pr-911-ctrl-shift-enter-review
clawhip-issue-269-lightweight-zero-receipt
```

Avoid ambiguous names such as `fix-tui`, `review`, or `issue-905` when multiple repositories route into the same chat surface.

## Portable script shape

The exact router command is host-owned. A Clawhip-style wrapper usually has three small scripts:

```sh
# create.sh
# create/register a routed tmux session and start interactive gjc in the worktree
scripts/gjc-session/create.sh <session-name> <worktree-path> [channel-id] [mention]

# prompt.sh
# inject the real task after the TUI is ready
scripts/gjc-session/prompt.sh <session-name> @/path/to/task.md

# tail.sh
# inspect bounded pane output before/after prompt delivery
scripts/gjc-session/tail.sh <session-name> [lines]
```

This repository includes a portable implementation in `scripts/gjc-session/`. It keeps private routing values outside the script body: channel ids and mentions are runtime arguments, the router binary is optional, and credentials are never embedded. Host deployments can still override router behavior with environment variables instead of editing the scripts.


## Included helper scripts

The `scripts/gjc-session/` directory contains the public version of the operator helpers:

- `create.sh` validates a dedicated git worktree, starts interactive `gjc` in tmux, preserves the pane after exit, and optionally registers a Clawhip-style `tmux watch`.
- `prompt.sh` sends a text or `@file` prompt only after the pane looks like a ready GJC TUI, then sends multiple Enters to handle terminal submission edge cases.
- `tail.sh` captures bounded pane output for readiness and acceptance checks.
- `harness-tmux-owner-start.sh` starts the GJC harness control plane with the RuntimeOwner resident inside tmux for dogfood/debug cases that need visible owner liveness.

Configuration is runtime-only:

```sh
export GJC_BIN=/path/to/gjc                         # optional; defaults to command -v gjc
export GJC_SESSION_FLAGS="--model provider/model"   # optional interactive gjc flags
export GJC_SESSION_ROUTER=clawhip                   # optional router binary
export GJC_SESSION_SKIP_ROUTER=1                    # skip router registration
export GJC_SESSION_STALE_MINUTES=60                 # router stale window
export GJC_SESSION_KEYWORDS="/skill:ralplan,Question"
```

No token, channel id, mention, workspace root, or private host path is hard-coded. Pass channel/mention values at invocation time when your router needs them.

## Example flow

```sh
# 1. Prepare a dedicated worktree.
git -C /repo/gajae-code fetch origin dev
git -C /repo/gajae-code worktree add \
  /repo/worktrees/gajae-code-issue-905-ctrl-shift-enter-newline \
  -b issue-905-ctrl-shift-enter-newline origin/dev

# 2. Start the routed visible session.
./scripts/gjc-session/create.sh \
  gajae-code-issue-905-ctrl-shift-enter-newline \
  /repo/worktrees/gajae-code-issue-905-ctrl-shift-enter-newline \
  "$CHANNEL_ID" \
  "$MENTION"

# 3. Confirm TUI readiness.
./scripts/gjc-session/tail.sh gajae-code-issue-905-ctrl-shift-enter-newline 80

# 4. Inject the task prompt.
./scripts/gjc-session/prompt.sh \
  gajae-code-issue-905-ctrl-shift-enter-newline \
  @/tmp/issue-905-task.md

# 5. Confirm real work started.
./scripts/gjc-session/tail.sh gajae-code-issue-905-ctrl-shift-enter-newline 160
```

## Prompt shape

Implementation prompt:

```text
/skill:ralplan

gjc ultragoal fix issue #905 missed Ctrl+Shift+Enter newline case.

Repo: Yeachan-Heo/gajae-code
Worktree: /repo/worktrees/gajae-code-issue-905-ctrl-shift-enter-newline
Branch: issue-905-ctrl-shift-enter-newline
Base: dev

Scope:
- inspect parser/key matching and packages/tui/src/components/editor.ts
- add explicit ctrl+shift+enter newline handling
- add focused tests for the reported terminal sequences
- run targeted verification
- commit, push, and open a PR to dev

Non-goals:
- no unrelated tmux/session/process changes
- no synchronous filesystem, process, tmux, network, or durable writes in keystroke paths
```

Review prompt:

```text
/skill:ralplan

Review PR #911 as a red-team-only merge gate.
Inspect origin/dev...HEAD, changed files, CI, and contract risks.
Look for blockers, regressions, test gaps, and hidden user-facing drift.
Post MERGE_READY or REQUEST_CHANGES with evidence. Do not merge.
```

## Acceptance checks

After prompt delivery, require one of these before reporting that the session is working:

- a tool call or file read in the pane,
- an explicit plan or todo update,
- a diff or test command,
- a GitHub comment/review/PR URL,
- a terminal verdict such as `MERGE_READY` or `REQUEST_CHANGES`.

A prompt being visible in tmux scrollback is not acceptance by itself.

## Anti-patterns

- Starting `gjc -p` for long-running visible repo work.
- Launching from the canonical repo checkout instead of a task worktree.
- Running a long GJC/tmux session under a short shell timeout that can SIGKILL the owner process.
- Treating tmux process existence as proof that the prompt was accepted.
- Hard-coding private channel ids, bot mentions, or router tokens into public GJC docs.
- Using this visible-session pattern when Coordinator MCP turn state is available and sufficient.
