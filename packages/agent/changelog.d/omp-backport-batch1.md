### Fixed

- Optimizes OpenAI compaction history builder call-id tracking to avoid O(N^2) rescans of input (port omp 53917fc382)
- Preserves informative tool results in branch summaries for abandoned-branch observations during tree navigation (port omp 644a20638b)
