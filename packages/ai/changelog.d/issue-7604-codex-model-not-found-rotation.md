### Fixed

- Codex OAuth account rotation now correctly triggers when the provider sends `model_not_found` error code with ChatGPT account wording, in addition to the previously supported `invalid_request_error`. Bare `model_not_found` errors without the account-specific message do not rotate.
