### Added

- `gjc migrate --from claude-code` now imports Claude Code subagents from `.claude/agents` into the selected scope's `agents/` directory. Tool lists are translated to GJC tools, unsupported tools are dropped and reported, and a name that collides with a bundled role (`executor`, `architect`, `planner`, `critic`) is imported as `<source>-<name>` so the bundled role stays authoritative.
