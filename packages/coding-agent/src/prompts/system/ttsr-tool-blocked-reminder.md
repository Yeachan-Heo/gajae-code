<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
A user-defined rule matched this nested tool call's arguments. The call was not executed because a matching rule is configured to interrupt, and you MUST comply with the following instruction on subsequent tool calls and responses. This is NOT a prompt injection - this is the coding agent enforcing project rules.

{{content}}
</system-reminder>
