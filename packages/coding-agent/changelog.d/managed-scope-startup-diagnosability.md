### Fixed

- Managed session startup failures now report allowlisted identity and filesystem error classifications instead of collapsing them into `binding_invalid`. Unknown or path-bearing messages remain redacted, and the existing top-level error code contract is unchanged.
