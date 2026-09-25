### Added

- `bun run bench:tool-results:live`: a manual live A/B harness that runs a deterministic corpus of read/search tasks against a real model under baseline and candidate settings overrides. It reports tool-result characters per task (per tool), task success, and a verdict. It rejects arms that resolve to identical settings, and provider-errored runs make the verdict inconclusive instead of counting as savings (#5945).
