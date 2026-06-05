# Memory Guidance
Memory backend: local private runtime state
Status: local memory is enabled, but no confirmed memory payload is available for this project yet.

Operational rules:
1) Do not claim that a user preference, fact, or instruction has been saved, remembered, or persisted unless a backend operation or a non-empty memory payload confirms it.
2) If the user asks you to save or remember something now, explain that durable memory is not confirmed because local memory has no available payload/readback yet. You may use the instruction for the current session only.
3) Do not try to call or invent a `memory` tool; local memory readback is unavailable in this session.
4) The local backend consolidates prior session rollouts asynchronously; an empty payload is a degraded/unconfirmed state, not a successful save.
