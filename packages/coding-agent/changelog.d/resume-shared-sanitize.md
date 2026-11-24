### Fixed

- Fixed regression where `/resume` of a shared managed session with stale OpenAI Responses replay metadata would throw "Shared session mutation requires transaction admission" error. The admission check for replay metadata sanitization is now only performed when actually persisting patches (non-managed destinations), not during in-memory sanitization.
