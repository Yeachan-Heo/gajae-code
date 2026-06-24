---
name: gjc-session
description: Use GJC's published tmux session helpers for Clawhip-visible worktree sessions, prompt injection, tail checks, and harness owner debugging.
---

# GJC session helpers

Use this skill when a task needs an operator-visible GJC session in tmux: Clawhip/Hermes/OpenClaw can watch the pane, route stale-session alerts, and send follow-up prompts while the work stays in a dedicated git worktree.

Prefer Coordinator MCP for pure machine control. Prefer RPC/ACP when a host owns the tools. Use this visible-session helper flow when humans or chatops need tmux scrollback and a stable session name.

## Public helpers

- `scripts/gjc-session/create.sh` starts interactive `gjc` in a named tmux session, validates the worktree, preserves the pane after exit, and optionally registers a Clawhip-style router watch.
- `scripts/gjc-session/prompt.sh` sends text or an `@file` prompt after the pane looks like a ready GJC TUI.
- `scripts/gjc-session/tail.sh` captures bounded pane output for readiness and acceptance checks.
- `scripts/gjc-session/harness-tmux-owner-start.sh` starts the harness RuntimeOwner inside tmux for dogfood/debug cases that need visible owner liveness.
- `docs/gjc-session-clawhip-routing.md` documents the full routed-session contract.

## Standard flow

1. Prepare a dedicated worktree and branch for the issue or PR. Do not use the canonical checkout for visible routed work.
2. Pick a stable, unambiguous session name that includes the repository and artifact id, such as `gajae-code-issue-1055-gjc-session-skill`.
3. Start the session:

   ```sh
   ./scripts/gjc-session/create.sh <session-name> <worktree-path> [channel-id] [mention]
   ```

   Channel ids and mentions are runtime inputs owned by the host/router. Never hard-code private ids, bot mentions, credentials, tokens, or private host paths into public docs or scripts.
4. Confirm readiness with bounded tail output:

   ```sh
   ./scripts/gjc-session/tail.sh <session-name> 80
   ```

   Wait for a ready GJC TUI signal such as `Gajae forge`, `Type your message`, `> Type your message`, or `Working`.
5. Send the actual task separately:

   ```sh
   ./scripts/gjc-session/prompt.sh <session-name> @/path/to/task.md
   ```

6. Verify prompt acceptance from work evidence, not from pasted text alone. Acceptable evidence includes a tool call or file read, a plan/todo update, a diff or test command, a GitHub comment/review/PR URL, or a terminal verdict such as `MERGE_READY` or `REQUEST_CHANGES`.

## Prompt expectations

Include repository, worktree, branch, base branch, issue/PR id, scope, non-goals, verification, and whether to commit/push/open a PR. Keep channel and mention values outside the prompt unless the host policy explicitly requires them.

## Harness owner sessions

For harness/RPC dogfooding where the RuntimeOwner itself must remain visible, use:

```sh
./scripts/gjc-session/harness-tmux-owner-start.sh <session-name> <workspace> [issue-or-pr] [branch-label] [base]
```

The helper requires the branch label to match the workspace checkout and prints `SESSION_ID`, `STATE_ROOT`, `TMUX_SESSION`, and a bounded monitor-capture command.

## Anti-patterns

- Starting long-running visible repo work with `gjc -p` instead of an interactive tmux session.
- Running the owner process under short shell timeouts or wrappers that can SIGKILL the session.
- Treating tmux process existence or a visible pasted prompt as proof of acceptance.
- Launching from a shared canonical checkout instead of a task worktree.
- Hard-coding private channel ids, mentions, tokens, credentials, or internal-only paths.
