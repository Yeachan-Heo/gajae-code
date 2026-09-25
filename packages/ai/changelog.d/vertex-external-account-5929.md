### Fixed

- Vertex AI Application Default Credentials now accept `type: "external_account"` (Workload Identity Federation): the subject token is read from `credential_source` (file, url, or opt-in executable), exchanged at STS, and optionally impersonated via `service_account_impersonation_url`, so gjc authenticates from GitHub Actions / GitLab CI without a long-lived service-account key. Unrecognised credential types now fail with a clear "Unsupported Google credential type" error instead of a misleading OAuth client error. (#5929)
