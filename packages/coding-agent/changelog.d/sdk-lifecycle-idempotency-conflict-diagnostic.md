### Fixed

- SDK lifecycle failures caused by a broker idempotency conflict now carry a single fixed public diagnostic (`lifecycle_idempotency_conflict`) in both JSON and text command-error output, so an operator can tell a conflict from an ordinary `operation_failed` without the broker's raw message, paths, or credentials reaching the envelope. The diagnostic text names no cause and does not suggest that another request key is safe. The public failure code, effect proof, retryability, and exit code are unchanged.
