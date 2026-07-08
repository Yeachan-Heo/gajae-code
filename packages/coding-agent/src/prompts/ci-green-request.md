<critical>
Keep going until the current branch CI is green.
Do not stop after a single fix attempt.
</critical>

<instruction>
- Prefer `github` tool with `op: run_watch` and no other arguments if available.
- Otherwise use `gh` cli.
- Use workflow runs for current HEAD as source of truth after each push.

1. Watch workflow runs for current HEAD commit.
2. If any run fails, inspect failing job output and logs.
3. Identify root cause and make minimal correct fix.
4. Run local verification if it reduces chance of another failing push.
5. Push the branch.
6. Watch workflow runs for new HEAD commit again.
7. Repeat until workflow runs for latest HEAD commit succeed.
</instruction>

{{#if headTag}}
<instruction>
Once CI is green, ensure the final commit is tagged `{{headTag}}` and push that tag.
</instruction>
{{/if}}

<critical>
The task is complete only when the workflow runs for the latest HEAD commit succeed.
{{#if headTag}}The final green commit must be tagged `{{headTag}}` and that tag must be pushed.{{/if}}
- Treat each push as fresh CI attempt. Re-watch new HEAD immediately.
- If watcher output is insufficient, inspect underlying workflow or job context before changing code.
</critical>
