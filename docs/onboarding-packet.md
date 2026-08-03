# Gajae-Code Onboarding Packet

This packet is a docs-only, public-safe context seed for the `gajae-code` repository as inspected on 2026-06-01. It is intentionally a no-new-skill artifact: not a new workflow skill, command, agent, configuration surface, issue template, or runtime behavior.

## Purpose in one paragraph

Gajae-Code is the `gjc` coding-agent CLI and supporting monorepo. The product centers on a small public workflow loop: clarify with `deep-interview`, plan with `ralplan`, execute and verify through `ultragoal`, and use `team` only when parallel tmux workers are useful. The main product package is `packages/coding-agent/`; supporting packages provide LLM/provider access, agent runtime, TUI rendering, native helpers, stats, utilities, benchmarks, and SDK machine interfaces.

## Fixed public surface

Keep this invariant front-and-center when onboarding to the repo:

- Default workflow skills: `deep-interview`, `ralplan`, `team`, `ultragoal`.
- Public role agents: `executor`, `architect`, `planner`, `critic`.
- Bundled default workflow skill sources live under `packages/coding-agent/src/defaults/gjc/skills/`.
- Bundled role-agent prompt sources live under `packages/coding-agent/src/prompts/agents/`.
- Runtime state, specs, plans, goals, team state, and local overrides belong under `.gjc/` for the product and `.omx/` only for this agent-run orchestration.

Do not add a fifth default skill, fifth public role agent, new command, new config surface, or feature-intake behavior unless that product decision has already been made and the default-surface gates are updated.

## Primary entrypoints

| Area             | Repo-relative path                                   | Why it matters                                                                                    |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CLI bootstrap    | `packages/coding-agent/src/cli.ts`                   | Registers top-level CLI commands and routes default launch behavior.                              |
| Session launch   | `packages/coding-agent/src/main.ts`                  | Converts CLI/runtime settings into agent-session creation and mode dispatch.                      |
| Agent assembly   | `packages/coding-agent/src/sdk/session.ts`           | Loads settings, default skills, rules, tools, auth/model state, system prompt, and agent runtime. |
| Built-in tools   | `packages/coding-agent/src/tools/index.ts`           | Registers file, shell, edit, search, browser, task/subagent, and related public coding-harness tools. Memory backends are private integrations, not public tools. |
| Default skills   | `packages/coding-agent/src/defaults/gjc-defaults.ts` | Embeds and installs the four default workflow skills plus deep-interview fragments.               |
| Role agents      | `packages/coding-agent/src/task/agents.ts`           | Embeds bundled task-agent prompts; tests enforce public role-agent expectations.                  |
| Product overview | `README.md`                                          | Explains installation, product story, fixed workflow surface, and development entry commands.     |
| Architecture map | `docs/codebase-overview.md`                          | Public package map and runtime-flow reference.                                                    |

## Package map

- `packages/coding-agent/` — main `gjc` CLI, workflows, session runtime, tool registry, discovery, settings, prompts, and tests.
- `packages/ai/` — provider/model boundary, streaming, auth, model registry, retries, and provider integrations.
- `packages/agent/` — stateful agent loop and append-only context runtime.
- `packages/tui/` — terminal UI framework and rendering primitives.
- `packages/natives/` plus `crates/*` — native helpers, Rust/N-API bindings, shell/PTY, text search, AST, filesystem, and media utilities.
- `packages/utils/` — shared TypeScript utilities, logging, formatting, process helpers, JSON/frontmatter, and sanitization.
- `packages/stats/` — local observability dashboard and session/model usage aggregation.
- `packages/typescript-edit-benchmark/` — TypeScript edit benchmark tooling.
- External machine clients use the SDK WebSocket interface documented in `docs/sdk.md`; `--mode rpc`, `--mode rpc-ui`, and `--mode bridge` were removed.

## Build, test, and validation commands

Prefer targeted checks first, then broader checks when code changes justify them. For this docs-only packet, lightweight validation is enough.

| Command                                                               | Scope                               | When to use                                                                 |
| --------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `bun install`                                                         | Workspace dependencies              | Initial local setup.                                                        |
| `bun run install:defaults`                                            | Local default install               | Installs source-bundled default workflow definitions for local development. |
| `bun packages/coding-agent/src/cli.ts --help`                         | CLI smoke/discovery                 | Fast source checkout CLI sanity check.                                      |
| `bun run check:ts`                                                    | Type/lint/default UI checks         | Broad TypeScript validation; heavier than docs-only changes.                |
| `bun run test`                                                        | Full TS + Rust tests                | Broad regression check; use for runtime/product changes.                    |
| `bun run ci:test:smoke`                                               | CLI version/help/stats worker smoke | Useful before release/install changes.                                      |
| `bun scripts/check-visible-definitions.ts`                            | Default surface gate                | Required after workflow-definition changes.                                 |
| `bun scripts/verify-g002-gates.ts`                                    | Rebrand/default-surface gate        | Required after workflow-definition or public-surface changes.               |
| `bun scripts/rebrand-inventory.ts --strict`                           | Rebrand inventory gate              | Required after workflow-definition or public-surface changes.               |
| `bun test packages/coding-agent/test/default-gjc-definitions.test.ts` | Four-skills/four-agents contract    | Required after default workflow/agent surface changes.                      |

Repository rule: do not run `tsc` or `npx tsc`; use the Bun scripts above.

## Danger zones

- **Default surface expansion:** `packages/coding-agent/src/defaults/gjc/skills/`, `packages/coding-agent/src/defaults/gjc-defaults.ts`, `packages/coding-agent/src/prompts/agents/`, and model-assignment tests are contract-heavy. Changes here can accidentally alter the fixed four-skills/four-agents shape.
- **CLI commands:** `packages/coding-agent/src/cli.ts` and `packages/coding-agent/src/commands/` define visible behavior. Adding commands or aliases is a product-surface change.
- **Runtime/session assembly:** `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/sdk/session.ts`, discovery, settings, tools, and system-prompt paths can affect every session.
- **TUI/logging:** Avoid `console.log`, `console.warn`, or `console.error` inside `packages/coding-agent/`; use the centralized logger to avoid corrupting TUI rendering.
- **Secrets/auth/config:** Keep `docs/secrets.md`, auth broker/gateway code, settings, and environment-variable docs public-safe. Do not expose tokens or private infrastructure.
- **Native/Rust build:** `packages/natives/` and `crates/*` can require platform-specific toolchains and CI artifact behavior.
- **Generated model data:** Do not edit `packages/ai/src/models.json` directly; update generators/descriptors/resolvers and regenerate with `bun --cwd=packages/ai run generate-models`.

## Unknowns worth preserving

- Which onboarding packet shape will be most useful for future `gjc` context ingestion is still an experiment, not a product contract.
- Public issue #158 / `gajae-deep-onboarding` context is summarized only from the user-provided prompt in this run; this packet does not add issue intake or feature workflow behavior.
- Full CI may depend on runner/system dependencies and native artifacts; docs-only changes usually do not need the full matrix locally.
- Some packages contain internal or hidden utility prompts/agents beyond the four public role agents. Public-facing docs should keep the four-role contract clear.

## First safe tasks for a new contributor or agent

1. Read `README.md`, `docs/codebase-overview.md`, and this packet.
2. Run `bun packages/coding-agent/src/cli.ts --help` for a fast CLI surface check after dependencies are installed.
3. For docs-only edits, run formatting/check commands that do not mutate runtime behavior.
4. For default-surface edits, run the four required gates listed in the command table before claiming completion.
5. For package code edits, start with the nearest package test, then escalate to `bun run check:ts` or `bun run test` as risk increases.
6. Before changing `packages/coding-agent/src/defaults/gjc/skills/`, `packages/coding-agent/src/prompts/agents/`, `packages/coding-agent/src/commands/`, or config/settings paths, write down whether the change alters public surface area.

## Context seed checklist

A future agent can use this packet as context if it preserves these constraints:

- Keep changes public-safe and repo-relative.
- Prefer docs and tests over new runtime abstractions for onboarding experiments.
- Treat the fixed four-skills/four-agents shape as a product constraint.
- Verify claims with repo files before summarizing them.
- Report validation evidence and caveats instead of implying hidden automation.
