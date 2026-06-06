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

Gajae-Code is published through the normal npm registry as `gajae-code`; that package installs the standalone `gjc` binary:

```sh
bun install -g gajae-code
```

The scoped package is also available as `@gajae-code/coding-agent`. Install `gjc` once in your shell environment, then launch it from the repository you want it to operate on. Installing GJC does **not** inject it into Codex CLI, Claude Code, OpenCode, Claw Code, or every editor/agent runtime automatically.

Recommended launch paths:

| Situation                             | Command                        | Notes                                                                                                                                 |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Direct interactive session            | `gjc`                          | Runs in the current checkout without creating or attaching a tmux session.                                                            |
| Long-running or pane-friendly session | `gjc --tmux`                   | Creates or attaches a GJC-managed tmux-backed leader session. Run `gjc team ...` inside that session when parallel tmux workers help. |
| Branch-local or risky work            | `gjc --tmux --worktree <path>` | Use a dedicated Git worktree path so edits, evidence, and tool output stay isolated from the main checkout.                           |

Use a worktree-backed run when the task may touch many files, needs a clean branch for review, or should not risk polluting your primary checkout. For repository development, use the source checkout commands in [Development](#development).

### Using GJC with other coding agents

GJC is an external runner, not runtime injection. Start `gjc` from the same repository or dedicated Git worktree where Hermes, Claw Code, or another coding tool is operating, then use GJC to drive the public workflow surface: `deep-interview`, `ralplan`, `ultragoal`, and optional `team` workers. Installing GJC does **not** patch another agent runtime, install hidden routing, or make GJC run inside that tool.

Canonical orchestration flow:

1. Create or choose the target checkout, usually a branch-specific Git worktree for reviewable work.
2. Launch or attach the GJC leader from that directory with `gjc --tmux`, or use `gjc --tmux --worktree <path>` when GJC should create/use the worktree path.
3. Submit the appropriate workflow command inside the session: `/skill:deep-interview` for ambiguous requirements, `/skill:ralplan` for a reviewed plan, then `gjc ultragoal ...` for durable execution/evidence tracking.
4. Add `gjc team ...` only when parallel tmux workers materially help; it is an optional execution lane, not a required handoff.
5. Collect the stop state before handing work back: changed files, checks run, failures, remaining risks, and evidence links or summaries.

| Tool                         | Recommended GJC command                                                         | Boundary / limitation                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI                    | `gjc --tmux --worktree <path>` for branch-local work, or `gjc` for a quick pass | External-runner workflow: run both from the same repo/worktree. GJC is not installed inside Codex CLI.                          |
| Claude Code                  | `gjc --tmux` from the target repo, optionally with `--worktree <path>`          | External-runner workflow: keep Claude Code pointed at the same checkout. GJC does not become a Claude Code extension.           |
| OpenCode                     | `gjc` or `gjc --tmux` from the same checkout OpenCode uses                      | External-runner workflow only today. Treat deeper adapter behavior as future work unless documented in a release note.          |
| Rust `claw-code` / Claw Code | `gjc --tmux --worktree <path>` when you want isolated evidence and review state | External-runner workflow only today. GJC does not install into Claw Code, replace its runtime, or expose private routing logic. |

For remote-control protocol details, see [`docs/bridge.md`](docs/bridge.md). The bridge is a public control surface for an already-running GJC session; it is not a deployment recipe for private Hermes/Claw routing.


## Provider retry budgets

Gajae-Code has two retry layers:

- Session auto-retry (`retry.maxRetries`) retries a failed assistant turn after a terminal transient error.
- Provider retry budgets control retries inside the provider transport before that terminal error reaches the session.

Configure provider budgets in `~/.gjc/config.yml` (or the active project/user settings source). JSON Schemas for YAML editor integration are checked in at `schemas/config.schema.json` and `schemas/models.schema.json`:

```yaml
retry:
  # Similar to codex-cli request_max_retries. Counts retries, not the initial request.
  requestMaxRetries: 4
  # Similar to codex-cli stream_max_retries. Counts replay-safe stream retries.
  streamMaxRetries: 100
  # Session-level terminal-error retries remain separately configurable.
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` applies to provider SDK/fetch retries before a stream is established. `streamMaxRetries` applies only when a provider can safely replay a transient stream failure before user-visible content or in provider-specific replay-safe paths. Invalid auth, unsupported models/providers, malformed requests, context overflow, user aborts, and permanent quota failures remain fail-fast instead of being hidden by retry loops.

## Default TUI identity

The default dark TUI identity is the GJC red-claw theme, while light-appearance terminals default to the bundled blue-crab theme. Explicit user theme settings still win.

## Why Gajae-Code?

Gajae-Code (`gjc`) keeps the public agent surface intentionally small while making the runtime around it dependable. It focuses on one useful loop:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

Use `deep-interview` to clarify intent, `ralplan` to critique the approach, and `ultragoal` to carry the work through implementation, revision, verification, and an evidence summary. Add `team` only when the task benefits from coordinated parallel workers; `team` is an optional execution mode, not a required handoff step. The result is a compact CLI that stays easy to reason about, but still gives you session state, worktree isolation, tmux orchestration, tool execution, and persistent evidence when the work needs it.

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
# Optional only for parallel work, from inside `gjc --tmux`:
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

Thanks to the people and agents helping shape the early Gajae-Code releases, including [Yeachan-Heo](https://github.com/Yeachan-Heo), [IYENTeam](https://github.com/IYENTeam), and [HaD0Yun](https://github.com/HaD0Yun). Contributions, bug reports, and release validation are welcome through GitHub and the Discord community.

## Inspirations and lineage

Gajae-Code's default TUI identity is the crustacean pair: red-claw for dark appearance and blue-crab for light appearance. It builds on lessons from a small family of agent harnesses while keeping the public GJC surface intentionally focused. Historical attribution is kept in [`NOTICE.md`](NOTICE.md).

## License

MIT. See [`LICENSE`](LICENSE).
