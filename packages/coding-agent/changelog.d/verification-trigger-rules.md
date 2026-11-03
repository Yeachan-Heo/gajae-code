### Changed

- The system prompt's verification rules now tell the agent to test a shared assumption directly once a second fix built on it fails the same check, and, before attributing a measured result (speedup, regression, latency, eval score) to a change, to identify the bottleneck or confounder that bounds it, rule out that it measured something else, and label attribution it could not verify.
