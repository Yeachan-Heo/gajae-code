### Fixed

- Classified the `/fork` slash command restored by #5515 as a local-only seam in the SDK operation inventory, so `generate-sdk-operation-inventory --check` no longer reports it as a pending review seam and `dev` CI is unblocked (#5515).
