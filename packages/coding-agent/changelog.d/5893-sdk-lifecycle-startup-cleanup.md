### Fixed

- SDK lifecycle startup now safely reconciles promotion fences left by a process crash after fencing but before fence removal, preventing failure receipts from becoming permanently unreadable. Restart readers validate the fence's recorded artifact digest against the staged and final receipts; if the final receipt matches, the fence is removed and the receipt becomes readable; if only a staged receipt exists or digests mismatch, the fence remains (fail-closed) to preserve recovery safety.
