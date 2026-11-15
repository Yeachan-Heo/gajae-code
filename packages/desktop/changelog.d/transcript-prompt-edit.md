### Added

- Edit a persisted user prompt in place from the transcript; sending it rewinds the conversation like `/tree` and continues on a new branch.
- Switch between edited prompt revisions with the `‹ n/m ›` control above the prompt, returning to the branch last viewed beneath each revision.

### Fixed

- Retain exact edited text until durable delivery admission succeeds, and prevent duplicate submission while that handoff is pending.
- Preserve fork-child drafts across dismissed dialogs and failed selection; stale creation, export, deletion and history completions no longer replace newer navigation or dialogs.
- Keep `/clear` creation tied to its original navigation intent, including navigation away and back before completion.
