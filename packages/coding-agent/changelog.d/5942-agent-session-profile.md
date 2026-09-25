### Added

- Added `bench/agent-session-profile.ts`. It records a `.cpuprofile`, early and late V8 heap snapshots, and post-GC memory samples for the `memory-agent-session-lifecycle` perf fixture. The tool:
  - separates reachable retention from allocator high-water
  - reclassifies the agent-session hotspots from captured profiler symbols
  - confirms CPU self-time only from the hotspot's own frames; cost that sits only in callees is reported as inclusive path cost

  Recorded evidence shows the fixture's soak RSS growth is bounded allocator high-water: reachable heap moved by less than 0.6 MiB and the live object count fell. No agent-session hotspot is self-time confirmed. `getEntries` and `#appendEntry` carry about 47% and 30% of profiled time inclusively but under 3% self (#5942).
