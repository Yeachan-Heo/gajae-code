> Disclaimer: Gajae-Code is an experimental, beta-stage early project. Expect rough edges and verify outputs before relying on it for important work.

<p align="center">
  <img src="assets/hero.png" alt="Gajae-Code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">Gajae-Code</h1>

<p align="center">
  A red-claw coding-agent harness for crisp interviews, resilient plans, tmux-native execution, and durable verification.
</p>

<p align="center">
  <img src="assets/character.png" alt="Gajae-Code character mascot" width="360" />
</p>

<p align="center">
  <a href="https://discord.gg/sj4exxQ9v">Join the Discord community</a>
</p>

## Story

I created an earlier OpenAI code harness and `an earlier Anthropic-code harness`. After living with those harnesses, I felt the same thing kept happening: the harness got bloated, but the work still collapsed into one useful loop.

## Usage

Gajae-Code is published through the normal npm registry as `gajae-code`; that package installs the `gjc` binary. Install the one-line npm wrapper with Bun for the recommended runtime workflow:

```sh
bun install -g gajae-code
```

The scoped package is also available as `@gajae-code/coding-agent`. For repository development, use the source checkout commands in [Development](#development).

Start the recommended tmux-backed experience:

```sh
gjc --tmux
```

Bare `gjc` launches directly without creating or attaching a tmux session:

```sh
gjc
```

Run inside an isolated Git worktree when you want a safer branch-local workspace:

```sh
gjc --tmux --worktree <path>
```

Use a dedicated path for throwaway or branch-specific work so the main checkout stays clean.

## Default TUI identity

The default dark TUI identity is the GJC red-claw theme: a red/orange crustacean look for Gajae-Code terminals. Explicit user theme settings still win.

## Why Gajae-Code?

Gajae-Code (`gjc`) keeps the public agent surface intentionally small while making the runtime around it dependable. It focuses on one useful loop:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

Use `deep-interview` to clarify intent, `ralplan` to critique the approach, and `$ultragoal` to carry the work through implementation, revision, verification, and an evidence summary. Add `$team` only when the task benefits from coordinated parallel workers; `$team` is an optional execution mode, not a required handoff step. The result is a compact CLI that stays easy to reason about, but still gives you session state, worktree isolation, tmux orchestration, model routing, tool execution, and persistent evidence when the work needs it.

## Workflow surface

Gajae-Code ships four default workflow skills:

| Skill            | What it does                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `deep-interview` | Removes ambiguity before planning or code changes.                                                  |
| `ralplan`        | Builds and critiques a plan before mutation.                                                        |
| `team`           | Optionally coordinates tmux-backed parallel execution when the work benefits from multiple workers. |
| `ultragoal`      | Tracks durable goals through implementation, revisions, verification, and evidence summaries.       |

And four bundled role agents:

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | Bounded implementation, fixes, and refactors.      |
| `architect` | Read-only architecture and code-review assessment. |
| `planner`   | Read-only sequencing and acceptance criteria.      |
| `critic`    | Read-only plan critique and actionability review.  |

No sprawling default skill zoo: the harness improves by making this small method better.

A concrete bug-fix pass might look like this:

```text
/skill:deep-interview clarify the bug, affected behavior, non-goals, and acceptance checks
/skill:ralplan turn the clarified bug report into a reviewed fix plan
gjc ultragoal create-goals --brief-file <approved-plan>
# Optional only for parallel work:
gjc team 2:executor "split implementation and verification for this bug fix"
gjc ultragoal complete-goals
```

That flow is meant to describe the operator sequence, not to guarantee hidden automation: the agent still reports what it changed, what it revised after findings, what checks ran, and what evidence supports the fix.

## Development

Install dependencies and local defaults:

```sh
bun install
bun run install:defaults
```

Run the CLI from source:

```sh
bun packages/coding-agent/src/cli.ts --help
```

Default workflow definitions live in source, not committed `.gjc` copies:

```text
packages/coding-agent/src/defaults/gjc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

For workflow-definition or rebrand-surface changes, run the project gates:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-gjc-definitions.test.ts
```

For a package-by-package map, see [`docs/codebase-overview.md`](docs/codebase-overview.md).

## Contributors

Thanks to the people and agents helping shape the early Gajae-Code releases, including [Yeachan-Heo](https://github.com/Yeachan-Heo) and [IYENTeam](https://github.com/IYENTeam). Contributions, bug reports, and release validation are welcome through GitHub and the Discord community.

## Inspirations and lineage

Gajae-Code's default dark TUI identity is the GJC red-claw theme. It builds on lessons from a small family of agent harnesses while keeping the public GJC surface intentionally focused. Historical attribution is kept in [`NOTICE.md`](NOTICE.md).

## License

MIT. See [`LICENSE`](LICENSE).
