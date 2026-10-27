### Fixed

- Discord and Slack notification frames publish only their own string fields, and a replayed frame body is scrubbed again before the provider post, so prototype text is not sent. Ask choices and an explicit redact opt-out stay readable, including a Slack ask root posted after a lease wait.
