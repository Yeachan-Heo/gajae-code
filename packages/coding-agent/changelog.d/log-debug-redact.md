### Fixed

- Session title debug logs scrub both credential-bearing request text and generated titles, and marketplace clone debug logs scrub URL credentials including token-as-username forms. Shared redaction covers full bracketed credential containers and generic/compound sensitive labels, including `auth`, `bearer`, `credentials`, `secrets`, `session_key`, `private_token`, `OPENAI_API_KEY`, `api_token`, and `AWS_SECRET_ACCESS_KEY`, before they are written.
