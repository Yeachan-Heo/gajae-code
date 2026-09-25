### Added

- Added `bench/agent-session-profile.ts`, which records a `.cpuprofile`, early and late V8 heap snapshots, and post-GC memory samples for the `memory-agent-session-lifecycle` perf fixture. It separates reachable retention from allocator high-water and reclassifies the agent-session hotspots from the captured profiler symbols. Recorded evidence shows the agent-session soak RSS growth is bounded allocator high-water, not retention: reachable heap grew +0.5 MiB and the live object count fell. It also confirms `getEntries` and `#appendEntry` CPU self-time (#5942).
