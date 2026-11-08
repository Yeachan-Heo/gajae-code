### Fixed

- Serialize existing same-directory managed session opens with participating shared appends during transcript hydration, preventing a peer append from causing a spurious identity-mismatch rejection. Strict checks still reject changes made by writers outside the transaction protocol.
