### Fixed
- Clear the submitted draft and attachments once a prompt is admitted, and put the exact payload back — including text typed meanwhile — when the host refuses it, so a running turn no longer invites a duplicate send.
- Find slash commands by the form users type: the command search now accepts `/model`, not only `model`.
- Report a completed conversation export as a message with its HTML path instead of the raw protocol object.
- Render boolean settings as checkboxes and numeric settings as decimal inputs instead of free-text fields.
- Keep a refused operation from marking the conversation as failed: only a failed prompt turn sets the session error, so `/compact`, `/retry` or a profile switch that the host declines leaves the row idle and shows one banner.

### Added
- Add `app-flow-qa`, a manual sixteen-journey suite that drives the real App, Host and SDK against the zero-provider fixture (needs a local Chrome and a free port 1420).
