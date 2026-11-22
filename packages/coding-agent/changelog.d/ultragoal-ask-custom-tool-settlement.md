### Fixed

- **Ultragoal ask guard**: Enforce one-question settlement for custom ask tools. Only the built-in `AskTool` is now permitted for human-blocked ask admissions, preventing custom/extension tools from bypassing durable reservation and settlement accounting (#7799).
- **Ultragoal ask guard**: An `ask` tool that carried the guard's marker, or that the guard had already wrapped once, was handed back unguarded the next time it was wrapped, so a custom `ask` could run while a run was active. The guard now tracks the wrappers it built itself (#7799).
