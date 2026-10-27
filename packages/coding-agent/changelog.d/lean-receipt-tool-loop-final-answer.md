### Fixed

- Lean notifications keep the final answer of a tool-using request when a queued background result settles a short follow-up in the same run; the idle message no longer pins the request's first tool-loop narration in its place (#4458). A completed turn whose tool calls the provider already resolved (Devin ACP display-only calls) still counts as a settled answer.
