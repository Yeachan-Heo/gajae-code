# SystemPrompts recovered raw context

The original `agent://1-SystemPrompts` result failed. Inspecting the subagent JSONL context recovered broad coverage evidence (106 tool calls) but no `report_finding` entries and no final `yield`.

Canonical recovered artifacts:

- `recovered-context/1-SystemPrompts.recovered.md`
- `recovered-context/1-SystemPrompts.findings.json` (empty)
- `recovery-summary.md`

No valid system-prompt verdict was emitted before the session died on stalls/429.
