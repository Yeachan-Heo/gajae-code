### Fixed

- A project `.env` value of `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` no longer turns GenAI message-content capture on. An operator value the project does not declare is unchanged, including a downgrade before the first read. Removing the variable before that read keeps capture off, even when a trusted agent env file still says `full`.
