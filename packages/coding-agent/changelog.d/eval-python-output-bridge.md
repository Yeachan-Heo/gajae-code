### Fixed

- Python `output()` helper in eval now works correctly by using the tool bridge instead of filesystem access. This fixes issue #5936 where the helper was always raising `RuntimeError: No session - output artifacts unavailable` because environment variables used to resolve artifacts were intentionally removed for security in #2724. The fix maintains the security boundary while enabling the helper to function properly in Python eval cells.
