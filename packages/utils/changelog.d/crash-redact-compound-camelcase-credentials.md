### Fixed

- Crash redaction now recognizes compound camelCase credential suffixes such as `ApiKey`, `SecretKey`, `AccessToken`, `RefreshToken`, `SessionToken`, and `ClientSecret`, including two-letter acronym prefixes such as `DBPassword` and `openAIApiKey`/`OpenAIApiKey`.
