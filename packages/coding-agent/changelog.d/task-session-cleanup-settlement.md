### Fixed

- Subagent task receipts now report session cleanup as settled, pending, or failed independently from the agent work result. Timed-out disposals retain a monitored teardown owner and join the session's existing disposal promise before being reported clean.
