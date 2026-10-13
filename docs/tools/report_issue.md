# report_issue

> Records a tool whose behavior contradicted its own description into a local SQLite database, for tool-quality tracking from real sessions.

## Source
- Entry: `packages/coding-agent/src/tools/report-issue.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/report-issue.md`
- Database path: `getToolIssuesDbPath()` in `packages/utils/src/dirs.ts` (`~/.gjc/tool-issues.db`, or the XDG data dir)

## Availability
- Off by default. Enable with the `reportIssue.enabled` setting (`tools` tab).
- When enabled it is an essential tool, so the model sees it without tool discovery.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tool` | `string` | Yes | Name of the tool that misbehaved. |
| `report` | `string` | Yes | What was called, what was expected, what happened. |

## Outputs
- `content[0].text` is `Recorded. Continue the task.`, or `Report could not be stored locally; continue the task.` when the database write fails.
- `details` is `{ recorded: boolean, tool: string }`.

## Storage
Table `tool_issues`:

| Column | Description |
| --- | --- |
| `id` | Autoincrement key. |
| `created_at` | UTC ISO-8601 timestamp with milliseconds. |
| `tool` | Trimmed tool name, capped at 128 UTF-8 bytes. |
| `report` | Trimmed report, capped at 4000 Unicode code points (`…` marks truncation). |
| `model` | Active model string, or `NULL`. |
| `gjc_version` | GJC version that recorded the report. |
| `session_id` | Session id, or `NULL`. |

The database file is created with mode `0600` before SQLite opens it, so its WAL and SHM sidecars are also `0600`. A missing parent directory is created with mode `0700`; an existing one keeps its mode. Nothing is uploaded; reports leave the machine only if you share the file.

## Reading reports
The path comes from `getToolIssuesDbPath()`:

1. On Linux or macOS, with the default profile (no custom agent directory), when `XDG_DATA_HOME` is set and `$XDG_DATA_HOME/gjc` exists: `$XDG_DATA_HOME/gjc/tool-issues.db`.
2. Otherwise: `tool-issues.db` in the config root, `~/<GJC_CONFIG_DIR>` (`~/.gjc` unless `GJC_CONFIG_DIR` is set).

`gjc config init-xdg` only creates the XDG directories; the database moves there once `XDG_DATA_HOME` is exported. Windows always uses the config root.

```sh
# Default location (adjust `.gjc` if GJC_CONFIG_DIR is set)
gjc read "$HOME/.gjc/tool-issues.db:tool_issues?order=created_at:desc&limit=50"
gjc read "$HOME/.gjc/tool-issues.db?q=SELECT tool, count(*) AS n FROM tool_issues GROUP BY tool ORDER BY n DESC"

# XDG location (XDG_DATA_HOME set and $XDG_DATA_HOME/gjc present)
gjc read "$XDG_DATA_HOME/gjc/tool-issues.db:tool_issues?order=created_at:desc&limit=50"
```

Delete the file to clear all reports.

## Errors
- Blank `tool` or `report` after trimming is a tool error and nothing is written.
- Database open/write failures are logged and reported as `recorded: false`; they never fail the agent turn.

## Notes
- Ported from oh-my-pi's `xd://report_issue` auto-QA device, without its collector push and consent prompt.
