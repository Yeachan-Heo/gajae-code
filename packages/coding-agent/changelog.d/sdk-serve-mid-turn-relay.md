### Fixed

- `gjc sdk serve --stdio` now relays supported mid-turn session events without claiming optional capabilities the downstream client did not negotiate. Observer delivery is limited to connections that explicitly negotiated both turn streaming and session-host observation.
