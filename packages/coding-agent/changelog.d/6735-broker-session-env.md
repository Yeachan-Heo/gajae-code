### Added

- `session.create`, `session.fork`, and `session.resume` accept an optional per-session `env` map and `unsetEnv` list. The broker applies them to that session host's environment, so its Bash executor sees them, without touching the broker's own environment. Two sessions hosted by the same broker can therefore run with different `PATH` or tenant variables. Names must be valid variable names outside the broker-reserved `GJC_*` namespace, and a name may not be both set and unset. Values of credential-named variables are redacted from startup diagnostics (#6735).
