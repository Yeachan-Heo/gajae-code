<task-summary>
<header>{{successCount}}/{{totalCount}} succeeded{{#if hasCancelledNote}} ({{cancelledCount}} cancelled){{/if}} [{{duration}}]</header>

{{#each summaries}}
<agent id="{{id}}" agent="{{agent}}">
<status>{{status}}</status>
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
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
