### Fixed

- Steers are now injected into the current turn immediately even when a config hot reload is pending. Previously, steers were blocked waiting on hot reload selection fences, preventing them from interrupting the active turn. Steers now bypass only hot reload selection fences when submitted during a busy turn, while still respecting explicit model-selection fences to preserve selection ordering contracts. ([#7613](https://github.com/Yeachan-Heo/gajae-code/issues/7613), [#4540](https://github.com/Yeachan-Heo/gajae-code/issues/4540))
