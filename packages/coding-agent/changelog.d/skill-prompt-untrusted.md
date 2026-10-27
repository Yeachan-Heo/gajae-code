### Fixed

- A repository skill body is fenced as untrusted content in the model prompt, an end tag inside that body stays escaped, and the body and host suffix are shortened before that fence so the saved prompt keeps its closing fence within the session text cap.
