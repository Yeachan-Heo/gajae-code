### Fixed

- Broker-launched sessions can set and unset per-session subprocess environment variables, retain them across resume, and inspect them by name without exposing values. Session overlays are applied to Bash, Python, MCP, SSH, and LSP subprocesses; runtime preload and native-loader controls are rejected before the session host starts. Validated session overrides also control browser proxy, certificate, and executable settings without trusting project `.env` values.
