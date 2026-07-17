# ToolPrompts recovered raw report

The original `agent://0-ToolPrompts` result surfaced as failed, but inspecting the subagent JSONL context recovered 34 structured `report_finding` entries before the session died on stalls/429.

Canonical recovered artifacts:

- `recovered-context/0-ToolPrompts.recovered.md`
- `recovered-context/0-ToolPrompts.findings.json`
- `recovery-summary.md`

Recovered severity breakdown: P1 = 4, P2 = 18, P3 = 12. No final `yield` or grade was emitted.
