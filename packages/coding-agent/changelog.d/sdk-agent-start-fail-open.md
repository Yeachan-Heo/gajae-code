### Fixed

- Interactive and skill turns no longer wait up to 30s on SDK `agent_start` durable persist. The inline host handler no longer times out with `Extension "<inline-N>" error: handler timed out after 30000ms`; SDK consumers still observe start before content.
