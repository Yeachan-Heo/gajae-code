# Perf profiling corpus

The profiling corpus is the **successor** to the static [`cpu-hotspot-map.json`](./cpu-hotspot-map.json) ranking (see [`hotspot-map-successor.md`](./hotspot-map-successor.md)). The static map ranked hotspots by complexity × trigger frequency but never measured real CPU self-time. The corpus replaces that guess with measured, separated evidence and is the source of future perf prioritization.

Implementation:

- Schema + evidence taxonomy + validation: `packages/coding-agent/bench/perf-corpus-schema.ts`
- Runner: `packages/coding-agent/bench/perf-corpus.bench.ts`
- Threshold/evidence ledger: `packages/coding-agent/bench/perf-threshold.ledger.ts`
- Tests: `packages/coding-agent/test/perf-corpus.test.ts`
- Deterministic memory surface workloads: `packages/coding-agent/bench/memory-baseline-workloads.ts`

## Evidence taxonomy

Each metric and optimization claim is classified by **evidence class**. These classes must never be conflated:

| Class | Meaning | Sufficient for CPU self-time? |
|---|---|---|
| `wall-clock-proxy` | elapsed time around a phase/operation | No |
| `process-cpu-usage` | `process.cpuUsage()` user/system deltas | No |
| `profiler-self-time` | profiler/sampled attribution of self-time to a symbol | **Yes (required)** |
| `rss-memory` | RSS/heap baseline/growth/return | No (memory only) |
| `byte-parity` | golden rendered/persisted/provider/materialized comparisons | n/a (safety) |
| `ledger-approved-threshold` | human-approved threshold change | n/a (process) |

Optimization **status vocabulary** for a hotspot:

- `CPU-self-time confirmed` — requires `profiler-self-time` evidence (an `artifactPath` or non-empty `samples`).
- `fallback-toggle-confirmed` — comparable before/after or feature/fallback-toggle evidence proves an end-to-end win without byte changes.
- `covered-current` — the corpus exercises the path but has no comparable before/after evidence.
- `not-visible` — the path was not exercised or showed no measurable impact.
- `needs-trace-coverage` — the corpus lacks fixture coverage for the path.

A v1–v3 win is **never** called "confirmed" from current-only coverage. `validatePerfCorpusReport()` enforces this: a `CPU-self-time confirmed` classification is rejected unless the report carries profiler self-time evidence.

## Schema (gjc.perf-corpus/2)

`PerfCorpusReport` keeps the evidence classes as **separate named fields** per fixture:

- `wallClockPhase: Record<string, { elapsedMs, p50Ms?, p95Ms?, advisoryOnly }>`
- `processCpuUsage: Record<string, { userMicros, systemMicros, elapsedMs, cpuFraction? }>`
- `profilerSelfTime: { profiler, artifactPath?, samples? }`
- `rssMemory: { baselineBytes, peakBytes?, growthBytes, returnBytes, ... }`
- `byteParity: { renderedGolden?, persistedJsonlGolden?, providerPayloadGolden?, materializedSessionGolden? }`
- `memoryBaseline?: { surface, profile, iterations, operations, operationsPerSecond, samples, postTeardown, rssSlopeBytesPerSecond, heapSlopeBytesPerSecond, processTreeBaselineRssBytes, processTreePostTeardownRssBytes, processTreeSampler }`
- `runner: { command, argv, environment, platform, arch, bunVersion?, ci?, profile, durationTargetMs?, memoryIsolation, iterationsTarget, gcExposed, memoryChildGcExposed, memoryChildExecArgv }` pins the actual parent argv, normalized workload controls, isolation, parent GC availability, and the fixed isolated-child runtime flags separately.
- `gitSha` is the full checked-out `HEAD` when Git is available, with `GITHUB_SHA` used only as a fallback; `gitDirty` explicitly marks tracked or untracked worktree changes so local evidence cannot silently masquerade as a clean commit. The runner captures SHA and the complete porcelain worktree fingerprint before and after the workloads and rejects any in-flight source-state change.
- Every detailed sample separates `rssBytes`, `heapUsedBytes`, `heapTotalBytes`, `externalBytes`, `arrayBuffersBytes`, and `activeResourceCount`.

`hotspotClassifications: HotspotClassification[]` carry `{ hotspotId, status, evidenceClass, artifactRefs, notes }`. The current v1–v3 reclassification lives in `V1_V3_RECLASSIFICATION`; no entry there is `CPU-self-time confirmed` because the base runner attaches no profiler. Profiler-backed reclassifications for the agent-session hotspots come from `bench/agent-session-profile.ts` (see [Agent-session profiler evidence](#agent-session-profiler-evidence-5942)).

## Privacy rules

- Never commit raw private session transcripts.
- Default fixtures are `synthetic` (deterministic PRNG, no real data).
- `sanitized-real` / `dogfood-redacted` fixtures are allowed only with documented redaction in `privacy.redactionNotes`; `privacy.rawPrivateTranscriptCommitted` must be `false`.

## Commands

```bash
# Emit a corpus report (stable JSON)
bun packages/coding-agent/bench/perf-corpus.bench.ts

# Run the corpus schema/classification/ledger tests
bun test packages/coding-agent/test/perf-corpus.test.ts
```

```bash
# Emit the detailed short memory profile with explicit GC return samples
bun --smol --expose-gc packages/coding-agent/bench/perf-corpus.bench.ts

# Opt into the longer bounded soak profile
GJC_MEMORY_PROFILE=soak bun --smol --expose-gc packages/coding-agent/bench/perf-corpus.bench.ts

# Override the per-surface duration (250–60000 ms) and minimum iterations
GJC_MEMORY_PROFILE=soak GJC_MEMORY_DURATION_MS=10000 GJC_MEMORY_ITERATIONS=100000 bun --smol --expose-gc packages/coding-agent/bench/perf-corpus.bench.ts
```

## Profiler-artifact expectations

The base runner attaches no profiler (`profilerSelfTime.profiler: "none"`), so it can never promote a hotspot to `CPU-self-time confirmed`. To confirm CPU self-time:

1. Capture a profiler artifact (e.g. a `.cpuprofile`) while running the relevant fixture.
2. Record it in the fixture's `profilerSelfTime` as `{ profiler, artifactPath, samples }`.
3. Set the hotspot classification to `CPU-self-time confirmed` with `evidenceClass: "profiler-self-time"` and the artifact in `artifactRefs`.
4. `validatePerfCorpusReport()` will then accept the claim.

`bench/agent-session-profile.ts` automates this for the `memory-agent-session-lifecycle` fixture. Its report's `profilerSelfTime` drops into that fixture and its `hotspotClassifications` validate against it.

## Agent-session profiler evidence (#5942)

The `short`/`soak` corpus reported an agent-session RSS slope of 28.8 MB/s and a heap slope of 14.8 MB/s (153 → 244 MB), but had no profiler evidence. `bench/agent-session-profile.ts` runs the same `createSessionWorkload()` in two equal phases:

1. **Memory phase, unprofiled.** A forced full GC runs every `--sample-interval-ms` (default 1000). Each sample records pre-GC RSS and heap, then post-GC RSS, `heapUsed`, external bytes, and the live JSC object count. V8 heap snapshots are taken after warm-up (at 1/4 of the run) and at the end. The CPU profiler stays detached because its sample buffer lives on the JS heap.
2. **CPU phase.** The inspector CPU profiler samples every 500 µs and writes a `.cpuprofile`.

Retention is judged from the **snapshot-reachable self size** and the live object count across the steady-state window. It is never judged from RSS, which keeps allocator pages already released, or from `heapUsed` alone. JSC `heapUsed` can step up by a heap block without any new reachable objects.

```bash
bun --smol packages/coding-agent/bench/agent-session-profile.ts [--duration-ms 30000] [--out artifacts/perf/agent-session-profile]
```

The output directory holds `agent-session-lifecycle.cpuprofile`, `agent-session-lifecycle.{early,late}.heapsnapshot`, and `agent-session-profile.json`. That directory is `artifacts/` by default, which is gitignored; artifacts are regenerated, not committed.

### Recorded result

- Measurement: commit `547d76da26b1`, clean worktree, Bun 1.4.0, linux-x64, `--duration-ms 30000`, three independent runs. Each run did 2.35–2.59 M appends and profiled about 30 s of CPU.
- **Verdict: `bounded-high-water` in 3/3 runs. No retention site exists.**
  - Snapshot-reachable heap grew only 24.27–24.35 → 24.85 MiB (+0.50 to +0.59 MiB) across the steady-state window.
  - The live object count *fell* by 969–1,657 objects.
  - Outside the snapshot sample, post-GC RSS plateaued at about 190–220 MB and ended at 202–214 MB. The steady-state RSS slope was 0.68–1.09 MB/s, flat within noise.
  - The peak RSS of about 460 MB appears at the early-snapshot sample. It is the snapshot's own serialization, not workload growth.
- **Slope explanation.** The 28.8 MB/s corpus slope comes from its 1 s soak window. RSS climbs about 70 MB in the first ~500 ms as the allocator reaches its high-water mark, then stops. A longer window drives the slope toward zero. Pre-GC heap churns between about 18 and 32 MB within each 128-entry session, and a GC returns it.
- **CPU.** Inclusive / self shares of profiled time across the three runs:
  - `getEntries`: 46.7–48.6% / 0%
  - `#appendEntry`: 30.8–32.0% / 0.4–2.6%
  - `Object.entries`: 29.6–38.4% / 29.6–38.4%, called from `jsonLikeValueExceedsCacheLimit`'s `visit`, `stripUndefinedPlainObjectFields`, `externalizeResidentValueSync`, `cloneJsonSemantic`, and `materializeResidentValueSync`
  - `visit` in `jsonLikeValueExceedsCacheLimit`: 16.5–17.8% / 1.3–1.9%
  - `Buffer.byteLength`: 6.3–9.3% / 6.3–9.3%

Reclassification of the agent-session hotspots from that evidence (threshold: ≥5% of profiled time inclusive):

| Hotspot | Status | Evidence |
|---|---|---|
| M01 `#appendEntry` retention | `CPU-self-time confirmed` (CPU); memory retention **not** confirmed | 30.8–32.0% inclusive; reachable heap bounded |
| M02 `getEntries()` copy | `CPU-self-time confirmed` (CPU); memory retention **not** confirmed | 46.7–48.6% inclusive; cost is the per-entry `Object.entries` walk, not retained copies |
| M03 `buildDisplaySessionContext` | `needs-trace-coverage` | symbol absent from this fixture's profile |
| M04 `AppendOnlyLog` + `cloneJson` | `needs-trace-coverage` | symbol absent from this fixture's profile |
| M05 `captureState`/`restoreState` | `needs-trace-coverage` | symbol absent from this fixture's profile |
| H10 replay equality | `needs-trace-coverage` | symbol absent from this fixture's profile |

The CPU confirmation does not justify a memory rewrite. The measured cost is JSON-shape walking (`Object.entries`, `Buffer.byteLength`) on the append and materialize paths. Any optimization there needs a same-host before/after run of this tool, and byte-parity gates still apply.

## Threshold-promotion process

Wall-clock and RSS thresholds are noisy. Promotion is gradual:

1. **Advisory** — reported in the corpus JSON / console; never fails CI. All thresholds start here (`APPLIED_PERF_THRESHOLDS`, `advisoryOrEnforced: "advisory"`, `varianceCharacterized: false`).
2. **Opt-in numeric** — exercised under `PI_TUI_PERF_GATES=1` (see `packages/tui/test/perf-gates.test.ts`).
3. **Enforced** — a hard CI gate, allowed only with `varianceCharacterized: true`, passed before/after `benchmarkEvidence`, and human approval. `validatePerfThresholdLedger()` rejects enforced thresholds lacking this evidence.

Held thresholds (`HELD_PERF_THRESHOLDS`) name candidates that need variance characterization before enforcement.

## Memory baseline protocol

Detailed memory fixtures cover seven explicit surfaces: CLI startup/configuration, AgentSession-style message/context lifecycle, blob/external buffers, worker generations, Telegram reconnect/queue settlement, TUI render/dispose churn, and shared/native transfer boundaries. The fixtures are synthetic lifecycle proxies: they establish a reproducible allocation and teardown envelope but do not by themselves prove a production leak. A production optimization claim still requires a workload adapter that exercises the implicated owner and a same-host before/after artifact.
The command-line runner executes each memory surface in a fresh Bun subprocess and records `runner.memoryIsolation: "process-per-surface"` so allocator high-water state from one fixture cannot contaminate the next surface's baseline. Programmatic `runPerfCorpusBenchmark()` defaults to in-process fixtures and records `"in-process"` for focused contract tests; pass `{ isolatedMemory: true }` for acceptance-equivalent evidence. Process-tree RSS snapshots exclude the `ps` sampler process and degrade both endpoints to `"unavailable"` when either snapshot fails. The process-tree baseline is captured after GC, followed by another GC that clears sampler allocations before the local baseline and workload begin. Soak workloads use single-iteration batches so approximately 50 ms sampling cannot be hidden behind a large synchronous chunk. Post-teardown return fields remain `null` when GC is unavailable.

Use the `short` profile for deterministic contract and shape checks; its bounded iteration window intentionally reports `null` slopes when less than 250 ms is observed. Use `soak` for repeated sampling and slope characterization. For decision evidence:
The soak default runs each surface for at least one second and samples at approximately 50 ms intervals. `GJC_MEMORY_DURATION_MS` accepts 250–60000 ms and `GJC_MEMORY_ITERATIONS` accepts 1–10000000; record overrides with the artifact.

1. Pin the source SHA, Bun version, platform/architecture, profile, fixture inputs, and command.
2. Run at least five short repetitions and three independent soak repetitions on an otherwise idle runner.
3. Exclude warm-up from slope decisions and report the raw samples, median, p95, variance/confidence interval, peak, and post-teardown values. The runner discards the first quarter of the observed window, capped at 250 ms, before calculating a slope and requires at least 250 ms of steady-state samples.
4. Interpret heap, external/array-buffer, RSS, and process-tree evidence separately. A high post-GC RSS with a returned heap may be allocator high-water residency, not a reachability leak.
5. Do not enforce a numeric threshold until variance is characterized and recorded in the threshold ledger. A claimed optimization needs either a statistically supported improvement on the same workload or removal of a reproducible unbounded slope.
6. Treat active handles and post-teardown residue as lifecycle signals, not byte-parity proof. Behavior, transcript/blob integrity, throughput, and latency remain independent gates.

The default fixtures contain no user or provider data. Raw private transcripts remain prohibited.

## Memory retention & fail-closed materialization

Resident-memory retention (hotspots M01–M05) was bounded in Optimization Suite v3 (#548): `EphemeralBlobStore` externalizes large resident text to a session-scoped disk cache with an 8 MiB LRU buffer budget, `getEntries()`/`buildSessionContext()` are served from revision-keyed WeakRef caches and return caller-owned clones, and `captureState`/`restoreState` bump revision domains. Materialization is split by byte sensitivity:

- **Resident byte-sensitive TEXT** (`resolveTextBlobSync`) is **fail-closed**: a missing resident blob throws `ResidentBlobMissingError` rather than degrading, so a missing blob can never silently leak a `blob:sha256:` reference into provider payloads, UI, or exports.
- **Persisted images** (`resolveImageData`/`resolveImageDataUrl` and sync variants) are the **legacy persisted-image compatibility boundary**: a missing blob warns and returns the reference as-is so legacy-session resume degrades gracefully. New byte-sensitive resident data must NOT use this warn-and-return path.

This contract is locked by `packages/coding-agent/test/resident-materialization.test.ts`. Retained growth and post-GC return are measured by `packages/coding-agent/bench/session-memory.bench.ts` (emits the corpus `rssMemory` shape).

**Measured deferral:** further memory rewrites beyond these byte-parity-preserving bounds are deferred to corpus prioritization. Per [`native-ffi-optimization-policy.md`](./native-ffi-optimization-policy.md) and the byte-parity principle, speculative memory rewrites wait for profiler/RSS corpus evidence rather than being undertaken on a static-ranking guess.

## Authenticated sealed-corpus result

- Evidence status: `SUFFICIENT_EVIDENCE`
- Action decision: `ACTION`
- Action family: `sustained-heap-growth`
- Measurement head: `ae37704ea58c5181043ef2a325c3aa1878884c25`
- Admission: short 5/5, soak 24/24
- `agent-session` endpoint median: 2232879.966 B/s, BCa lower 2198738.248, Theil-Sen median 917654.71
- `tui` endpoint median: 170829.216 B/s, BCa lower 154600.451, Theil-Sen median 4391.02
- p95: `OMITTED_IMPOSSIBLE` (24 blocks insufficient for 95% empirical coverage per exact-order-statistic method)
- All five preregistered limitations preserved
- JS heap separated from process RSS/external/native; no production leak or causal site claimed
- Raw corpus retained outside git, read-only, access-restricted, hash-bound by external receipt
- Published files:
  - `artifacts/perf-corpus-memory-evidence-report.json`
  - `artifacts/perf-corpus-memory-evidence-manifest.json`
  - `artifacts/perf-corpus-memory-evidence-notebook.ipynb`
