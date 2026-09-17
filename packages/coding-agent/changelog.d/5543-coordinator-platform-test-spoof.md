### Fixed

- The coordinator platform-capability test no longer swaps `process.platform` process-wide (which made valid native lock publication receipts look invalid before the artifact handler ran); platform discovery and refusal are now driven entirely through the resolved server platform option.
