### Fixed

- Keep SDK prompts alive when transient directed delivery back-pressure (`writer_backlog_full`) drops a correlated progress frame. Previously the prompt was abandoned while the run kept executing, so the final `agent_end` was dropped and ACP clients only settled the prompt when the prompt watchdog expired. Terminal frames now retry briefly under back-pressure so the prompt settles normally.
- Release the prompt submission and work lease when terminal delivery still fails after the retry window, while preserving the `delivery_failed` terminal outcome.
