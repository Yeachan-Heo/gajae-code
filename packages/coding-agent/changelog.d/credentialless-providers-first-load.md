### Fixed

- Providers that need no API key by design (Devin, which logs in through its own CLI, and other `allowUnauthenticated` providers such as LM Studio and oMLX) are now treated as credentialless from the first model load. Before, they were marked credentialless only during the online discovery sweep, so a subagent or an offline refresh failed them with "No credentials found" and a fallback chain such as `deepseek → devin/swe-2 → …` skipped Devin. A provider configured in `models.yml` keeps the auth mode configured there.
