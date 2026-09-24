### Fixed

- Remove per-process test agent and log isolation directories after each Bun test file completes, while keeping the isolated log sink available throughout the run. Set `GJC_TEST_KEEP_TMP=1` to preserve them for debugging (#5852).
