### Fixed
- `gjc auth-broker logout <provider>` now reports `FAILED` and exits with code 1 when the broker database cannot be written, instead of printing `Logged out of <provider>` while the credentials stay active. A missing provider argument is reported the same way.
- When invalidating GitHub Copilot credentials after an authentication failure cannot be written, the session logs a warning and finishes post-turn handling; the credential stays stored.
- Switching a provider from a stored API key to an environment variable now reports the refused disable when the credential store cannot write, instead of a later "kept N credentials" error.
