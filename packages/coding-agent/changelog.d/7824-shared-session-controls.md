### Fixed

- Fixed `/fast`, the service tier, the settings-screen default thinking level, `/effort <level>`, model selection (`/model`, selector, cycling, SDK/ACP `model.set`), explicit tool selection and OAuth credential pin/AUTO in shared root TUI sessions after an ordinary message. They no longer fail with "Shared session mutation requires transaction admission"; each publishes its entries additively through admitted shared publication before changing live state (#7824).
- Credential pin/AUTO now records the session intent before changing the live account selection, so a refused write leaves the account unchanged (#7824).
- In a shared session, `/drop` now refuses before it switches. It used to switch and then report a drop that never happened. Internal MCP, `/ssh` and plugin tool refreshes record their selection through admitted shared publication (#7824).
- `/rename`, automatic titles, plan-mode titles and the extension `setSessionName` now save the title through admitted shared title publication. Previously they called the session manager's legacy writer, which is refused once the session is shared (#7824).
- Per-tool TTSR reminder records are now saved through admitted shared publication instead of being silently dropped (#7824).
- An uncertain or committed-but-unapplied shared control write now closes the session with a message that says what happened, instead of retrying or rolling back (#7824).
- Shared tool selection now follows the same rule: an uncertain write, or a saved selection the session could not apply, closes the session and keeps the saved entry IDs, and an uncertain write blocks further writes from that session (#7824).
- A deferred bash or Python result whose shared write is uncertain is no longer retried under a new entry ID. The session closes and reports the attempted ID (#7824).
- Overlapping deferred bash or Python result flushes, such as forced abort recovery and a prompt, now share one flush, so each result is written and reported once (#7824).
