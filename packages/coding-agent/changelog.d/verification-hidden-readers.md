### Changed

- The system prompt's verification rules now tell the agent that when a change alters a shared data contract (key, identifier, serialized format, schema, default), it also checks the consumers symbol search misses: persisted data, other languages, config and flags, and pinned dependency source.
