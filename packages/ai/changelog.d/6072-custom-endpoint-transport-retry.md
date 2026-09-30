### Fixed

- A large (≥1 MB) request to a custom Anthropic-compatible endpoint is now retried when its connection drops before any response (ECONNRESET, socket closed, `Connection error`). Previously the one-upload ceiling meant for first-event stalls also covered these failures, so a single network blip ended the turn. Server responses (e.g. 529) and first-event timeouts still respect the ceiling (#6072).
