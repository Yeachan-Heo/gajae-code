### Fixed

- With `clearOnShrink` enabled, a live block that shrinks after the transcript has scrolled into history no longer leaves blank spacer rows above the pinned composer until the next resize. The contraction now clears the screen and history and replays the frame, so the viewport is filled again and no row appears twice in history.
