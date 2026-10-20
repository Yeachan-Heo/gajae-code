### Bug Fixes

- auth-storage: Apply model-scoped backoff in both OAuth resolution branches to prevent model-specific quota exhaustion from blocking other models' access to the same credential
