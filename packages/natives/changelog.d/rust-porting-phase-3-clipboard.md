### Fixed

- Native clipboard reads now decode Windows CF_DIB/CF_DIBV5 images that arboard rejects, and Linux retains its X11 clipboard owner so copied text remains available after the call returns.
