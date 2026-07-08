End an active checkpoint. Rewind context to it, replacing intermediate exploration with your report.

Call immediately after `checkpoint`-started investigative work.

Requirements:
- `report` is REQUIRED and must be concise, factual, and actionable.
- Include key findings, decisions, and any unresolved risks.
- Do not include raw scratch logs unless essential.
- `checkpoint`'s must-rewind-before-yield rule applies: never yield with a checkpoint still active.

Behavior:
- If no checkpoint is active, this tool errors.
- On success, the session rewinds and keeps your report as retained context.
