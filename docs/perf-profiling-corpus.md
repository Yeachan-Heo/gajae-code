# Perf profiling corpus

The profiling corpus is the **successor** to the static [`cpu-hotspot-map.json`](./cpu-hotspot-map.json) ranking (see [`hotspot-map-successor.md`](./hotspot-map-successor.md)). The static map ranked hotspots by complexity × trigger frequency but never measured real CPU self-time. The corpus replaces that guess with measured, separated evidence and is the source of future perf prioritization.

Implementation:

- Schema + evidence taxonomy + validation: `packages/coding-agent/bench/perf-corpus-schema.ts`
- Runner: `packages/coding-agent/bench/perf-corpus.bench.ts`
- Threshold/evidence ledger: `packages/coding-agent/bench/perf-threshold.ledger.ts`
- Tests: `packages/coding-agent/test/perf-corpus.test.ts`

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

## Schema (gjc.perf-corpus/1)

`PerfCorpusReport` keeps the evidence classes as **separate named fields** per fixture:

- `wallClockPhase: Record<string, { elapsedMs, p50Ms?, p95Ms?, advisoryOnly }>`
- `processCpuUsage: Record<string, { userMicros, systemMicros, elapsedMs, cpuFraction? }>`
- `profilerSelfTime: { profiler, artifactPath?, samples? }`
- `rssMemory: { baselineBytes, peakBytes?, growthBytes, returnBytes, ... }`
- `byteParity: { renderedGolden?, persistedJsonlGolden?, providerPayloadGolden?, materializedSessionGolden? }`

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

## Memory retention & fail-closed materialization

Resident-memory retention (hotspots M01–M05) was bounded in Optimization Suite v3 (#548): `EphemeralBlobStore` externalizes large resident text to a session-scoped disk cache with an 8 MiB LRU buffer budget, `getEntries()`/`buildSessionContext()` are served from revision-keyed WeakRef caches and return caller-owned clones, and `captureState`/`restoreState` bump revision domains. Materialization is split by byte sensitivity:

- **Resident byte-sensitive TEXT** (`resolveTextBlobSync`) is **fail-closed**: a missing resident blob throws `ResidentBlobMissingError` rather than degrading, so a missing blob can never silently leak a `blob:sha256:` reference into provider payloads, UI, or exports.
- **Persisted images** (`resolveImageData`/`resolveImageDataUrl` and sync variants) are the **legacy persisted-image compatibility boundary**: a missing blob warns and returns the reference as-is so legacy-session resume degrades gracefully. New byte-sensitive resident data must NOT use this warn-and-return path.

This contract is locked by `packages/coding-agent/test/resident-materialization.test.ts`. Retained growth and post-GC return are measured by `packages/coding-agent/bench/session-memory.bench.ts` (emits the corpus `rssMemory` shape).

**Measured deferral:** further memory rewrites beyond these byte-parity-preserving bounds are deferred to corpus prioritization. Per [`native-ffi-optimization-policy.md`](./native-ffi-optimization-policy.md) and the byte-parity principle, speculative memory rewrites wait for profiler/RSS corpus evidence rather than being undertaken on a static-ranking guess.
