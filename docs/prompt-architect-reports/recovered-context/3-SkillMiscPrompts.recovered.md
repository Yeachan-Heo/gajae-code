# Recovered context: 3-SkillMiscPrompts

- Session file: `<local-gjc-session-jsonl-redacted>`
- JSONL records inspected: yes
- Tool calls: 82
- Recorded findings recovered from `report_finding`: 0
- Yield calls: 0
- Errors/stalls: 26

## Errors / terminal blockers

- line 139: Anthropic stream stalled while waiting for the next event
- line 143: Anthropic stream stalled while waiting for the next event
- line 144: Anthropic stream stalled while waiting for the next event
- line 150: Anthropic stream stalled while waiting for the next event
- line 151: Anthropic stream stalled while waiting for the next event
- line 152: Anthropic stream stalled while waiting for the next event
- line 159: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()
- line 160: Anthropic stream stalled while waiting for the next event
- line 161: Anthropic stream stalled while waiting for the next event
- line 162: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}

## Read paths sampled

- `packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md`
- `packages/coding-agent/src/defaults/gjc/skills/team/SKILL.md`
- `packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md`
- `packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md`
- `packages/coding-agent/src/defaults/gjc/skills/team/SKILL.md:300-449`
- `packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md:300-360`
- `plugins/gajae-code/skills/gjc-delegation/SKILL.md`
- `plugins/gajae-code/skills/gjc-session/SKILL.md`
- `packages/coding-agent/src/config/prompt-templates.ts`
- `packages/coding-agent/src/capability/prompt.ts`
- `packages/utils/src/prompt.ts`
- `packages/coding-agent/src/extensibility/gjc-plugins/prompt-appendix.ts`
- `packages/coding-agent/src/config/prompt-templates.ts:raw`
- `packages/coding-agent/src/capability/prompt.ts:raw`
- `packages/coding-agent/src/config/prompt-templates.ts:300-311`
- `packages/utils/src/prompt.ts:raw`
- `packages/utils/src/prompt.ts:300-472:raw`
- `packages/coding-agent/src/extensibility/gjc-plugins/prompt-appendix.ts:raw`
- `packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md:300-650`
- `packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md:654-952`
- `packages/typescript-edit-benchmark/src/prompts/benchmark-system.md`
- `packages/typescript-edit-benchmark/src/prompts/benchmark-task.md`
- `packages/typescript-edit-benchmark/src/prompts/benchmark-retry.md`
- `packages/coding-agent/src/tools/skill.ts:raw`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/capability/skill.ts:raw`
- `packages/coding-agent/src/commands/state.ts`
- `packages/coding-agent/src/commands/state.ts:raw`
- `packages/coding-agent/src/utils/command-args.ts:raw`
- `packages/coding-agent/src/gjc-runtime/state-runtime.ts:1540-1700`
- `packages/coding-agent/src/skill-state/initial-phase.ts:raw`
- `packages/coding-agent/src/prompts/tools/skill.md`
- `packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts:600-680`
- `packages/coding-agent/src/tools/ask.ts:1-120`
- `packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md:350-360`
- `packages/coding-agent/src/extensibility/skills.ts:280-367:raw`
- `packages/coding-agent/src/tools/ultragoal-ask-guard.ts`
- `packages/coding-agent/src/extensibility/skills.ts:371-467:raw`
- `packages/coding-agent/src/extensibility/slash-commands.ts:150-260:raw`

## Search patterns sampled

- `current_phase.*handoff|handoff --to|chain guard|chainGuard` in `['packages/coding-agent/src']`
- `argument-hint|argumentHint` in `['packages/coding-agent/src']`
- `argument-hint|allowed-tools|frontmatter\.(name|description|level|pipeline)` in `['packages/coding-agent/src/extensibility']`
- `handoff-policy|handoffPolicy|"pipeline"|frontmatter\.level|frontmatter\[.level.\]` in `['packages/coding-agent/src', 'packages/utils/src']`
- `SKILL_FRONTMATTER|allowedFrontmatter|validateSkill|skillFrontmatter` in `['packages/coding-agent/src']`
- `frontmatter` in `['packages/coding-agent/src/capability']`
- `planner-id|planner_resumable|fallback-reason|fallback_reason|artifact-env|stage_n` in `['packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts', 'packages/coding-agent/src/commands']`
- `--mode|"read"|"write"|"clear"|"contract"|"doctor"` in `['packages/coding-agent/src/gjc-runtime/state-runtime.ts']`
- `ALLOWED_HANDOFF|HANDOFF_TARGETS|handoffTargets|allowedTargets|KNOWN_MODES` in `['packages/coding-agent/src/gjc-runtime/state-runtime.ts', 'packages/coding-agent/src/gjc-runtime/workflow-command-ref.ts']`
- `deliberate` in `['packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts']`
- `--quick|--standard|--deep\b|research-setup` in `['packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts', 'packages/coding-agent/src/defaults/gjc/skills']`
- `CANONICAL_GJC_WORKFLOW_SKILLS\s*=|CanonicalGjcWorkflowSkill\s*=` in `['packages/coding-agent/src']`
- `classify-blocker|record-review-blockers|start-pipeline-overlap|sparkshell` in `['packages/coding-agent/src/gjc-runtime', 'packages/coding-agent/src/commands']`
- `benchmark-system|benchmark-task|benchmark-retry` in `['packages/typescript-edit-benchmark/src']`
- `benchmarkSystemPrompt|benchmarkTaskPrompt|benchmarkRetryPrompt|guided_context|task_prompt|retry_context|multiFile|instructions` in `['packages/typescript-edit-benchmark/src/runner.ts']`
- `## Behavior|## Planning/Execution Boundary|## What This Skill Must Do|## GPT-5.5 Guidance Alignment|Follow the Plan skill|the next the|`execution`, `execution`` in `['packages/coding-agent/src/defaults/gjc/skills']`
- `gjc_delegate_plan|gjc_coordinator_await_turn|gjc_coordinator_watch_events|GJC_COORDINATOR_MCP_MUTATIONS|GJC_COORDINATOR_MCP_WORKDIR_ROOTS` in `['packages', 'plugins']`
- `read-teaming|e2e/read|oh-my-codex` in `['packages/coding-agent/src/defaults/gjc/skills']`
- `expandPromptTemplate` in `['packages/coding-agent/src']`
- `topLevelTags` in `['packages/utils/src/prompt.ts']`
- `post-interview|"adr"|KNOWN_STAGES|STAGE_TYPES|StageType` in `['packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts']`
- `workflowGate|kind: "approval"|"ralplan".*approval` in `['packages/coding-agent/src/tools', 'packages/coding-agent/src/gjc-runtime']`
- `frontmatter\.(level|pipeline|handoff)|\["level"\]|\['level'\]|"pipeline"` in `['packages/coding-agent/src']`
- `skill-fragments|skill-fragment|ai-slop-cleaner` in `['packages/coding-agent/src/defaults/gjc/skills', 'packages/coding-agent/src/extensibility']`
- `resolution|quick|standard|deep(?!-interview)` in `['packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts']`
- `--quick|--standard|--deep |resolution` in `['packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md']`
- `workflowGate|WorkflowGateMeta` in `['packages/coding-agent/src/defaults/gjc/skills']`
- `contentHash` in `['packages/coding-agent/src/extensibility/gjc-plugins/schema.ts', 'packages/coding-agent/src/extensibility/gjc-plugins/types.ts', 'packages/coding-agent/src/extensibility/gjc-plugins/registry.ts']`
- `replaceAsciiSymbols|normalizeRfc2119` in `['packages/coding-agent/src', 'packages/utils/src']`
- `contentHash` in `['packages/coding-agent/src/extensibility/gjc-plugins']`
- `KNOWN_FALLBACK_REASONS = |process_restart|missing_record` in `['packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts']`
- `--stage_n|stage-n|stageN` in `['packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts:60-120']`
- `replaceAsciiSymbols:\s*true|normalizeRfc2119:\s*true|renderPhase:\s*"pre-render"|prompt\.format\(` in `['packages']`
- `pause` in `['packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md']`
- `contentHash|sha256` in `['packages/coding-agent/src/extensibility/gjc-plugins/schema.ts']`
- `renderPluginAppendices\(` in `['packages/coding-agent/src']`
- `relativePath` in `['packages/coding-agent/src/extensibility/gjc-plugins']`
- `ARGUMENTS|substituteArgs|prompt\.render` in `['packages/coding-agent/src/extensibility/skills.ts', 'packages/coding-agent/src/extensibility/slash-commands.ts']`
