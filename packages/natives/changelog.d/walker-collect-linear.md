### Fixed

- Restored `glob`/`find` speed on large trees: the walker's collect path re-summed every retained path on each new entry, so a 40k-entry scan took ~1.5s (even from the scan cache) instead of ~0.2s.
