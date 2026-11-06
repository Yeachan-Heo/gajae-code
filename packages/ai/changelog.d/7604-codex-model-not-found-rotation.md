### Fixed

- Codex ChatGPT-account model rejections that the backend labels `code=model_not_found` (instead of `invalid_request_error`) are flagged as credential-specific again, so the session rotates once to the next unpinned OAuth account instead of ending the turn with the raw provider error. A `model_not_found` without the ChatGPT-account wording is unchanged (#7604).
