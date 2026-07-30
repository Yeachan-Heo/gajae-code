<task-summary>
<header>{{successCount}}/{{totalCount}} succeeded{{#if hasCancelledNote}} ({{cancelledCount}} cancelled){{/if}} [{{duration}}]</header>

{{#each summaries}}
<agent id="{{id}}" agent="{{agent}}">
<status>{{status}}</status>
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if worktree}}<worktree path="{{worktree.path}}" identity="{{worktree.identity}}" head="{{worktree.head}}" base="{{worktree.baseRef}}" disposition="{{worktree.disposition}}"{{#if worktree.dirty}} dirty="true"{{/if}} />{{/if}}
{{#if worktreeError}}<worktree-error code="{{worktreeError.code}}">
{{worktreeError.message}}
</worktree-error>{{/if}}
<synopsis{{#if outputUri}} ref="{{outputUri}}"{{/if}}>
{{synopsis}}
</synopsis>
</agent>
{{#unless @last}}
---
{{/unless}}
{{/each}}

{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-summary>
