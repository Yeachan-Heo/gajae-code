Records a tool that behaved inconsistently with its own description, for local quality tracking.

<instruction>
- Call this when a tool's output contradicts what its description or parameters promise: ignored or misapplied parameters, wrong or truncated results, misleading errors, silent no-ops.
- `tool` is the misbehaving tool's name; `report` states what you called, what you expected, and what actually happened, in one or two sentences.
- Do not report your own mistakes, user-caused failures, or expected errors (missing files, failing tests, network outages).
- Do not paste secrets, tokens, credentials, or raw tool output into report; summarize it instead.
- False positives are acceptable. Report once per distinct problem, then continue the task; this never fixes or retries anything.
</instruction>

<output>
Confirms whether the report was recorded. Reports stay on this machine.
</output>
