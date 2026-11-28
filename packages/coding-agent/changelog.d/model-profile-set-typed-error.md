### Fixed

- `model.profile.set` control operation now returns a typed `invalid_input` error code when a profile's role selectors don't match any catalog model, instead of a generic `internal` error. This allows callers to distinguish deterministic configuration failures from transient issues. (#8054)
