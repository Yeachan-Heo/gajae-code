### Fixed

- Preserve the exact viewed conversation branch across desktop host restarts using the public SDK session-view API and the existing application catalog. Invalid or stale saved views fail explicitly without falling back to the latest branch or issuing provider requests.
- Advance saved views after settled continuations while keeping initially empty conversations open to their first terminal continuation.
