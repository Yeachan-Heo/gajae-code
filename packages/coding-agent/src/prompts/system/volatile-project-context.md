<system-reminder>
{{#if workspaceTree.rendered}}<workspace-tree>
Working directory layout (sorted by mtime, recent first; depth ≤ 3):
{{workspaceTree.rendered}}
{{#if workspaceTree.truncated}}
(some entries elided to keep the tree short — use `find`/`read` to drill in)
{{/if}}
</workspace-tree>
{{/if}}Today is {{date}}, and the current working directory is '{{cwd}}'.
</system-reminder>
