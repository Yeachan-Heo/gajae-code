### Fixed

- Refuse rename, tool selection, thinking level, skill reload, compaction, retry, tree navigation, revision preparation, branch and automatic title generation when a native-owned session is mutated outside its admitted runtime dispatch. Those entry points wrote the transcript directly, so an embedder holding a raw session reference could bypass native admission and checkpoint accounting. Non-native sessions are unaffected.
