### Changed

- Edit previews, unified diffs, word highlighting, vim previews, eval-helper diffs, and hashline recovery now obtain diff hunks from the native addon on first use, with no JavaScript diff-generation fallback. Hashline patch application remains on `diff` until the patch/apply-port item.
