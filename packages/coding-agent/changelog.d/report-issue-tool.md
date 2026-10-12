### Added

- `report_issue` tool (opt-in via `reportIssue.enabled`): the model records tool behavior that contradicts the tool's description into the local `~/.gjc/tool-issues.db`. Reports are never uploaded; read them with `gjc read '~/.gjc/tool-issues.db:tool_issues'`.
