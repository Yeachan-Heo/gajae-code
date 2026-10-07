### Fixed
- Allow owner-free saved-session deletion retries to complete after the original workspace is removed, while preserving configured-root and receipt-bound deletion identities.
- Authenticate unrelated historical sibling session storage without requiring its workspace to remain on disk. Shared-owner references, malformed storage, and unresolved owner journals still block cleanup.
- Report GC owner preflight refusals with no artifact effects as preserved sessions rather than destructive partial cleanup failures.
- Release queued SDK cancellation barriers after durable terminal recovery and retain the original recovery owner across shutdown until its work is confirmed.
- Keep SDK terminal publication and submission completion owned by the final same-prompt continuation, rather than reporting a predecessor's success before that continuation fails or finishes.
- Cancel accepted SDK publication waiters when context or history maintenance disconnects their event bridge, without borrowing or cancelling independently queued submission owners.
