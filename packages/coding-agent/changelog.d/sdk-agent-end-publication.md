### Fixed

- SDK sessions now publish deferred `agent_end` events after continuation decisions are resolved and the originating prompt finalizer and earlier event handlers have completed, so terminal updates are not lost and do not race successor turns. Batched terminals publish in order, and settlement waits for the entire batch. Disposing during an in-flight extension delivery rejects the outstanding SDK terminal instead of leaving its submitter pending.
