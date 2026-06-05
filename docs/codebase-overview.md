# Codebase Overview

This document maps the main parts of the `gajae-code` repository. The root README stays intentionally small; this file is the architecture-oriented companion.

## Product shape

Gajae-Code (`gjc`) is centered on `packages/coding-agent/`. The public workflow surface is intentionally fixed at four source-bundled skills and four public role subagents. Runtime state, specs, plans, goals, team state, and local overrides live under `.gjc/`.

Default workflow skills are embedded from:

```text
packages/coding-agent/src/defaults/gjc/skills/<name>/SKILL.md
```

Public role subagent prompts are embedded from:

```text
packages/coding-agent/src/prompts/agents/<role>.md
```

The runtime can still discover project/user overrides, but the bundled defaults are loaded from source so a missing project `.gjc` directory does not remove the default workflow surface.

## Packages

### `packages/coding-agent/`

Main `gjc` CLI and product runtime.

- `packages/coding-agent/package.json` exposes the `gjc` binary at `src/cli.ts` and the SDK/barrel entrypoint at `src/index.ts`.
- `packages/coding-agent/src/cli.ts` is the executable bootstrap. It registers CLI commands such as `setup`, `deep-interview`, `ralplan`, `ultragoal`, `team`, and the default launch path.
- `packages/coding-agent/src/main.ts` adapts CLI options into session creation and dispatches interactive, print, RPC, RPC-UI, and ACP modes.
- `packages/coding-agent/src/sdk.ts` assembles settings, model registry, auth, workspace/context discovery, skills, rules, tools, system prompt, and the underlying `@gajae-code/agent-core` agent.
- `packages/coding-agent/src/tools/index.ts` is the built-in tool registry for file/code/runtime tools such as read, bash, edit, AST tools, eval, find/search, LSP, browser, task/subagent, recipe, IRC, todo, web search, and write. Memory backends are private integrations, not public coding-harness tools.
- `packages/coding-agent/src/defaults/gjc-defaults.ts` embeds and installs the default workflow skills.
- `packages/coding-agent/src/task/agents.ts` embeds bundled task-agent prompts. The public contract is `executor`, `architect`, `planner`, and `critic`; other bundled prompts are internal/runtime utilities.

### `packages/ai/`

Provider/model boundary for LLM access.

- `packages/ai/src/index.ts` exports model registry/resolution, provider implementations, auth broker/gateway/storage, streaming, usage, retry/overflow utilities, OAuth, discovery, and validation helpers.
- `packages/ai/src/types.ts` defines provider, model, context, message, tool, usage, reasoning, and stream-event contracts.
- `packages/ai/src/stream.ts` dispatches model-driven streams to the right provider/API implementation and normalizes streaming events.
- `packages/ai/src/model-manager.ts` merges static, cached, dynamic, and remote model sources.
- `packages/ai/README.md` documents tool calling, partial streaming tool calls, thinking/reasoning, provider configuration, context handoff, and OAuth flows.

### `packages/agent/`

Stateful agent runtime built on `@gajae-code/ai`.

- `packages/agent/src/index.ts` exports the `Agent`, loop APIs, append-only context, compaction, telemetry, proxy utilities, thinking helpers, and shared types.
- `packages/agent/src/agent-loop.ts` owns the turn loop: transform context, call the model stream, execute tool calls, append tool results, and emit lifecycle events.
- `packages/agent/src/agent.ts` wraps the loop with mutable state, subscriptions, prompt/continue/abort APIs, queues, provider session state, telemetry, and state mutation helpers.
- `packages/agent/src/types.ts` defines `AgentMessage`, `AgentTool`, loop config, event, and runtime state contracts.

### `packages/tui/`

Terminal UI framework used by the CLI.

- `packages/tui/src/index.ts` exports components, keybindings, autocomplete, terminal abstractions, image support, TUI core, and utilities.
- `packages/tui/src/tui.ts` manages component rendering, focus, overlays, terminal dimensions, diff state, and synchronized output.
- `packages/tui/src/terminal.ts` abstracts terminal lifecycle, dimensions, cursor controls, title/progress, Kitty protocol state, and appearance notifications.
- `packages/tui/README.md` documents the component model and built-in components such as text, input, editor, markdown, loaders, select/settings lists, spacer, image, box, and container.

### `packages/natives/` and Rust crates

Native helper layer exposed through N-API.

- `packages/natives/package.json` exports `native/index.js` and generated TypeScript definitions.
- `packages/natives/native/loader-state.js` resolves platform/CPU-specific native binaries and validates package/native version alignment.
- `crates/pi-natives/src/lib.rs` is the N-API root for appearance, AST search/editing, clipboard, filesystem scan/cache, grep/glob, syntax highlighting, HTML-to-Markdown, keyboard parsing, process/PTY/shell support, SIXEL, code summarization, token counting, text measurement/wrapping/truncation, workspace scanning, power assertions, and isolation helpers.
- `crates/pi-shell/src/lib.rs` exposes brush-based shell execution primitives used by the native shell adapter.
- `crates/pi-shell/src/shell.rs` implements persistent and one-shot shell execution, streaming, environment handling, cancellation, and output minimizer telemetry.
- `crates/pi-shell/src/fixup.rs` performs conservative AST-based bash command fixups.
- `crates/pi-natives/src/pty.rs` implements interactive PTY sessions.

### `packages/utils/`

Shared TypeScript utilities.

- `packages/utils/src/index.ts` exports abortable/async helpers, color/env/dir utilities, fetch retry, formatting, frontmatter, glob helpers, JSON helpers, logging, MIME detection, prompt rendering, process-tree helpers, sanitization, streams, temp files, tab spacing, type guards, and executable lookup.
- `packages/utils/src/ptree.ts` and `packages/utils/src/procmgr.ts` wrap native process helpers for ergonomic TypeScript use.

### `packages/stats/`

Local observability dashboard for session and model usage.

- `packages/stats/src/index.ts` exposes the `gjc-stats` CLI entrypoint and exports aggregation/server APIs.
- `packages/stats/src/aggregator.ts` parses session-derived request metrics and writes aggregated data through SQLite.
- `packages/stats/src/server.ts` serves local dashboard API routes and static SPA assets.
- `packages/stats/src/types.ts` and `packages/stats/src/shared-types.ts` define dashboard and aggregate metric shapes.

### `packages/swarm-extension/`

Optional YAML/DAG multi-agent extension outside the fixed default workflow surface.

- `packages/swarm-extension/README.md` documents standalone `gjc-swarm` execution and in-TUI `/swarm` commands.
- Swarm workflows define agents, tasks, dependency edges, waves, and shared workspace state under `.swarm_<name>/`.

### `packages/typescript-edit-benchmark/`

Private benchmark package for TypeScript edit tasks.

- `packages/typescript-edit-benchmark/package.json` exposes `typescript-edit-benchmark` and depends on the coding-agent, agent-core, ai, tui, utils, diff, prettier, and Babel tooling.
- `packages/typescript-edit-benchmark/src/index.ts` is the benchmark CLI: it resolves fixtures, loads tasks, runs edit attempts, records progress, and writes reports/conversation dumps under `runs/`.

## Python packages

### `python/gjc-rpc/`

Typed Python client for `gjc --mode rpc`.

- `python/gjc-rpc/pyproject.toml` packages `gjc-rpc` for Python 3.11+.
- `python/gjc-rpc/README.md` documents the process-backed stdio client, typed command methods, startup flags, event listeners, todo seeding, host-owned tools, and host-owned URI schemes.

### `python/robogjc/`

Self-hosted GitHub triage/fix bot that drives `gjc --mode rpc`.

- `python/robogjc/AGENTS.md` is the authoritative local contract for this subtree.
- `python/robogjc/pyproject.toml` packages `robogjc` for Python 3.11+ with FastAPI, httpx, pydantic settings, Click, and `gjc-rpc`.
- `python/robogjc/README.md` documents the webhook-to-worktree-to-gjc flow, GitHub sidecar trust boundary, persistent per-issue sessions, and audit trail.
- Important modules include `src/server.py`, `src/queue.py`, `src/tasks.py`, `src/worker.py`, `src/host_tools.py`, `src/sandbox.py`, `src/github_client.py`, `src/github_events.py`, `src/db.py`, and `src/config.py`.

## Runtime flow

A normal CLI session starts in `packages/coding-agent/src/cli.ts`, routes through command handling, then reaches `packages/coding-agent/src/main.ts`. `main.ts` converts CLI/runtime settings into `CreateAgentSessionOptions` and calls `createAgentSession()` in `packages/coding-agent/src/sdk.ts`.

The SDK builds the session context, loads the default skills, creates built-in tools, resolves model/auth state through `@gajae-code/ai`, constructs the system prompt, and instantiates `@gajae-code/agent-core`. The agent loop streams model events, executes tools, records tool results, and hands state back to the selected mode: interactive TUI, print, RPC, RPC-UI, or ACP.

## Verification and gates

Package-local checks are defined in each `package.json`. For workflow-definition or default-surface changes, the focused gates are:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-gjc-definitions.test.ts
```

For broader TypeScript verification, use the root script:

```sh
bun run check:ts
```

Do not use `tsc` or `npx tsc` directly in this repository.
