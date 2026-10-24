### Bug Fixes

- migrate: Add timeout enforcement (30s) to generated hook command execution to prevent indefinite hangs when hooks block on I/O or user input
- migrate: Write generated hook modules to `.gjc/hooks/post/` directory so discovery can locate them
- migrate: Normalize Claude Code tool names (e.g. "Bash" → "bash") when matching hook matchers against GJC tool names
- migrate: Parse PreToolUse hook JSON response for `permissionDecision: "deny"` on exit 0 to block tool execution
- migrate: Remove unsupported Stop event from hook migrations; mark as skipped_unmappable instead
- migrate: Translate PostToolUse `content` and `isError` fields to `tool_response` and `tool_error` in hook payload
