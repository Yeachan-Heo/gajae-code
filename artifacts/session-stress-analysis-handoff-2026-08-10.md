# Long-Running Session Stress Analysis and Optimization Handoff

**Date:** 2026-08-10
**Repository:** `gajae-code`
**Worktree:** `research/stress-test`
**Evidence commit:** `3e902206b3961144980411839b4797b2cf48eb74`
**Evidence host:** Apple M5 Max, Darwin arm64, Bun 1.3.14
**Status:** Capacity and bounded-memory behavior verified through 2048 MiB. Cold first-open latency remains the main optimization target. No CPU self-time claim has been established because no profiler artifact has yet been captured.

---

## 1. Executive handoff

The stress program established that the cold-session design can resume synthetic session corpora through 2048 MiB without building a transcript-sized in-memory entry graph. Across the dense matrix, process RSS growth remained approximately flat relative to transcript size, cold entry lookup remained low-millisecond, and repeated warm lookup caused zero additional transcript range reads.

The dominant unresolved cost is **cold first-open construction**: opening a raw transcript for which no authenticated `.session-memory.spill.*` sidecar exists. The benchmark currently labels this operation “resume,” but the measured path performs semantic validation and constructs/publishes the cold-session sidecar. It must be distinguished from an exact reopen of an already-authenticated sidecar.

The strongest implementation evidence points to the following bottleneck candidates, in priority order:

1. **Frequent synchronous forced GC during both full transcript passes.** A 2048 MiB first-open with large records can request roughly 128 scanner-driven `Bun.gc(true)` calls, plus ordinal-driven forced collections in each callback.
2. **Two complete UTF-8 + `JSON.parse` passes over the entire transcript.** A 2048 MiB source therefore incurs approximately 4096 MiB of full JSON decode work before secondary validation/publication work.
3. **Non-reusable line assembly on bounded first-open.** Records crossing scanner chunks are reconstructed with `Buffer.concat`; the code already has a reusable-buffer scanner that bounded fork paths use, but first-open does not opt into it.
4. **Per-record synchronous sidecar writes.** Every cold index record is converted to a fresh buffer and written with `fs.writeSync`; large dense sessions contain roughly 8,200 records.
5. **Repeated per-record serialization, buffer creation, and SHA-256 work.** These are necessary integrity domains but currently generate avoidable intermediate objects and copies.
6. **A behavioral discontinuity at 512 MiB.** Dictionary and parent artifacts are built at or below 512 MiB and skipped above it, causing non-monotonic throughput and making aggregate “resume” timing harder to interpret.
7. **Observability conflates budget reservation with actual residency.** `totalAccountedBytes` is approximately 45 MiB per session mostly because fixed cache capacities are charged up front. Five subagent sessions report approximately 225 MiB accounted while measured process RSS growth is roughly 59 MiB.

The lookup architecture is not the current bottleneck. Typical cold p95 is approximately 1–3 ms and warm lookups add no range reads. Do not replace the dictionary/flat-index lookup system without new evidence.

---

## 2. Deliverables and evidence files

### Published report

- HTML report: `artifacts/session-stress-report-2026-08-10.html`
- PDF rendered from the same HTML: `artifacts/session-stress-report-2026-08-10.pdf`
- PDF contact sheet: `artifacts/session-stress-report-contact-sheet.png`

### Dense matrix evidence

- JSON: `artifacts/session-scenario-matrix-dense-2026-08-10.json`
- CSV: `artifacts/session-scenario-matrix-dense-2026-08-10.csv`
- SVG: `artifacts/session-scenario-matrix-dense-2026-08-10.svg`
- Benchmark source: `packages/coding-agent/bench/session-scenario-matrix.ts`

The dense sweep contains 68 isolated process runs:

- 4 scenarios
- 17 corpus sizes per scenario
- sizes: 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1280, 1536, 1792, and 2048 MiB
- payload chunk size: 256 KiB
- single-file 2048 MiB corpus: approximately 8,200 records

### Near-GiB fork evidence

- JSON: `artifacts/session-gib-stress-2026-08-10.json`
- Benchmark source: `packages/coding-agent/bench/session-gib-stress.ts`

This corpus contains three direct-fork and three captured-fork repetitions at 1023 MiB.

### Report generator

- `packages/coding-agent/bench/session-stress-report.ts`

---

## 3. Current worktree state

At handoff time, the branch contains uncommitted product and benchmark changes:

```text
 M packages/coding-agent/CHANGELOG.md
 M packages/coding-agent/src/config/settings-schema.ts
 M packages/coding-agent/src/session/session-manager.ts
 M packages/coding-agent/test/session/session-memory-integration.test.ts
 M packages/coding-agent/test/settings-session-memory.test.ts
?? packages/coding-agent/bench/session-gib-stress.ts
?? packages/coding-agent/bench/session-scenario-matrix.ts
?? packages/coding-agent/bench/session-stress-report.ts
```

Do not discard or overwrite these changes. They include:

- bounded first-open admission raised from 1 GiB to 2 GiB + 1 MiB header headroom;
- `sessionMemory.mode` default changed from `shadow` to `enabled`;
- tests for the new admission constant and default;
- dense benchmark and report-generation tools.

### Admission code

`packages/coding-agent/src/session/session-manager.ts:1878-1886`:

```ts
/** Safety bound for eager resume compatibility and managed per-file artifacts. */
export const RESUME_TRANSCRIPT_MAX_BYTES = MANAGED_ARTIFACT_MAX_FILE_BYTES;
/**
 * Explicit cold-session admission limit. Two-GiB transcripts remain streamable;
 * the extra MiB covers bounded fork header replacement without rejecting a
 * source exactly at the advertised limit.
 */
export const BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024 * 1024 + 1024 * 1024;
const EAGER_RESUME_TRANSCRIPT_MAX_BYTES = MANAGED_ARTIFACT_MAX_FILE_BYTES;
```

### Enabled default

`packages/coding-agent/src/config/settings-schema.ts:2091-2099`:

```ts
// Bounded-memory cold-session offloading. Budgets are fixed implementation
// constants in the sidecar primitives, not user-tunable fields. Enabled is
// the safe default so multi-gigabyte explicit sessions use streaming cold
// state instead of the eager 64 MiB compatibility admission path.
"sessionMemory.mode": {
    type: "enum",
    values: ["off", "shadow", "enabled"] as const,
    default: "enabled",
},
```

### Important release decision still required

The new enabled default allows normal product entry points to route large explicit sessions through bounded first-open. However, the dense matrix does not include a same-host eager/shadow versus enabled comparison for very small sessions. Before release, measure 1, 4, 16, 32, and 64 MiB startup behavior. If enabled adds unacceptable fixed latency to ordinary sessions, prefer automatic routing by transcript size rather than reverting 2048 MiB support.

---

## 4. Measurement results

### 4.1 Dense matrix headline

- Successful runs: **68/68**
- Successful 2048 MiB scenarios: **4/4**
- Maximum measured resume RSS growth: approximately **62.9 MiB**
- Maximum measured whole-process RSS: approximately **587 MiB** in the prior matrix report; note that whole-process RSS includes fixture generation and allocator high-water residency
- Warm lookup additional range reads: **0 across the entire dense matrix**
- Typical cold lookup p95: approximately **1–3 ms**
- Largest cold p95 observation: **27.49 ms**, isolated to a small multi-transcript point and not reproduced as corpus size increased

### 4.2 2048 MiB results

| Scenario | Files | Approx. entries | First-open/resume | Throughput | Resume RSS growth | Accounted state |
|---|---:|---:|---:|---:|---:|---:|
| Linear transcript, dense point | 1 | ~8,187 | 18.96 s | 108.0 MiB/s | 60.7 MiB | 45.4 MiB |
| Linear transcript, focused admission check | 1 | ~8,187 | 10.30 s | ~199 MiB/s | 61.8 MiB | 45.4 MiB |
| Goal lifecycle history | 1 | ~8,186 | 9.20 s | 222.6 MiB/s | 58.7 MiB | 45.1 MiB |
| Four transcripts | 4 | aggregate | 10.46 s | 195.9 MiB/s | 60.2 MiB | 181.2 MiB |
| Parent + four subagents | 5 | aggregate | 10.54 s | 194.3 MiB/s | 58.9 MiB | 225.6 MiB |

The 18.96-second linear value is not a stable implementation result. A focused 2048 MiB run completed in 10.30 seconds. Treat 18.96 seconds as a variance/outlier signal until repeated measurements and phase traces determine its cause.

### 4.3 Scaling interpretation

Observed first-to-last endpoints from the dense matrix:

| Scenario | 16 MiB resume | 2048 MiB resume | 16 MiB RSS growth | 2048 MiB RSS growth |
|---|---:|---:|---:|---:|
| Linear | 199 ms | 18.96 s outlier | 43.8 MiB | 60.7 MiB |
| Four transcripts | 427 ms | 10.46 s | 42.4 MiB | 60.2 MiB |
| Parent + four subagents | 240 ms | 10.54 s | 41.2 MiB | 58.9 MiB |
| Goal history | 178 ms | 9.20 s | 43.3 MiB | 58.7 MiB |

The key result is that latency scales with bytes processed while RSS does not. The sidecar architecture solves transcript-sized residency, but raw transcript conversion remains O(total bytes) with large constants.

---

## 5. What the benchmark actually measures

The dense matrix generates raw JSONL transcripts with no existing `.session-memory.spill.commit`, then calls `SessionManager.open(..., "enabled")`.

The relevant control flow is documented at `packages/coding-agent/src/session/session-manager.ts:7201-7213`:

```ts
/**
 * Bounded first-open startup for `sessionMemoryMode: "enabled"` when no valid
 * reusable commit marker exists. ... Scans the transcript in
 * bounded 64 KiB ranges (two passes max) ... builds the disposable
 * `.spill.idx`/`.spill.tail`/`.spill.commit` set ...
 */
```

`#tryBoundedFirstOpen` calls discovery and build sequentially at `session-manager.ts:7242-7248`:

```ts
const discovery = this.#scanBoundedTranscriptForFirstOpen(sessionFile, before);
if (!discovery) return false;
...
const built = this.#buildBoundedFirstOpenSidecars(sessionFile, before, discovery);
```

Therefore, matrix `resumeMs` is best named:

> **raw transcript cold first-open + sidecar construction latency**

It is not equivalent to:

- exact reopen of an existing authenticated sidecar;
- warm entry lookup;
- reopening after an append-only tail advance;
- transcript-ahead recovery;
- captured/direct fork copy time.

A follow-up benchmark must separate these operations.

---

## 6. Bottleneck analysis with code evidence

### 6.1 Bottleneck candidate A — synchronous forced GC during scans

**Confidence:** High that the calls exist and are frequent; medium-high that they materially affect latency; requires A/B and profiler evidence before claiming exact contribution.

The scanner uses a GC cadence based on bytes read. See `packages/coding-agent/src/session/session-manager.ts:1433-1445`:

```ts
useLargeRecordCadence ||= consumer.hasLargePendingLine();
const gcIntervalBytes = useLargeRecordCadence
    ? size > PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES
        ? reuseLineAssembly
            ? 60 * 1024 * 1024
            : 32 * 1024 * 1024
        : 23 * 1024 * 1024
    : 4 * 1024 * 1024;
bytesSinceGc += length;
if (bytesSinceGc >= gcIntervalBytes) {
    Bun.gc(true);
    bytesSinceGc = 0;
}
```

For a 2048 MiB transcript using the default non-reusable first-open scanner:

```text
2048 MiB / 32 MiB ≈ 64 forced synchronous GC requests per full pass
2 full passes ≈ 128 scanner-driven forced GC requests
```

The discovery callback adds another forced collection every 4096 records at `session-manager.ts:7475-7476`:

```ts
lastId = record.id;
if ((ordinal & 4095) === 0) Bun.gc(true);
```

The build callback repeats this at `session-manager.ts:7695-7697`:

```ts
ordinal++;
previousId = record.id;
if ((ordinal & 4095) === 0) Bun.gc(true);
```

With approximately 8,200 records, this adds roughly two callback-driven forced collections per pass. A 2 GiB first-open can therefore request approximately 130 synchronous collections.

#### Follow-up experiment

Add an internal benchmark-only GC strategy toggle:

- `current`: existing scanner + ordinal GC
- `none`: no explicit GC during scan
- `async`: asynchronous request where supported
- `pressure`: request only when measured heap/external growth crosses a threshold

For every mode, record:

- discovery wall clock;
- build wall clock;
- process CPU;
- peak RSS, heap, external, and array buffers;
- GC request count;
- GC total elapsed time if Bun exposes it;
- output sidecar byte parity.

Run at 512, 1024, 1536, and 2048 MiB with five repetitions.

#### Acceptance criterion

A replacement is acceptable if it reduces p50/p95 first-open latency without violating:

- exact sidecar byte/digest parity;
- 64 MiB-class RSS behavior or an explicitly approved revised threshold;
- fail-closed malformed transcript behavior;
- descriptor/identity validation.

---

### 6.2 Bottleneck candidate B — two complete JSON parse passes

**Confidence:** High structural cost; exact CPU share needs profiling.

The first semantic pass parses every line at `session-manager.ts:7367-7383`:

```ts
const scanFailure = scanTranscriptLinesBounded(
    this.storage,
    sessionFile,
    descriptor.size,
    (lineStart, lineBytes) => {
        ...
        parsed = JSON.parse(decodeBoundedJsonLine(lineBytes));
        ...
        if (!hasStrictSessionSchema([record as unknown as FileEntry])) ...
```

The second build pass parses every line again at `session-manager.ts:7576-7585`:

```ts
const scanFailure = scanTranscriptLinesBounded(
    this.storage,
    sessionFile,
    descriptor.size,
    (lineStart, lineBytes) => {
        ...
        parsed = JSON.parse(Buffer.from(lineBytes).toString("utf8"));
```

For a 2048 MiB transcript, this is approximately 4096 MiB of full UTF-8 conversion and JSON decode input, before accounting for index serialization and hashing.

The first pass needs semantic state that cannot be derived solely from offsets:

- strict record shape;
- chain continuity;
- duplicate detection;
- compaction validity;
- usage totals;
- labels;
- provider-affecting state;
- model/TTSR reducer state.

The second pass needs:

- exact offsets and lengths;
- record digests;
- base digest;
- tail records;
- index publication;
- hot suffix materialization.

#### Recommended design direction

Construct the flat index during the semantic pass rather than parsing the whole file again.

One viable staged design:

1. Open a private/unpublished temporary index writer before semantic scan.
2. For each validated record, compute digest and write its flat index record immediately.
3. Track running transcript hash and record compaction candidates by id/ordinal/offset.
4. At EOF, select the latest valid compaction boundary.
5. Perform a bounded range read only for the authenticated hot suffix and tail metadata.
6. Bind and publish the index/tail/commit only after descriptor revalidation.
7. On any failure, unlink temporary sidecars and preserve transcript authority.

This preserves the fail-closed model while replacing two complete JSON passes with one complete pass plus a small suffix pass.

#### Risks

- Latest compaction points backward to an earlier entry. The implementation must retain enough bounded metadata to locate and authenticate that boundary without holding an unbounded map.
- Duplicate detection remains required over the full chain.
- Provider state and usage totals must match eager semantics exactly.
- Publication must remain atomic and descriptor-bound.

#### Acceptance criterion

- Eager versus sidecar provider context parity unchanged.
- Existing crash/reopen/tamper tests pass.
- First-open p50 improves on 1024–2048 MiB.
- No full transcript-sized object graph or unbounded map is introduced.

---

### 6.3 Bottleneck candidate C — non-reusable line assembly

**Confidence:** High allocation/copy cost for lines crossing chunks; easy to test with an existing implementation toggle.

The default consumer stores fragments and concatenates them when a line spans scanner chunks. See `session-manager.ts:1285-1305`:

```ts
let pendingChunks: Buffer[] = [];
...
if (pendingChunks.length > 0) {
    pendingChunks.push(segment);
    line = Buffer.concat(pendingChunks, lineBytes);
}
```

A reusable consumer already exists at `session-manager.ts:1331-1388`. It grows one reusable buffer and returns a subarray:

```ts
let pendingBuffer: Buffer | undefined;
...
const assembled = ensureCapacity(lineBytes);
segment.copy(assembled, pendingBytes);
line = assembled.subarray(0, lineBytes);
```

`scanTranscriptLinesBounded` defaults `reuseLineAssembly` to false at `session-manager.ts:1392-1400`:

```ts
function scanTranscriptLinesBounded(
    ...
    reuseLineAssembly = false,
)
```

For transcripts over 512 MiB it selects 256 KiB chunks in default mode and 320 KiB chunks in reusable mode at `session-manager.ts:1401-1406`.

The bounded first-open discovery/build calls do not pass `reuseLineAssembly = true`. By contrast, bounded fork preflight and copy explicitly pass it at `session-manager.ts:16436-16495` and `16529-16555`:

```ts
scanTranscriptLinesBounded(..., preflightResult, false, true)
scanTranscriptLinesBounded(..., copyResult, false, true)
```

The dense fixture uses 256 KiB payload chunks plus JSON metadata. Many lines therefore exceed the default 256 KiB read chunk and require fragment assembly. This is close to a worst-case layout for `Buffer.concat` frequency.

#### Follow-up implementation

First make a narrowly scoped A/B benchmark by passing `false, true` to both first-open scans. Do not combine this with GC or pass-merging changes in the same benchmark commit.

#### Acceptance criterion

- Exact byte and digest parity.
- No mutation/retention of the reusable buffer after callback return.
- Lower allocation volume or wall-clock latency on 256 KiB–1 MiB line corpora.
- No regression on small-line, malformed-line, or maximum-line tests.

---

### 6.4 Bottleneck candidate D — per-record synchronous index writes

**Confidence:** High syscall/allocation count; likely secondary to parse and GC costs.

The build pass creates and writes one JSON index line per transcript record at `session-manager.ts:7624-7635`:

```ts
const indexLine = `${JSON.stringify({ ... })}\n`;
indexWriter!.writeLineSync(indexLine);
runtime.indexHash.update(Buffer.from(indexLine, "utf8"));
```

The file writer implementation at `packages/coding-agent/src/session/session-storage.ts:990-1006` performs a new UTF-8 allocation and synchronous write loop for every call:

```ts
writeLineSync(line: string): void {
    ...
    const buf = Buffer.from(line, "utf-8");
    let offset = 0;
    while (offset < buf.length) {
        const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
        ...
    }
}
```

A dense 2048 MiB single-file corpus contains approximately 8,200 entries, so the flat index alone performs approximately 8,200 `Buffer.from` conversions and at least 8,200 `fs.writeSync` calls. Tail publication adds additional writes for hot records.

Durability is then forced at `session-manager.ts:7713-7716`:

```ts
indexWriter.fsyncSync();
tailWriter.fsyncSync();
```

#### Recommended implementation

Add a bounded buffered session-storage writer for disposable sidecars:

- 64–512 KiB buffer;
- append serialized index bytes;
- flush on capacity and before fsync/close;
- update index hash from the same serialized bytes before or during buffering;
- preserve synchronous error semantics and owner-only verification.

Do not weaken the final fsync or atomic commit publication contract.

#### Acceptance criterion

- Identical index bytes and digest.
- Fewer write syscalls demonstrated by tracing or instrumentation.
- No loss of deterministic write/close failure behavior.

---

### 6.5 Bottleneck candidate E — repeated allocation and hashing per record

**Confidence:** Structurally present; exact self-time unknown.

The build pass performs all of the following per record:

- UTF-8 conversion and `JSON.parse` (`session-manager.ts:7582-7585`)
- SHA-256 record digest (`7616`)
- index object allocation and `JSON.stringify` (`7624-7633`)
- string-to-buffer conversion for index hash (`7635`)
- possible dictionary/parent record construction (`7637-7663`)
- possible tail record construction and serialization (`7674-7689`)
- base hash update (`7692-7693`)

The hashes authenticate distinct domains and should not be removed casually. The opportunity is to avoid duplicate conversions and feed one serialized buffer to both the writer and index hash.

#### Follow-up

Capture a `.cpuprofile` or Instruments Time Profiler trace for a 1024 MiB first-open. Report actual self-time for:

- `JSON.parse`
- UTF-8 conversion
- SHA-256 update/digest
- `JSON.stringify`
- `Buffer.from` / `Buffer.concat`
- `fs.readSync` / `fs.writeSync`
- GC

No hotspot should be labeled CPU-confirmed without this artifact.

---

### 6.6 Bottleneck candidate F — 512 MiB secondary-artifact discontinuity

**Confidence:** Behavior is explicit; performance impact needs toggle evidence.

Secondary dictionary and parent artifacts are limited by `session-manager.ts:1237-1239`:

```ts
const PERSISTENT_SECONDARY_ARTIFACT_MAX_RECORDS = 64 * 1024;
const PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
```

Eligibility is decided in the build pass at `session-manager.ts:7556-7558`:

```ts
let secondaryArtifactsEligible =
    descriptor.size <= PERSISTENT_SECONDARY_ARTIFACT_MAX_TRANSCRIPT_BYTES &&
    discovery.recordCount <= PERSISTENT_SECONDARY_ARTIFACT_MAX_RECORDS;
```

At or below 512 MiB, first-open can additionally build:

- dictionary partitions;
- duplicate detector state;
- parent-to-child artifact.

Above 512 MiB, these are skipped and the flat index remains authoritative. This can produce non-monotonic throughput: a somewhat larger corpus may do less secondary work per byte.

#### Follow-up

Add per-run fields:

- `dictionaryArtifactEnabled`
- `parentArtifactEnabled`
- dictionary build elapsed time
- parent artifact build elapsed time
- flat-index-only elapsed time

Benchmark feature toggles at 384, 512, and 768 MiB.

Potential product direction: publish the flat index synchronously, then build optional secondary artifacts lazily or after the session becomes interactive.

---

### 6.7 Observability issue — reservation is not residency

**Confidence:** High.

The build pass charges fixed cache capacities at `session-manager.ts:7721-7728`:

```ts
const fixedReservedBytes =
    runtime.blockCache.budgetBytes +
    runtime.entryCache.budgetBytes +
    runtime.tailCache.budgetBytes +
    REDUCER_BUDGET_BYTES +
    LABELS_PINS_BUDGET_BYTES +
    1024 * 1024;
if (!runtime.accountant.tryCharge(fixedReservedBytes + hotResidentBytes)) ...
```

This explains the approximately 45 MiB `totalAccountedBytes` for every single session, even when live cache allocation is much smaller. Four sessions report approximately 181 MiB and five sessions approximately 225 MiB, while measured process RSS growth remains approximately 59–60 MiB.

#### Recommended metric split

Expose separately:

- `reservedBudgetBytes`
- `allocatedCacheBytes`
- `hotResidentBytes`
- `metadataResidentBytes`
- `sidecarFileBytes`
- aggregate process-level session memory

Do not use `totalAccountedBytes` as if it were measured RSS or reachable heap.

---

### 6.8 Multi-session startup is sequential

**Confidence:** High from benchmark structure and API usage; optimization value requires product workload evidence.

The benchmark opens every file sequentially. Aggregate 2048 MiB four- and five-file scenarios take approximately 10.5 seconds, close to the sum of their per-file opens.

Potential approaches:

1. Lazy-open child sessions when first observed.
2. Open root immediately, then initialize children in a bounded background queue.
3. Permit concurrency 2 only under a process-level RSS/I/O admission controller.

Do not unconditionally parallelize all subagent sidecar builds. Parallel full scans can increase page-cache churn, RSS peaks, CPU contention, and thermal throttling.

---

## 7. What is not currently implicated

### 7.1 Cold lookup

Typical cold p95 is approximately 1–3 ms. Larger transcripts do not show growing per-entry lookup latency. The isolated 27.49 ms and 16.88 ms small multi-transcript observations are inconsistent with larger points and need repetition before attribution.

### 7.2 Warm lookup

Across the dense matrix, repeated lookup of the same cold ids caused zero additional range reads. The cache-resident path is functioning as intended.

### 7.3 Transcript-sized steady-state memory

RSS growth remains approximately 41–63 MiB from 16 MiB through 2048 MiB. The architecture successfully avoids transcript-size-proportional process memory on first-open.

Do not replace the cold index/cache architecture to address first-open latency. Optimize sidecar construction first.

---

## 8. Required follow-up benchmark decomposition

The current matrix needs to be split into distinct operation classes.

### Fixture A — raw cold first-open

Input: transcript with no sidecar.
Measures: discovery, sidecar build, publish, context initialization.

Required phase metrics:

- descriptor/security preflight
- semantic scan
- GC count/time during semantic scan
- index/tail build scan
- index serialization/write
- dictionary build
- parent build
- metadata delta publication
- fsync
- commit publication/classification
- hot suffix materialization

### Fixture B — exact authenticated reopen

Input: transcript plus valid sidecar from fixture A, opened in a fresh process.
Measures: commit parse, descriptor proof, hash verification, hot tail load, context build.

This is the operation most users will experience after the first large-session resume.

### Fixture C — transcript-ahead reopen

Input: valid sidecar plus bounded new transcript tail.
Measures: recovery classification and incremental reconciliation.

### Fixture D — repeated lifecycle

Open/lookup/close the same authenticated session 20–100 times in one process. Record:

- RSS, heap, external, array buffers
- active resources
- sidecar cache bytes
- post-close slopes

This distinguishes allocator high-water residency from reachable leaks.

### Fixture E — direct and captured fork

Existing near-GiB benchmark already covers these at 1023 MiB. Extend with phase timing:

- preflight scan
- copy scan
- staged writer publication
- destination first-open
- source revalidation

The bounded fork implementation itself performs at least a preflight full scan and a copy full scan (`session-manager.ts:16436-16495` and `16529-16555`), followed by destination initialization at `16579-16580`. This can imply additional destination sidecar work and should not be conflated with simple open latency.

---

## 9. Proposed implementation sequence

Each item should be a separate commit and benchmark comparison so causality is preserved.

### Change 1 — phase telemetry only

Add internal timing and counters without changing behavior.

Deliverables:

- phase wall clock
- process CPU per phase
- explicit GC request count
- bytes read/written
- records parsed
- line assembly copy count/bytes
- index write calls/bytes
- fsync elapsed time

Acceptance: byte-identical sidecars and no material timing regression.

### Change 2 — reusable first-open line assembly

Pass `reuseLineAssembly = true` to semantic and build scans.

Acceptance: all session-memory, malformed, crash, RSS, and parity tests pass; reduced line-copy allocation demonstrated.

### Change 3 — scanner GC A/B

Remove ordinal GC first, then characterize scanner cadence modes. Do not simultaneously alter parsing or writing.

Acceptance: lower median/p95 with bounded RSS and no correctness change.

### Change 4 — buffered sidecar writer

Batch flat-index and tail writes while preserving final fsync and error semantics.

Acceptance: byte parity and lower syscall count.

### Change 5 — single full semantic/index pass

This is the larger architectural optimization. Design and review its failure atomicity before implementation.

Acceptance: one full JSON pass, bounded suffix pass, exact commit parity, all hostile transcript tests pass.

### Change 6 — lazy secondary artifacts

Only after phase data proves dictionary/parent build cost is significant. Keep flat index authoritative.

### Change 7 — process-wide/lazy subagent opening

Only after first-open is optimized and aggregate product behavior is measured.

---

## 10. Verification commands

### Typecheck and focused contracts

```bash
bun --cwd=packages/coding-agent run check:types
bun test packages/coding-agent/test/settings-session-memory.test.ts \
  packages/coding-agent/test/session/session-memory-integration.test.ts \
  packages/coding-agent/test/session/session-memory-latency.test.ts
```

Last observed result:

```text
82 pass
1 skip
0 fail
641 expect() calls
```

### Dense matrix

```bash
bun packages/coding-agent/bench/session-scenario-matrix.ts \
  --out-prefix artifacts/session-scenario-matrix-dense-2026-08-10
```

### Focused 2048 MiB admission

```bash
bun packages/coding-agent/bench/session-scenario-matrix.ts \
  --sizes 2048 \
  --scenarios linear-resume,goal-history \
  --out-prefix artifacts/session-scenario-2048-admission
```

### Near-GiB direct/captured fork

```bash
bun packages/coding-agent/bench/session-gib-stress.ts \
  --iterations 3 \
  --out artifacts/session-gib-stress-2026-08-10.json
```

### Report generation

```bash
bun packages/coding-agent/bench/session-stress-report.ts \
  --matrix artifacts/session-scenario-matrix-dense-2026-08-10.json \
  --svg artifacts/session-scenario-matrix-dense-2026-08-10.svg \
  --gib artifacts/session-gib-stress-2026-08-10.json \
  --out artifacts/session-stress-report-2026-08-10.html
```

### HTML-to-PDF conversion

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --allow-file-access-from-files \
  --no-pdf-header-footer \
  --print-to-pdf="artifacts/session-stress-report-2026-08-10.pdf" \
  "file://$PWD/artifacts/session-stress-report-2026-08-10.html"
```

---

## 11. Test requirements for optimization work

Any change to scanning, GC, sidecar writing, or pass structure must cover:

1. Valid current-version linear transcript.
2. Exact 2048 MiB admission.
3. Transcript above bounded admission rejected deterministically.
4. Unterminated final line.
5. Line above `BOUNDED_FIRST_OPEN_MAX_LINE_BYTES`.
6. Duplicate id.
7. Broken parent chain.
8. Branching transcript, which currently falls back.
9. Header/entry patch transcript, which currently falls back.
10. Invalid compaction boundary.
11. Descriptor mutation during scan.
12. Sidecar writer failure.
13. Fsync failure.
14. Commit publication failure/crash window.
15. Corrupt index/tail/commit reopen.
16. Provider context parity.
17. Usage statistics parity.
18. Label/model/TTSR reducer parity.
19. Cold lookup byte parity.
20. Warm lookup zero-range-read invariant.
21. Direct and captured fork authority changes.
22. Resident memory/accounting budgets.
23. Post-close cleanup of disposable sidecar state.

Do not weaken fail-closed behavior to improve benchmarks.

---

## 12. Baseline decision log (superseded by §14)

### Supported conclusion

The system can support 2048 MiB explicit cold sessions with bounded process-memory growth and low-latency lazy lookup.

### Supported bottleneck classification

At the baseline revision, cold first-open construction was the dominant user-visible cost. That implementation performed two complete JSON parse passes and frequent synchronous GC, with additional per-record hashing/serialization/writes.

### Not yet supported at the baseline revision

- No symbol had profiler-confirmed CPU self-time at the baseline revision; §14.3 records the later profiler evidence.
- The 18.96-second linear 2048 MiB point is not established as a deterministic cliff.
- The isolated small multi-transcript lookup spikes are not established algorithmic regressions.
- High post-close RSS is not established as a leak.
- Dictionary/parent artifact construction is not established as a net loss without toggle evidence.

### Recommended immediate action

Instrument first-open phases and explicit GC counts, then run same-host A/B comparisons for:

1. reusable line assembly;
2. no ordinal forced GC;
3. scanner GC cadence modes.

These are bounded, independently testable changes with the strongest code evidence and lowest architectural risk.

---

## 13. Original handoff summary (superseded by §14)

At the baseline revision, the memory-bound cold-session architecture was fundamentally successful. The follow-up work therefore targeted the raw-transcript-to-sidecar conversion path rather than redesigning lookup or reintroducing eager transcript materialization.

The original recommended direction was to eliminate excessive synchronous GC, enable reusable line assembly, and reduce cold first-open from two complete JSON parse passes to one full semantic/index pass plus a bounded hot-suffix pass. Section 14 records the implemented result and measured evidence.

---

## 14. Implemented follow-up and measured outcome

The required optimization work is now implemented. This section supersedes the earlier "not yet supported" and "recommended immediate action" statements.

### 14.1 Product behavior

- `sessionMemory.mode` now supports `auto` and defaults to it.
- Auto mode keeps transcripts below the eager admission threshold on the eager path and routes larger transcripts to bounded cold-session state.
- Explicit `off`, `shadow`, and `enabled` behavior remains available.
- First-open now uses one full semantic transcript JSON pass plus one bounded authenticated hot-suffix range read. The previous full explicit-open inspection pass and immediate full-base post-publication reclassification pass were removed from the successful construction path.
- The private flat index remains authoritative. Dictionary and parent artifacts are disabled by default after A/B evidence showed only modest first-open/RSS savings and sub-millisecond cold-lookup cost; benchmark controls can still enable them.
- Pressure-based GC is the product default. The scanner checks both byte pressure and small-record cadence while retaining fail-closed semantics.
- Disposable index/tail output uses the bounded synchronous buffered writer. Staged fork writes no longer allocate and concatenate a duplicate line buffer.
- Process memory reporting now separates reserved budget, allocated caches, hot residency, metadata residency, and sidecar file bytes. Reserved/accounted bytes are not presented as RSS.

### 14.2 First-open telemetry

`SessionMemoryFirstOpenTelemetry` now records wall and process CPU time, GC requests/time, transcript and sidecar bytes, semantic and bounded-suffix records parsed, line-copy counts/bytes, index write calls/bytes, fsync calls/time, and stable phase evidence for:

1. descriptor/security preflight;
2. semantic scan;
3. index serialization/write;
4. bounded index/tail work;
5. dictionary and parent artifact work;
6. metadata-delta publication;
7. fsync;
8. commit publication/classification;
9. hot-suffix materialization.

### 14.3 Profiler evidence

Source-bound artifacts for commit `b41feb2ad`:

- `artifacts/profiles/session-first-open-1024-source-bound.cpuprofile`
- `artifacts/profiles/session-first-open-1024-source-bound.md.md`
- `artifacts/profiles/session-first-open-1024-source-bound-metadata.json`
- `artifacts/session-first-open-1024-source-bound-run-md.json`

Earlier exploratory profiles are not acceptance evidence. The final 1024 MiB profile is explicitly bound to source tree `db03b6e7c0eca42772332afe8ec78bf2cdacf293` and cumulative diff SHA-256 `c477d6e40799ef03ff5e3ce3361a3818d0f70978ae5736667a4e642b39504041`. It measured 953.47 ms first-open, five pressure-GC requests totaling 18.90 ms, and zero warm range reads. Self time is led by hash update (43.9%), write (10.6%), JSON stringify (6.0%), byte counting (5.6%), GC (4.4%), parse (4.0%), and read (3.9%). GC and repeated file opening are no longer the dominant costs; hashing and index serialization/write are the remaining optimization surface.

### 14.4 Same-host A/B evidence

Every artifact in this subsection records `gitSha: b41feb2ad1934a6958e4429102b92132005333cf`.

#### GC strategy

`artifacts/session-gc-{current,none,async,pressure}-source-bound-2026-08-10.{json,csv,svg}`:

| Size | Strategy | First-open p50 | Operation RSS p50 |
|---:|---|---:|---:|
|128 MiB|current|258.9 ms|98.4 MiB|
|128 MiB|none|167.1 ms|93.6 MiB|
|128 MiB|async|177.0 ms|86.5 MiB|
|128 MiB|pressure|181.0 ms|88.2 MiB|
|512 MiB|current|643.3 ms|99.7 MiB|
|512 MiB|none|492.5 ms|88.0 MiB|
|512 MiB|async|508.1 ms|88.0 MiB|
|512 MiB|pressure|518.9 ms|96.2 MiB|

`none` is fastest in the isolated matrix, but it failed two opt-in RSS cases under the full product lifecycle: the 60k first-build fixture exceeded its 64 MiB RSS ceiling at 122,748,928 bytes, and the million-record fixture exceeded the 128 MiB allocator ceiling at 135,643,136 bytes. Pressure mode passed all 13 RSS cases and remains the product default. The benchmark-only `none`, `async`, and `current` controls remain available for causal experiments.

#### Secondary artifacts

`artifacts/session-secondary-{current,off,lazy}-source-bound-2026-08-10.{json,csv,svg}`:

Disabling synchronous dictionary/parent construction saved about 53–56 ms at 384/512 MiB and about 5 ms at 768 MiB. Median cold lookup remained between 0.8 and 1.1 ms. This supports keeping the flat index authoritative and secondary artifacts disabled by default across both first-open and later rebuilds; it does not justify background publication complexity as a product default.

#### Multi-session opening

`artifacts/session-subagent-{sequential,concurrency2}-source-bound-2026-08-10.{json,csv,svg}` measured three isolated 512 MiB aggregate subagent-tree samples:

- sequential p50: 625.4 ms, 72.5 MiB operation RSS;
- concurrency two p50: 614.4 ms, 80.2 MiB operation RSS.

Concurrency improved latency by only 11.0 ms (1.8%) while increasing RSS by 7.7 MiB. Product opening remains sequential; the matrix retains `--open-concurrency` as an evidence control only.

#### Automatic routing

`artifacts/session-small-auto-source-bound-2026-08-10.{json,csv,svg}` covered 1/4/16/32/64 MiB with three isolated samples per mode. Auto p50 remained below off-mode p50 at every size because auto avoids the redundant full strict-inspection pass even when it selects eager state. At 64 MiB, auto p50 was 95.00 ms versus 182.64 ms off. `artifacts/session-auto-threshold-source-bound-2026-08-10.{json,csv,svg}` confirms bounded routing at 128 MiB.

### 14.5 Full-size result

`artifacts/session-2gib-first-open-source-bound-2026-08-10.{json,csv,svg}` contains three fresh, uncontended 2048 MiB raw cold-first-open samples with auto routing, pressure GC, and default-disabled secondary artifacts:

- p50: 1,839.2 ms;
- p95/max: 1,842.6 ms;
- p50 throughput: 1,113.5 MiB/s;
- operation RSS p50/max: 96.2/96.7 MiB;
- cold lookup required one bounded range read;
- warm lookup required zero range reads.

The full direct/captured fork corpus in `artifacts/session-gib-stress-source-bound-2026-08-10.json` is bound to the same source. Direct fork p50/p95 was 2,203.7/2,245.4 ms at 88.9/89.1 MiB RSS; captured fork p50/p95 was 2,240.8/2,259.0 ms at 85.6/86.2 MiB RSS. These results are below the accepted four-second fork and 8.2-second first-open budgets.

### 14.6 Memory and verification acceptance

Live bounded session state remains under the 64 MiB accountant budget. Bun/macOS allocator high-water RSS is separately bounded by a 128 MiB process envelope for large first-open/fork operations. Split metrics are recomputed from live cache, tail, provider-state, and reducer state rather than stale transition snapshots.

`artifacts/session-source-bound-verification-receipt.json` binds the final verification to commit `b41feb2ad`: 227 focused tests passed with one intentional default-off latency skip, the explicit opt-in latency/I-O gate passed all 14 assertions, all 13 opt-in RSS tests passed, all seven mandatory computer-enforcement adversarial cases passed, package typecheck passed, schema synchronization passed, and the partial source-bound report rendered successfully.

### 14.7 Review-closed safety behavior and rejected follow-ups

- Bounded first-open publishers use an owner-bound exclusive build lock; a second opener waits for and adopts the authenticated winner rather than writing shared final paths concurrently.
- Physical scanner rejection (unterminated input, oversized line, missing parent, or descriptor mutation) suppresses later eager sidecar reconstruction for that lifecycle.
- Post-admission sidecar tamper on a transcript above the eager ceiling fails closed with a rebuild-required error rather than hydrating the entire transcript.
- Secondary artifacts stay disabled across later sidecar rebuilds unless explicitly enabled.
- Dictionary adoption requires exact equality between the committed dictionary header and the authoritative transcript session ID.
- Disabled secondary rebuilds delete prior dictionary partitions/meta and parent buckets before recomputing sidecar disk accounting.
- Full-hot-view operations apply the eager-size ceiling before allocating or scanning the complete private index, including a structurally valid commit-rebound tamper case.
- Tail-empty dictionary-disabled sessions preserve a validated `nextOrdinal`; all append paths use cold-aware ID generation, collision-cache saturation is released before publication, and fallback exact lookup never allocates the complete index entry array.
- Missing report dimensions, failed runs, and unrun fork modes remain unavailable/N/A rather than becoming zero-valued or cross-operation evidence.
- No product-default multi-session parallel opening: measured latency gain was negligible and RSS increased.
- No background dictionary/parent publication: measured savings do not justify new marker replacement complexity.
- No unbounded ID map or transcript-sized entry graph: exact compaction authority remains the private flat index plus a bounded target lookup and suffix read.
