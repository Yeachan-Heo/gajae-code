# Human-owned GJC tmux sessions

A tmux-hosted GJC TUI is a **human-only terminal surface**. It is not an external control or viewing API.

## Human operator use

A human operator may start an interactive TUI in a dedicated worktree for local terminal visibility:

```sh
./scripts/gjc-session/create.sh <session-name> <worktree-path>
```

The person at that terminal interacts with the TUI directly. The helper retains durable, public owner-lifecycle receipts for local troubleshooting; it never accepts routed prompts, exposes pane output, or registers a machine observer.

## External bots and machines

All external bots, machines, and automation must use a canonical external surface:

- Coordinator MCP for bounded workflow control, turn status, questions, and reports.
- ACP for an ACP client over the SDK-backed session surface.
- The Gajae-Code SDK for authenticated lifecycle, control, and query operations.

Do not inject prompts, scrape terminal output, or use tmux state as workflow evidence. Use Coordinator lifecycle events and SDK status for external decisions, notifications, and audit records.

## Boundaries

- Keep visible work in a dedicated worktree, never the shared canonical checkout.
- Treat tmux existence and terminal output as human-only diagnostics.
- Keep all bot credentials and routing configuration in the external Coordinator MCP/ACP/SDK deployment, not in the tmux helper.