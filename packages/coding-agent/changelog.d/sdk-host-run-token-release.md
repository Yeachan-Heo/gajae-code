### Fixed

- Release the SDK run token when a multi-turn SDK run ends. Previously the next host-initiated run (job/monitor follow-up) was stamped with a dead token, and the SDK host dropped its lifecycle, so a gateway prompt diverted into that run never terminalized (#7767).
- Publish a held plain `agent_end` before a newer terminal takes its slot, so a host-initiated run's end is no longer lost. Later ends could otherwise pair with the orphaned run (#7767).
