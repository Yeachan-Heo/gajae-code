### Fixed
- Images pasted into the composer now reach the model with `/skill:<name> ... [image N]` commands and with the queued follow-up shortcut (Alt+Enter). The skill dispatcher used to send only the text, so the model answered that the attached image was not visible. A prompt whose `[image N]` placeholder has no pasted image behind it (for example a message restored to the editor after Esc) now stays in the composer with a warning instead of being sent as bare text.
- An input extension that returns only `images` (without `text`) now has its replacement applied. The runner used to drop it, so the original image reached the model.
- The queued follow-up shortcut (Alt+Enter) now runs input extensions before sending, so a replaced or redacted image is what reaches the model. With an active `/btw` side chat it keeps the draft and warns instead of sending only the `[image N]` placeholder.
- `[image N]` text inside a `source="..."` path is no longer read as a placeholder when validating a submission.
- A message restored from the queue no longer silently picks up a newer pending image through its `[image N]` placeholder; the pending attachments are dropped with a warning so the image is attached again.
- Alt+Enter keeps a newer draft or image typed while an input extension is running, and applies input extensions before queueing during compaction.
- An input extension that filters or redacts an image in place (mutating the event array and returning it) now also applies to `/skill:<name> ... [image N]` messages, so the original image no longer reaches the model.
