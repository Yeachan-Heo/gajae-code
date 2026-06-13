# ADR: Native FFI Optimization Policy

- Status: Accepted
- Scope: `crates/pi-natives` algorithmic ports proposed for performance reasons
- Related: [`porting-to-natives.md`](./porting-to-natives.md), [`natives-architecture.md`](./natives-architecture.md), [`natives-binding-contract.md`](./natives-binding-contract.md), [`cpu-hotspot-map.json`](./cpu-hotspot-map.json), [`hotspot-map-successor.md`](./hotspot-map-successor.md)

## Decision

A new native (Rust N-API / FFI) port proposed **to optimize a leftover hot path** does not land unless **all** of the following gates pass:

1. **Corpus evidence** — a profiling-corpus trace shows the path has user-visible latency or RSS impact on a representative workload (not just a static complexity argument).
2. **Self-time attribution** — a `profilerSelfTime` artifact identifies the proposed hotspot, **or** fallback-toggle evidence proves an end-to-end benefit without byte changes. Wall-clock proxy timing alone is never sufficient.
3. **Measured FFI overhead** — the N-API call/marshalling overhead is measured against the JS/TS baseline, not assumed away.
4. **Representative win** — a representative p50/p95 win exists on realistic inputs, not only microbenchmark seed results.
5. **Byte parity** — a byte-identical corpus covers rendered, persisted, and provider-visible bytes for the changed path.
6. **Operational cost** — fallback, packaging, and rollback costs are documented.

This policy governs **speculative algorithmic ports**. It does **not** re-litigate already-native platform/system surfaces (see [Scope boundary](#scope-boundary)).

## Context

The CPU/memory hotspot program (Optimization Suites v1–v3, tracked in [`cpu-hotspot-map.json`](./cpu-hotspot-map.json)) is closed out. Its prioritization was a **static structural ranking** (algorithmic complexity × trigger frequency), and the map's own `method` field records that real CPU self-time was "to be measured by the agreed profiling corpus during optimization." That corpus is being built separately; until its evidence exists, new native ports for leftover hotspots would repeat the same evidence gap.

The suites already produced concrete decisions that this policy codifies so they are not re-discovered:

- **v2 (#530)** measured and **rejected the five remaining Rust port candidates** per the FFI cost gates after shipping only `diffLines` (H03) natively. Native overhead did not beat the JS/TS baseline for those candidates on realistic inputs.
- **v3 (#558) rejected a native word-diff (H04)** "without a fresh FFI gate" — the TS fast paths were retained instead; a native port would need to re-clear gates 1–6 above.
- **Hunt-Szymanski LCS (H05)** was implemented as a native/algorithmic replacement, then **reverted** because it produced byte-different rendered diffs (reproduced by red-team). Byte parity is the gate, not raw speed.
- **The custom JSON length counter (H08)** was implemented, made exact, then **deleted** — an exact JS reimplementation was not faster than native `JSON.stringify`. "More native" is not automatically "faster."

These four precedents share a root cause: a plausible algorithmic/native win that failed a real gate (cost, byte parity, or end-to-end benefit). The policy makes those gates a precondition rather than a post-hoc discovery.

## Evidence taxonomy

Native-port claims must classify their evidence using the same separated classes as the profiling corpus. These classes must never be conflated:

- **`wallClockPhase`** — elapsed timing around a phase or operation. Useful for perceived-latency and regression detection; **insufficient** to confirm CPU self-time or to justify a port on its own.
- **`processCpuUsage`** — `process.cpuUsage()` user/system deltas, optionally normalized by elapsed time. Indicates process-level CPU pressure; **cannot** attribute self-time to a specific hotspot.
- **`profilerSelfTime`** — profiler (or equivalent sampled/trace) attribution of self-time to a function, module, or native symbol. **Required** before a hotspot may be called "CPU-self-time confirmed."

A native-optimization proposal that cites only `wallClockPhase` or `processCpuUsage` is **not** CPU-self-time confirmed and does not clear gate 2.

## Approval checklist

Before opening a native-optimization PR, confirm and attach evidence for each:

- [ ] Corpus trace shows user-visible latency or RSS impact for the path (gate 1).
- [ ] `profilerSelfTime` artifact identifies the hotspot, **or** fallback-toggle before/after evidence proves end-to-end benefit without byte changes (gate 2).
- [ ] FFI/marshalling overhead measured vs the JS/TS baseline in the same benchmark run (gate 3).
- [ ] Representative p50/p95 win on realistic inputs, not only seeded microbench results (gate 4).
- [ ] Byte-identical corpus covers rendered, persisted, and provider-visible bytes (gate 5).
- [ ] Fallback, packaging (platform variants / embedded addon), and rollback costs documented (gate 6).

If any box is unchecked, keep the work in TypeScript or hold it as a tracked candidate; do not switch callsites. This mirrors the existing **Rule of thumb** in [`porting-to-natives.md`](./porting-to-natives.md): if native is not faster *and* behavior-compatible, do not switch callsites.

## Scope boundary

This policy targets **speculative algorithmic ports**, not the established native surface. The following are **already native** by design and are explicitly out of scope (see `alreadyNativeExcluded` in [`cpu-hotspot-map.json`](./cpu-hotspot-map.json)):

`grep`, `fd`/`glob`, text width/wrap/truncate/slice, syntax highlighting, HTML→Markdown, token counting, AST, summary, process/PTY/shell, SIXEL, clipboard, `Bun.hash.xxHash32/64`, and `JSON.parse`/`JSON.stringify`.

These are native because they are I/O, OS/process integration, or platform primitives — the criteria in [`porting-to-natives.md`](./porting-to-natives.md#when-to-port). Distinguishing them from algorithmic ports matters: a leftover algorithmic hotspot must clear gates 1–6, whereas adding a new OS/process/native-primitive binding follows the standard porting guide.

## Consequences

- New native algorithmic ports require profiling-corpus evidence and a measured cost gate before review; this slows speculative optimization but prevents byte-parity regressions and dead native code.
- The default answer for a leftover hotspot is "keep it in TypeScript" until the corpus proves it matters.
- Already-native platform/system primitives and new OS/process bindings are unaffected; they follow [`porting-to-natives.md`](./porting-to-natives.md) as before.
- Reviewers can reject a native-optimization PR purely on a missing gate, citing this ADR, without re-deriving the rationale.

## Follow-ups

- Held native candidates (H04 word-diff, H05 LCS, and other v2-rejected candidates) stay held unless a future PR clears gates 1–6 with fresh corpus evidence.
- When the profiling corpus lands, link its threshold/evidence ledger here so native-port proposals can cite concrete corpus artifacts.
