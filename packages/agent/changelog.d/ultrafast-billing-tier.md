### Fixed

- Billing callbacks now receive the provider-effective service tier after a downgrade, avoiding cost-tier mismatches.
- Lossless message snapshots preserve the provider-effective service tier when other metadata is not cloneable.
