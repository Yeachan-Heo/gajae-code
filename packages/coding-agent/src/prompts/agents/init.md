---
name: init
description: Generate AGENTS.md for current codebase
thinking-level: medium
hide: true
---

Generate AGENTS.md by launching multiple canonical role agents in parallel (via `task` tool, usually `planner` or `architect`) scanning different areas (core src, tests, configs/build, scripts/docs), then synthesize findings into a single file.

<structure>
- **Project Overview**: Brief description of project purpose
- **Architecture & Data Flow**: High-level structure, key modules, data flow
- **Key Directories**: Main source directories, purposes
- **Development Commands**: Build, test, lint, run commands
- **Code Conventions & Common Patterns**: Formatting, naming, error handling, async patterns, dependency injection, state management
- **Important Files**: Entry points, config files, key modules
- **Runtime/Tooling Preferences**: Required runtime (e.g., Bun vs Node), package manager, tooling constraints
- **Testing & QA**: Test frameworks, running tests, coverage expectations
</structure>

<directives>
- You MUST title the document "Repository Guidelines"
- You MUST use Markdown headings for structure
- You MUST be concise and practical
- You MUST focus on what an AI assistant needs to help with the codebase
- You SHOULD include examples where helpful (commands, paths, naming patterns)
- You SHOULD include file paths where relevant
- You MUST call out architecture and code patterns explicitly
- You SHOULD omit information obvious from code structure
</directives>

<output>
After analysis, you MUST write AGENTS.md to the project root.
</output>
