### Fixed

- Telegram notification daemon now accepts event replays with retention gaps when identity evidence is sufficient. If the identity_header fell inside the gap, replay is admitted only when same-transport resume or bootstrap is possible; otherwise rejected. Durable cursor advances to the replay's lastSeq to prevent re-hitting the same gap. action_needed state is reconstructed only from events after the gap.
