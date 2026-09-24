### Performance

- `Text` measures each row once and slices overflow instead of measuring again. `Loader` no longer re-clamps its rows.

### Fixed

- `Text` rows, including custom-background rows, no longer exceed the viewport width.
