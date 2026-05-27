# Gajae-Code

Gajae-Code (`gjc`) is a minimal coding-agent harness with a deliberately fixed public surface: four workflow skills, four role subagents, and a resilient CLI/runtime around them.

## Story

I created `oh-my-codex` and `oh-my-claudecode`. After living with those harnesses, I felt the same thing kept happening: the harness got bloated, but the work still collapsed into one useful loop.

My claw, Gajae, and I realized the real method was:

```text
interview to remove ambiguity
  -> ralplan pre-mortem
  -> fast parallel execution
  -> post-mortem with persistent verification evidence and goal tracking
```

So I made Gajae-Code as a minimal harness that can work with any model. The harness stays fat where resilience matters: CLI, tools, sessions, model routing, artifacts, native helpers, and verification state. The public workflow stays small on purpose.

No more default skills. No more default role agents. The product gets better by improving the harness methodology around the same four skills and four subagents.

## Default TUI identity

The default dark TUI identity is the GJC red-claw theme: a red/orange crustacean look for Gajae-Code terminals. Explicit user theme settings still win.

## The four skills

| Skill | Purpose |
| --- | --- |
| `deep-interview` | Remove ambiguity before planning. |
| `ralplan` | Pre-mortem planning and approval before mutation. |
| `team` | Fast coordinated execution after approval. |
| `ultragoal` | Persistent goal tracking and verification evidence. |

## The four subagents

| Agent | Purpose |
| --- | --- |
| `executor` | Bounded implementation, fixes, and refactors. |
| `architect` | Read-only architecture and code-review assessment. |
| `planner` | Read-only sequencing and acceptance criteria. |
| `critic` | Read-only plan critique and actionability review. |

## Install

```sh
bun install
bun run install:defaults
```

## Run

```sh
bun packages/coding-agent/src/cli.ts --help
```

When installed globally:

```sh
gjc --help
```

## Development

Default workflow definitions live in source, not committed `.gjc` copies:

```text
packages/coding-agent/src/defaults/gjc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

For workflow-definition or rebrand-surface changes, run:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-gjc-definitions.test.ts
```

For a package-by-package map, see [`docs/codebase-overview.md`](docs/codebase-overview.md).

## Attribution

Gajae-Code is a forked/rebranded derivative that preserves upstream attribution where required while presenting GJC commands, package names, and runtime paths in the active product surface.
