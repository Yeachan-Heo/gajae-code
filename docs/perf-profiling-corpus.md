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

## Schema (`gjc.perf-corpus/3`)

`PerfCorpusReport` keeps the evidence classes as **separate named fields** per fixture:

- `wallClockPhase: Record<string, { elapsedMs, p50Ms?, p95Ms?, advisoryOnly }>`
- `processCpuUsage: Record<string, { userMicros, systemMicros, elapsedMs, cpuFraction? }>`
- `profilerSelfTime: { profiler, artifactPath?, samples? }`
- `rssMemory: { baselineBytes, peakBytes?, growthBytes, returnBytes, ... }`
- `byteParity: { renderedGolden?, persistedJsonlGolden?, providerPayloadGolden?, materializedSessionGolden? }`
- `memoryBaseline?: { surface, profile, ordinal, childPid, parentPid, captureSemanticsId, iterations, operations, operationsPerSecond, periodicSamples, observedExtrema, sampling, postTeardown, rssSlopeBytesPerSecond, heapSlopeBytesPerSecond, processTreeBaselineRssBytes, processTreePostTeardownRssBytes, processTreeSampler }`
- `runner` records command/argv, sanitized environment controls, platform/architecture, profile targets, requested surface order, process isolation, and parent/child GC flags together with complete runtime provenance: `runtimeCommand`, `runtimeControlIdentity`, `closureDigest`, `closureManifest`, `bunVersion`, `bunExecutable`, and `worktreeFingerprint`.
- `gitSha` is the full checked-out measurement commit. Capture fails closed when Git checkout provenance is unavailable; `gitDirty` and the before/after worktree fingerprint prevent changed source from being presented as clean evidence.

V3 structurally separates chronological `periodicSamples` from `observedExtrema`. The latter contains exactly `rssBytes`, `heapUsedBytes`, `externalBytes`, and `arrayBuffersBytes`, each as `{ valueBytes, elapsedMs }`; equal values retain the earliest observation. Baseline and periodic observations can update both structures, but throttled or forced high-water observations update extrema only. `postTeardown` belongs to neither structure. Repository and replay slopes are derived only from chronological post-warm-up periodic samples; RSS peak and growth use only the RSS observed extremum.

An observed extremum is a sampled maximum, not a true process peak. The sampling metadata exposes cadence, missed deadlines, throttled callbacks, and forced probes, but scheduler delay and uninstrumented transients can still hide a higher value. Historical v1/v2 reports retain their original semantics and are never converted to, or pooled with, v3 evidence.

`hotspotClassifications: HotspotClassification[]` carry `{ hotspotId, status, evidenceClass, artifactRefs, notes }`. The current v1–v3 reclassification lives in `V1_V3_RECLASSIFICATION`; no entry is `CPU-self-time confirmed` because no profiler artifacts have been captured yet.

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

# Emit one 30000 ms soak report for an admitted measurement slot
GJC_MEMORY_PROFILE=soak GJC_MEMORY_DURATION_MS=30000 bun --smol --expose-gc packages/coding-agent/bench/perf-corpus.bench.ts
```

## Profiler-artifact expectations

The base runner attaches no profiler (`profilerSelfTime.profiler: "none"`), so it can never promote a hotspot to `CPU-self-time confirmed`. To confirm CPU self-time:

1. Capture a profiler artifact (e.g. a `.cpuprofile`) while running the relevant fixture.
2. Record it in the fixture's `profilerSelfTime` as `{ profiler, artifactPath, samples }`.
3. Set the hotspot classification to `CPU-self-time confirmed` with `evidenceClass: "profiler-self-time"` and the artifact in `artifactRefs`.
4. `validatePerfCorpusReport()` will then accept the claim.

## Threshold-promotion process

Wall-clock and RSS thresholds are noisy. Promotion is gradual:

1. **Advisory** — reported in the corpus JSON / console; never fails CI. All thresholds start here (`APPLIED_PERF_THRESHOLDS`, `advisoryOrEnforced: "advisory"`, `varianceCharacterized: false`).
2. **Opt-in numeric** — exercised under `PI_TUI_PERF_GATES=1` (see `packages/tui/test/perf-gates.test.ts`).
3. **Enforced** — a hard CI gate, allowed only with `varianceCharacterized: true`, passed before/after `benchmarkEvidence`, and human approval. `validatePerfThresholdLedger()` rejects enforced thresholds lacking this evidence.

Held thresholds (`HELD_PERF_THRESHOLDS`) name candidates that need variance characterization before enforcement.

## Memory baseline protocol

Detailed memory fixtures cover seven explicit surfaces: CLI startup/configuration, AgentSession message/context lifecycle, blob/external buffers, worker generations, Telegram reconnect/queue settlement, TUI render/dispose churn, and shared/native transfer boundaries. `agent-session` and `tui` use the named production-backed lifecycle adapters; the other five surfaces are descriptive proxies. None of these measurements alone proves a production leak, causal effect, memory budget, or authorized optimization.

Every command-line report runs one fresh Bun subprocess per surface and records `runner.memoryIsolation: "process-per-surface"`. The requested and actual order, ordinal, one common parent PID, and distinct child PID identify each surface process. The stable `captureSemanticsId` is `gjc.memory-baseline.capture/3`; in particular, TUI forced sampling occurs immediately after each render and before disposal. Programmatic `runPerfCorpusBenchmark()` defaults to in-process fixtures for focused contract use; pass `{ isolatedMemory: true }` for measurement-equivalent process isolation. Process-tree RSS snapshots exclude the `ps` sampler process and degrade both endpoints to `"unavailable"` when either snapshot fails.

The frozen measurement design is:

1. Admit exactly 5 independent short reports from at most 7 attempts and exactly 24 independent `30000` ms soak reports from at most 30 attempts. Invalid attempts consume their cap, remain immutable, and are replaced only in the same preallocated slot. Reaching a cap without the target count yields `INSUFFICIENT_EVIDENCE`, descriptive output, and no action.
2. Use seed `0x3279B4E7` for a deterministic, preallocated schedule that interleaves short attempts through the soak sequence. The first 21 admitted soak slots use three complete cyclic/Latin seven-surface blocks; slots 22–24 use the three frozen residual rows and disclose their imbalance. Replacement attempts reuse the slot's surface order.
3. Treat one report launch as the independent block and its seven surfaces as correlated outcomes. Do not pool short with soak, v1/v2 with v3, surfaces, platforms, or source heads. Reports run sequentially in the global preregistered short/soak interleave on one pinned host. Intervals may not overlap, every launch after the first starts at least 60 seconds after the prior launch ends, and AC power, fixed power mode, host identity, telemetry, interruption state, and parent/child process closure must remain within the frozen controls.
4. Soak periodic observations target 50 ms monotonic deadlines without fabricated backfill; short observations occur at iteration boundaries. Baseline and the final loop-completion periodic observation delimit slope data. High-water callbacks are at most once per 10 ms during soak unless forced, update extrema only, and never enter `periodicSamples`.
5. Calculate repository endpoint and Theil–Sen sensitivity slopes from post-warm-up `periodicSamples` only. The predeclared, non-confirmatory all-members follow-up screen is limited to endpoint heap-used slopes for `agent-session` and `tui`. Every other metric or surface, teardown delta, observed growth, throughput, process-tree result, and drift/order/time/telemetry sensitivity is descriptive.
6. Report median, MAD, IQR, min/max, every run-level point, and descriptive order, time, host-telemetry, and drift diagnostics. Do not exclude an attempt because it is slow, large, an outlier, or disagrees with a sensitivity estimator.

The default fixtures contain no user or provider data. Raw private transcripts remain prohibited.

## Measurement provenance and trusted offline replay

Fresh reports are captured from one clean immutable `measurementHead`; the later evidence-only `publicationHead` is a different identity and must never be substituted into raw report provenance. Each report binds the full measurement SHA, closure digest and path manifest, exact per-report runtime-control identity, Bun version and executable, worktree fingerprint, actual surface order and ordinals, parent/child PIDs, and capture-semantics identifier. Analysis fails closed on a dirty or moved tree, mismatched closure or toolchain, missing/duplicate surface, changed order, or invalid process identity.

The raw input directory is a flat, immutable, read-only set with no symlinks or unexpected entries. In addition to the ordered report JSON files, it contains exactly:

- `perf-corpus-attempt-ledger.json` (`gjc.perf-corpus-attempt-ledger/1`, version `1`): an exact-key, canonical-JSON-sealed object binding capture ID; M and measurement tree; C; worktree fingerprint; capture runtime-control identity; schedule/protocol digests; sealed timestamp; fixed opaque host ID/platform/architecture/AC power/power mode; and every attempt in global chronological order. Each exact-key attempt records allocation and admission slot, expected and actual seven-surface orders, interval and prior cooldown, sequential/interruption/process-closure flags, host/power identity, before/after supported telemetry with timestamps, report filename/size/SHA-256, and matching M/tree/C/fingerprint plus its per-report runtime-control identity.
- `perf-corpus-raw-manifest.json` (`gjc.perf-corpus-raw-manifest/1`, version `1`): an exact-key, canonical-JSON-sealed object binding the same capture, M/tree/C/fingerprint/capture-control/schedule/protocol identities, the exact ledger filename/size/SHA-256, and one ordered exact filename/size/SHA-256 entry for every ledger attempt report. `complete=true` and the shared sealed timestamp are mandatory.

The externally authenticated notebook input contract is exact and outcome-independent: `GJC_PERF_CORPUS_EXPECTED_GIT_SHA`, `GJC_PERF_CORPUS_EXPECTED_TREE_SHA`, `GJC_PERF_CORPUS_EXPECTED_CLOSURE_DIGEST`, `GJC_PERF_CORPUS_EXPECTED_WORKTREE_FINGERPRINT`, `GJC_PERF_CORPUS_EXPECTED_RUNTIME_CONTROL_IDENTITY`, `GJC_PERF_CORPUS_EXPECTED_CAPTURE_ID`, `GJC_PERF_CORPUS_EXPECTED_SCHEDULE_DIGEST`, `GJC_PERF_CORPUS_EXPECTED_PROTOCOL_DIGEST`, `GJC_PERF_CORPUS_ATTEMPT_LEDGER_SHA256`, and `GJC_PERF_CORPUS_RAW_MANIFEST_SHA256`, in addition to the authenticated driver/preregistration/template digests and immutable-mount attestation. All bindings are checked before report admission. The canonical JSON and terminal notebook receipt retain both sealed-file digests, every ordered raw report hash, and an admitted-report traceability row containing ledger sequence, attempt, admission slot, profile, filename, and SHA-256.

Telemetry uses exact `{ availability, value }` records with the explicit `supported`/`unavailable` taxonomy. This protocol requires supported nominal thermal state, normal memory pressure, bounded one-minute load and free memory before and after each launch. Missing/unavailable controls, critical state, host or power drift, overlap, cooldown under 60 seconds, documented interruption, or a surviving parent/child process invalidates the sealed input before outcomes are parsed. Invalid report structure may consume a frozen attempt and use only its preallocated replacement; the sealed schedule, caps, and slot row never change.

The committed evidence manifest records the measurement head, closure/protocol/trusted-code digests, bundle content digest, and static receipt-discovery rules. Post-publication values do not self-reference committed bytes: an external signed required-check receipt binds the measurement and publication heads, committed report/manifest hashes, immutable bundle hash and object identity, access/expiry, workflow identity, and signature. Publication requires downloading the referenced bundle and re-verifying its size, hash, access, and retention.

Offline replay uses independently reviewed driver and notebook-template digests frozen in a pre-outcome external receipt. Before analysis and again before replay, it verifies those exact code and environment digests plus the authenticated ledger/raw-manifest bytes, report provenance and raw hashes, process identity, capture semantics, and recursive exact-key/type/privacy allowlists. Raw inputs are mounted data-only, read-only, and no-exec; parsing is bounded and allowlisted; provider/private/transcript/secret/credential/token fields are rejected outside the fixed negative privacy attestation. Execution uses a sanitized environment, dedicated output directory, disabled network, and a fresh output-free template. Replay must reproduce the canonical tables, summary, figures, ordered report hashes, and admission traceability without modifying raw evidence.

Claim-bearing output omits p95. With 24 independent blocks there is no finite two-sided distribution-free exact 95% upper endpoint for a population p95, so the trusted notebook emits only a deterministic method/impossibility receipt for that endpoint. Tail description is limited to every individual point, min/max, and the sampling and sample-size limitations; a tail claim requires a separately preregistered larger study.

## Memory retention & fail-closed materialization

Resident-memory retention (hotspots M01–M05) was bounded in Optimization Suite v3 (#548): `EphemeralBlobStore` externalizes large resident text to a session-scoped disk cache with an 8 MiB LRU buffer budget, `getEntries()`/`buildSessionContext()` are served from revision-keyed WeakRef caches and return caller-owned clones, and `captureState`/`restoreState` bump revision domains. Materialization is split by byte sensitivity:

- **Resident byte-sensitive TEXT** (`resolveTextBlobSync`) is **fail-closed**: a missing resident blob throws `ResidentBlobMissingError` rather than degrading, so a missing blob can never silently leak a `blob:sha256:` reference into provider payloads, UI, or exports.
- **Persisted images** (`resolveImageData`/`resolveImageDataUrl` and sync variants) are the **legacy persisted-image compatibility boundary**: a missing blob warns and returns the reference as-is so legacy-session resume degrades gracefully. New byte-sensitive resident data must NOT use this warn-and-return path.

This contract is locked by `packages/coding-agent/test/resident-materialization.test.ts`. Retained growth and post-GC return are measured by `packages/coding-agent/bench/session-memory.bench.ts` (emits the corpus `rssMemory` shape).

**Measured deferral:** further memory rewrites beyond these byte-parity-preserving bounds are deferred to corpus prioritization. Per [`native-ffi-optimization-policy.md`](./native-ffi-optimization-policy.md) and the byte-parity principle, speculative memory rewrites wait for profiler/RSS corpus evidence rather than being undertaken on a static-ranking guess.
