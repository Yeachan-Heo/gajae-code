### Changed

- The newly bundled `gpt-6-sol` and `gpt-6-luna` Codex rows are declared in the autorouting tier-map skip list, exactly as `gpt-6-astra` already is, so `check:autorouting-map` and its CI gate keep passing and the two new keys do not silently shift role routing before they are curated.
