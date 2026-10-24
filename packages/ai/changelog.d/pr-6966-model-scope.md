### Bug Fixes

- auth-storage: Apply model-scoped backoff in both OAuth resolution branches to prevent model-specific quota exhaustion from blocking other models' access to the same credential
- auth-storage: `isCredentialAvailable` accepts the requested model id so AgentSession rotation and compaction no longer skip credentials whose backoff is scoped to another model
- auth-storage: Exhausted usage limits without a usable reset time keep their scope — a reset-less wide limit still blocks the whole credential and a reset-less model-scoped limit blocks only its model — and a reported wide limit is no longer narrowed to the failing model by `markUsageLimitReached`
