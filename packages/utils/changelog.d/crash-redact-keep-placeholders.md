### Fixed

- Crash redaction now masks a credential suffix that directly follows a quoted redaction placeholder (`token="[REDACTED_TOKEN]"secret`). The placeholder exemption shipped in 0.19.0 checked only the quoted text and left that suffix in place.
