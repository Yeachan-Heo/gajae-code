# Failed architect context recovery summary

Recovered by inspecting the failed subagent JSONL session files referenced from `.gjc/_session-*/runtime/runtime-state.json`.

## Recovery status

| Agent | Session status | Context records | Tool calls | `report_finding` recovered | `yield` recovered | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `0-ToolPrompts` | errored (`429` after stalls) | 316 JSONL lines | 184 | 34 | 0 | Partially recovered: strong findings, no final grade |
| `1-SystemPrompts` | errored (`429` after stalls) | 204 JSONL lines | 106 | 0 | 0 | Context only: broad coverage, no findings emitted |
| `3-SkillMiscPrompts` | errored (`429` after stalls) | 163 JSONL lines | 82 | 0 | 0 | Context only: broad coverage, no findings emitted |

## Saved recovery artifacts

- `recovered-context/0-ToolPrompts.recovered.md` — recovered tool-prompt review context plus all 34 `report_finding` findings.
- `recovered-context/0-ToolPrompts.findings.json` — structured recovered tool findings.
- `recovered-context/1-SystemPrompts.recovered.md` — recovered system-prompt context: read paths, searches, terminal errors.
- `recovered-context/1-SystemPrompts.findings.json` — empty array; no structured findings were emitted.
- `recovered-context/3-SkillMiscPrompts.recovered.md` — recovered skill/misc context: read paths, searches, terminal errors.
- `recovered-context/3-SkillMiscPrompts.findings.json` — empty array; no structured findings were emitted.

## ToolPrompts recovered verdict

No final `yield`/grade was emitted, but 34 findings were recorded before the 429. The recovered severity shape is usable as a partial report:

- P1: 4
- P2: 18
- P3: 12

Highest-impact recovered findings:

1. `replace.md` contains a `<bash-alternatives>` section recommending `cat`, `sed -i`, and `sed -n`, directly contradicting the `bash.md`, `read.md`, and `search.md` coreutils bans.
2. `monitor.md` documents `job({op:"list"})`, but the real `job` schema is `{ list, poll, cancel, tail }`; correct invocation is `job({list: true})`.
3. `apply-patch.md` has a truncated line-prefix explanation: “Within a hunk each line starts with:” followed by nothing.
4. `ast-edit.md` omits that edits are staged previews requiring `resolve({action:"apply"})` before persistence.

## SystemPrompts recovered context

The system-prompt agent read essentially the full assigned target set and sampled interpolation/loader code:

- system prompts, goals, memories, ci-green, autoresearch, `packages/ai` aborted-turn prompt
- `packages/coding-agent/src/system-prompt.ts`
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/src/goals/runtime.ts`
- `packages/utils/src/prompt.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- multiple searches for template variables, plan-mode prompt usage, TTSR reminders, skill/rule interpolation, memory templates, and context-file names

No `report_finding` or `yield` call happened before stalls/429, so there is no recoverable system-prompt verdict.

## SkillMiscPrompts recovered context

The skill/misc agent read or searched the assigned skill/misc surfaces and related runtime contracts:

- four bundled SKILL.md files: ralplan, team, ultragoal, deep-interview
- plugin skills: `gjc-delegation`, `gjc-session`
- prompt modules: `prompt-templates.ts`, `capability/prompt.ts`, `packages/utils/src/prompt.ts`, `prompt-appendix.ts`
- benchmark prompts
- skill tool/runtime/command state code: `tools/skill.ts`, `extensibility/skills.ts`, `capability/skill.ts`, `commands/state.ts`, `state-runtime.ts`, `skill-state/initial-phase.ts`
- searches around handoff gating, stage naming, state command modes, deep-interview modes, plugin appendix hashing, and template rendering

No `report_finding` or `yield` call happened before stalls/429, so there is no recoverable skill/misc verdict.

## Important correction to the earlier saved artifacts

The earlier `skill-misc-prompts.raw.json` was not a valid skill/misc report; inspection of the `3-SkillMiscPrompts` JSONL shows the session errored without a yield. Treat that previous JSON as a bad `agent://` retrieval artifact, not an actual report from the skill/misc agent.
