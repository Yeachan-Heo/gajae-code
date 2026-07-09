Invoke another available skill in the current turn.

<conditions>
- A SKILL document instructs you to chain into another skill on completion (e.g. ralplan → ultragoal)
- You finished one skill's workflow and the next step requires another skill's full prompt context
</conditions>

<instruction>
- `name` is the skill name as it appears in `/skill:<name>` (e.g. `ralplan`, `ultragoal`, `team`, `deep-interview`)
- `args` is the free-form argument string the skill would receive after `/skill:<name>` on the command line
- The tool loads the callee's SKILL.md into the current turn and handles native workflow caller→callee state handoff when the caller is one of the built-in GJC workflows.
- The chain is refused while a native workflow caller is still active. If your current skill is one of `deep-interview`, `ralplan`, `ultragoal`, or `team` and has not yet reached a terminal phase, prepare it first with `gjc state <skill> write --input '{"current_phase":"handoff"}' --json`; no other handoff command is needed. Runtime project/user skills do not use `gjc state <skill>`.
- Call once per chain step. To chain `A → B → C`, A calls `skill(B)`; B's next agent turn calls `skill(C)`.
</instruction>

<critical>
- Do NOT use this tool to "remind yourself" of a skill you're already running. The current SKILL.md is already in your context.
- Do NOT chain into the same skill recursively. If a skill's flow needs another iteration, follow its in-document instructions.
- `name` MUST be one concrete skill name, NOT a glob or wildcard. Passing `*`, `?`, or a pattern like `git-*` is rejected immediately — the `--skills '*'` launch filter is unrelated to this tool's `name`.
- The chained skill's planning/execution-boundary rules still apply. Chaining does not grant execution approval.
</critical>

<examples>
# Hand off from ralplan to ultragoal after an approved plan
{"name": "ultragoal", "args": "track execution of .gjc/plans/ralplan/<run-id>/pending-approval.md"}

# Trigger deep-interview with no arguments
{"name": "deep-interview"}
</examples>
