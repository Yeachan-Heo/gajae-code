# Claude Code Upstream Tool Parity Fixtures

These fixtures freeze the runtime-facing schema and observed behavior of upstream
Claude Code's `Monitor`, `CronCreate`, `CronList`, and `CronDelete` tools.

They are the **parity oracle** used by `monitor-tool.test.ts`,
`cron-tool.test.ts`, and the fixture validation test. GJC's inline `Monitor`
and Cron* tools must mirror these surfaces exactly; any divergence is a bug.

## Source

| Fixture | Source |
| --- | --- |
| `monitor.schema.json` | Binary symbols in `/Users/bellman/.local/share/claude/versions/2.1.152` (`var _D = "Monitor"`, `zW8` description) + <https://code.claude.com/docs/en/tools-reference#monitor-tool> + <https://code.claude.com/docs/en/scheduled-tasks> |
| `cron-create.schema.json` | Binary symbols (`var nP = "CronCreate"`, `buildCronCreatePrompt`, `buildCronCreateDescription`, `Fire a prompt on a recurring schedule`) + <https://code.claude.com/docs/en/scheduled-tasks> |
| `cron-delete.schema.json` | Binary symbols (`var GC = "CronDelete"`, `AW8 = "Cancel a scheduled cron job by ID"`, `buildCronDeletePrompt`) + scheduled-tasks docs |
| `cron-list.schema.json` | Binary symbols (`var yM_ = "CronList"`, `jW8 = "List scheduled cron jobs"`, `buildCronListPrompt`) + scheduled-tasks docs |

## Required fields

Every fixture must include:

- `captured_at` — ISO-8601 timestamp of capture
- `claude_version` — exact `claude --version` output
- `capture_command` — exact command(s) used
- `tool_name` — upstream tool name as exposed to the model
- `description` — upstream description string verbatim
- `input_schema` — JSON Schema for parameters
- `observed_returns` — representative return shapes
- `notes` — provenance + caveats

The `fixture-validation.test.ts` test enforces these fields. CI fails when a
fixture is missing or empty.

## Re-capture procedure

```bash
# 1. Inspect the local claude binary for tool names / descriptions
REAL_CLAUDE="$(readlink -f "$(which claude | tail -1)")"
strings "$REAL_CLAUDE" | grep -E '_D="Monitor"|nP="CronCreate"|GC="CronDelete"|yM_="CronList"'

# 2. Fetch the published tools reference + scheduled-tasks docs
#    https://code.claude.com/docs/en/tools-reference
#    https://code.claude.com/docs/en/scheduled-tasks

# 3. Update the relevant *.schema.json file, bumping `captured_at`
#    and the `claude_version` field to whatever `claude --version` reports.
```

When upstream rotates a parameter name or adds a required field, update the
fixture **and** the corresponding tool's zod schema in the same PR; the parity
test will flag mismatches.

## Hard gate

Per the ralplan consensus plan (Phase 0):

- If upstream provides no monitor/BashOutput-like schema → stop and return to planning.
- If upstream provides no cron/scheduler schema → stop and return to planning.
- No fallback or GJC-original tool surface may ship.

These fixtures evidence that both Monitor and Cron* have stable upstream surfaces,
so implementation may proceed.
