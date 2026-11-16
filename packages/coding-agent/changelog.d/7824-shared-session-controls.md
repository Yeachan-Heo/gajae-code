### Fixed

- Fixed `/fast`, the service tier, the settings-screen default thinking level, `/effort <level>`, model selection (`/model`, selector, cycling, SDK/ACP `model.set`), explicit tool selection and OAuth credential pin/AUTO in shared root TUI sessions after an ordinary message. They no longer fail with "Shared session mutation requires transaction admission"; each publishes its entries additively through admitted shared publication before changing live state (#7824).
- Credential pin/AUTO now records the session intent before changing the live account selection, so a refused write leaves the account unchanged (#7824).
- `/clear` in a shared session now refuses before it resets the conversation, because a shared transcript cannot yet publish a new root marker. Previously the conversation was wiped and then the transcript write failed (#7824).
- An uncertain or committed-but-unapplied shared control write now closes the session with a message that says what happened, instead of retrying or rolling back (#7824).
