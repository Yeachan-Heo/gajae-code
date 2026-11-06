### Fixed

- The TUI transcript now marks images attached to a user message that its text does not reference, as `[image: image/jpeg]`. Prompts from another client (ACP, the SDK, a phone app) carry image blocks without the editor's `[image N]` references, so the transcript showed only their text, and an image-only prompt was not shown at all while the model still answered it. Images attached by a CLI `@file` argument or an extension input handler get the marker too. Prompts typed in the TUI, whose text already names their images, are unchanged.
