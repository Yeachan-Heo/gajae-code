# cpu-hotspot-map.json — successor pointer

[`cpu-hotspot-map.json`](./cpu-hotspot-map.json) is **closed out**. All 11 CPU hotspots (H01–H11) and 5 memory hotspots (M01–M05) are resolved or rationally deferred across Optimization Suites v1 (#356), v2 (#530), and v3 (#548/#557/#558). Do **not** treat it as an open implementation backlog.

That map was a **static structural ranking** (algorithmic complexity × trigger frequency). Its `method` field records that real CPU self-time was "to be measured by the agreed profiling corpus during optimization."

Future perf prioritization comes from the **profiling corpus**, not from this static map:

- Evidence classes (`wallClockPhase`, `processCpuUsage`, `profilerSelfTime`, `rssMemory`, `byteParity`) and the corpus schema: see `docs/perf-profiling-corpus.md` (added with the corpus foundation).
- Native algorithmic ports proposed for leftover hotspots are gated by [`native-ffi-optimization-policy.md`](./native-ffi-optimization-policy.md).

A hotspot may be labeled `CPU-self-time confirmed` only when a `profilerSelfTime` artifact exists; v1–v3 shipped wins are otherwise classified as `covered-current`, `not-visible`, `needs-trace-coverage`, or `fallback-toggle-confirmed`.
