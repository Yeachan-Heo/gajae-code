### Fixed
- Remove the model resolver's runtime dependency on the model registry to prevent invalid initialization code in compiled packages, while retaining the registry's `MODEL_ROLE_IDS` export.
