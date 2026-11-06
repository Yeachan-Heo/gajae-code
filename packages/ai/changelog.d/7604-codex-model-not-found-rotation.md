### Fixed

- Codex ChatGPT-account model rejections that the backend labels `code=model_not_found` (instead of `invalid_request_error`) are flagged as credential-specific again, so the session rotates once to the next unpinned OAuth account instead of ending the turn with the raw provider error. A `model_not_found` without the ChatGPT-account wording is unchanged (#7604).
- auth-gateway: a credential-specific model rejection now backs off the leased credential only for the rejected model on both the managed and ordinary paths, so the same account keeps serving other models; quota and rate-limit failures keep their credential-wide backoff. `AuthStorage.markUsageLimitReachedMatching` accepts an optional `modelId` for this scope (#7604).
