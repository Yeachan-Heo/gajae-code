### Fixed

- **Issue #7848**: OAuth re-login now keeps disabled credentials until a replacement authenticates successfully. Previously, the disabled credential was hard-deleted before the new login attempt, leaving users without fallback if the re-login failed. Now the credential is retained and only removed after the new authentication completes successfully.

### Changed

- `OAuthSelectorOptions` now includes an optional `credentialsToRemoveAfterLogin` field to track credentials pending removal after successful login.
- `#handleOAuthLogin` now handles removal of disabled credentials after successful OAuth login, ensuring the disabled credential is only deleted when the new one is established.
