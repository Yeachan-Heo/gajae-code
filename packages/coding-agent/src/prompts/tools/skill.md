Invoke another available skill as the next turn.

<conditions>
- A SKILL document instructs you to chain into another skill on completion (e.g. ralplan → ultragoal)
- You finished one skill's workflow and the next step requires another skill's full prompt context
</conditions>

<instruction>
- `name` is the skill name as it appears in `/skill:<name>` (e.g. `ralplan`, `ultragoal`, `team`, `deep-interview`)
- `args` is the free-form argument string the skill would receive after `/skill:<name>` on the command line
- The skill's SKILL.md is queued as a user-attribution message and activates on the **next** turn — current turn finishes first
- Call once per chained skill. To chain `A → B → C`, A's skill calls `skill(B)`, then B's skill (running next turn) calls `skill(C)`
</instruction>

<critical>
- Do NOT use this tool to "remind yourself" of a skill you're already running. The current SKILL.md is already in your context.
- Do NOT chain into the same skill recursively. If a skill's flow needs another iteration, follow its in-document instructions.
- The chained skill's planning/execution-boundary rules still apply. Chaining does not grant execution approval.
</critical>

<examples>
# Hand off from ralplan to ultragoal after an approved plan
{"name": "ultragoal", "args": "track execution of .gjc/plans/ralplan/<run-id>/pending-approval.md"}

# Trigger deep-interview with no arguments
{"name": "deep-interview"}
</examples>
