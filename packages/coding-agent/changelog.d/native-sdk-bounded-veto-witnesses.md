### Fixed
- Preserve original lifecycle binding/effect witnesses through active and terminal compaction so unrelated terminal metadata cannot erase selected-session ownership vetoes. Exhausted witness budgets fail closed before writes.
- Probe read-only authority-directory prefixes incrementally with explicit work and pathname budgets instead of preallocating cumulative paths.
