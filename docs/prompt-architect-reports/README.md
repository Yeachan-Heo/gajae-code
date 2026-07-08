# Prompt architect reports

Generated from the four architect subagents spawned to review prompt optimization/enhancement opportunities, then augmented by inspecting failed subagent JSONL contexts.

## Artifacts

- `agent-prompts.raw.json` — usable structured report from `2-AgentPrompts`.
- `recovery-summary.md` — summary of context recovery for failed/errored agents.
- `recovered-context/0-ToolPrompts.recovered.md` — recovered tool-prompt review context plus all 34 structured `report_finding` findings.
- `recovered-context/0-ToolPrompts.findings.json` — recovered tool-prompt findings as JSON.
- `recovered-context/1-SystemPrompts.recovered.md` — recovered system-prompt context: reads/searches/errors; no findings/yield emitted.
- `recovered-context/1-SystemPrompts.findings.json` — empty; no `report_finding` calls emitted.
- `recovered-context/3-SkillMiscPrompts.recovered.md` — recovered skill/misc context: reads/searches/errors; no findings/yield emitted.
- `recovered-context/3-SkillMiscPrompts.findings.json` — empty; no `report_finding` calls emitted.
- `tool-prompts.raw.md`, `system-prompts.raw.md`, `skill-misc-prompts.raw.json` — initial raw-stub artifacts kept for audit history; superseded by `recovery-summary.md` and `recovered-context/`.
- `system-prompts.rerun.json` — successful re-run of the SystemPrompts lane (grade C, 12 findings: 1 P1, 6 P2, 5 P3).
- `skill-misc-prompts.rerun.json` — successful re-run of the SkillMiscPrompts lane (grade C, 9 findings: 1 P1, 4 P2, 4 P3).

## Usable verdicts

### AgentPrompts

Usable report. Verdict: **B-** with **16 findings**: **2 P1**, **5 P2**, **9 P3**.

Top fixes:

1. Add a persistence-context gate to `architect.md` and `critic.md` so `gjc ralplan --write` is used only inside an active ralplan lane; otherwise return the full review in `yield.result.data`.
2. Wire `report_finding` into the architect output contract and define the severity mapping `CRITICAL -> P0`, `HIGH -> P1`, `MEDIUM -> P2`, `LOW -> P3`.
3. Extract the ultragoal red-team executor QA block from the always-loaded executor prompt into an ultragoal-only injected fragment or assignment contract.

### ToolPrompts

No final `yield` or grade, but context recovery found **34 structured findings** emitted through `report_finding` before stalls/429: **4 P1**, **18 P2**, **12 P3**.

Highest-impact recovered findings:

1. `replace.md` recommends `cat`/`sed` shell alternatives that directly contradict `bash.md`, `read.md`, and `search.md` bans.
2. `monitor.md` documents invalid `job({op:"list"})`; actual schema expects `job({list: true})`.
3. `apply-patch.md` has a truncated “Within a hunk each line starts with:” sentence.
4. `ast-edit.md` omits the preview-to-`resolve({action:"apply"})` persistence flow.

### SystemPrompts (re-run)

Grade **C**, **12 findings** (1 P1, 6 P2, 5 P3). Top fixes: remove the `<soul>` block contradicting the base prompt's authority/safety contracts; guard `{{toolRefs.search_tool_bm25}}` discovery text on the actual activator tool; make plan-mode subagent output instructions yield-aware. See `system-prompts.rerun.json`.

### SkillMiscPrompts (re-run)

Grade **C**, **9 findings** (1 P1, 4 P2, 4 P3). Top fixes: fix unrendered `{{ARGUMENTS}}` in deep-interview SKILL; remove dead `plan` skill / `--research-setup` / `gjc sparkshell` / `team_cleanup` references; complete the ultragoal `executorQa` replay contract. See `skill-misc-prompts.rerun.json`.

## Status

All four lanes now have usable reports: AgentPrompts and ToolPrompts findings were applied in this branch's prompt fixes; SystemPrompts and SkillMiscPrompts re-run findings are recorded above and pending application.
