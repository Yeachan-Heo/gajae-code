### Fixed

- `/star`, `/unstar`, and starring the open session from the session picker no longer fail with "Shared session mutation requires transaction admission" in a shared session. The star is written as an append-only update, so other open windows keep their history.
- `/fork` on a shared session is now refused before the session is touched. Previously the refusal came only after extensions had been told about the switch and the agent had been disconnected.
