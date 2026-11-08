### Fixed

- A subscriber abort during the post-acceptance canonical drain no longer rewrites the already-published assistant message to `aborted`, so an accepted turn still ends as completed. Tool dispatch is still fenced by the aborted run signal.
