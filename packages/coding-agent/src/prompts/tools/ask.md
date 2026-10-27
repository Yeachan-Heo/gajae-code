Asks user when you need clarification or input during task execution.

<conditions>
- Multiple approaches exist with significantly different tradeoffs user should weigh
</conditions>

<instruction>
- Use `recommended: <index>` to mark default (0-indexed); " (Recommended)" added automatically
- Use `questions` for multiple related questions instead of asking one at a time
- Set `multi: true` on question to allow multiple selections
- Every question body must contain meaningful, non-whitespace text. Never add empty `metadata`/`ignore` questions.
- While deep-interview is in the `interviewing` phase, submit exactly one question with the required `deepInterview` metadata on that question. Round 0 needs `round: 0`, `component: "review-topology"`, `dimension: "topology"`, `ambiguity`, and `intent_contract` containing the displayed items and affirmative labels. Later questions need a positive round, component, dimension, and ambiguity. Question prose and `workflowGate` alone cannot record an interview answer. After final-spec persistence transitions to `handoff`, next-workflow/approval choices are ordinary asks without interview round metadata.
</instruction>

<caution>
- Provide 2-5 concise, distinct options
</caution>

<critical>
- **Default to action.** Resolve ambiguity yourself using repo conventions, existing patterns, and reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Only ask when options have materially different tradeoffs the user must decide.
- **If multiple choices are acceptable**, pick the most conservative/standard option and proceed; state the choice.
- **Do NOT include the automatic custom-input control or labels that imitate it** such as "Other (type your own)", "Other (specify)", "type your own", "custom input", or "직접 입력" — UI automatically adds "Other (type your own)" to every question. A plain domain value such as "Other" is allowed when it is a genuine answer, not a request for free text. To collect free text, ask for it in the question body and rely on the automatic Other/custom-input control instead of adding a fake option.
</critical>

<examples>
# Single question
questions: [{"id": "auth_method", "question": "Which authentication method should this API use?", "options": [{"label": "JWT"}, {"label": "OAuth2"}, {"label": "Session cookies"}], "recommended": 0}]

# Multiple questions
questions: [{"id": "storage_type", "question": "Which storage backend?", "options": [{"label": "SQLite"}, {"label": "PostgreSQL"}]}, {"id": "auth_method", "question": "Which auth method?", "options": [{"label": "JWT"}, {"label": "Session cookies"}]}]
</examples>
