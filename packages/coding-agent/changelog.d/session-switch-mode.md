### Fixed

- Switching to a different session restores a saved plan through the plan controller, and drops that plan binding if plan tool activation fails.
- Switching to a different session drops the previous session's goal and restores the selected session's saved goal only when goal mode is enabled.
- A saved plan restore is rejected before any plan model or tool change while goal mode holds the mode gate, and a saved plan path outside the session `local:` root falls back to `local://PLAN.md`.
