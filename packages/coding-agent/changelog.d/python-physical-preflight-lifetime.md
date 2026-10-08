### Fixed

- Register Python operations before availability and initialization, and join their captured physical work during owner cleanup.
- Keep standalone Python invocations tracked through transcript append, capture their execution context before preflight, and retain cleanup joins for earlier generations while a successor runs.

### Security

- Python owner ids remain legacy string labels; these lifecycle changes do not establish private owner authority or transcript/audit filesystem append permission.
