### Fixed

- **test: reduce timing flakiness in acp-prompt-watchdog tests** — Changed `waitFor()` polling interval from 5ms to 1ms to improve reliability on variable-latency CI runners. Tests now pass consistently under system load without increased execution time. Verified with 5 consecutive runs with 100% pass rate.
