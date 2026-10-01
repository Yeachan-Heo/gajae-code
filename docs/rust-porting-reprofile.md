# Rust porting Phase 4 re-profile

This is the post-vendoring CPU profile that the Rust porting plan's Phase 4 requires. It was produced by the session-replay harness (`bun run bench:profile -- --scenario all`) on the dedicated `macos-14` runner (`native-bench-ab.yml`, suite `profile-stability`). The runner waited for the 1-minute load to settle below half the cores and ran one warm-up profile before the measured runs. Raw profiles stay in the workflow artifacts; only aggregated function names and shares are recorded here.

- Run: https://github.com/Yeachan-Heo/gajae-code/actions/runs/36502046414
- Git SHA: `1011a4aedecaab7aa0913b1d84fb00172b2e5a61` (post-vendoring dev), Bun `1.4.0`, host `darwin/arm64`, sampling interval 100 µs
- Corpus manifest SHA-256: `4e6f50a2485350fffeca7c7addf3b946830e96da7b80cdcec0c1f24d9791a108`, the same corpus as the Phase 1a baseline (`docs/rust-porting-baseline.md`)
- Stability: every scenario had ≥8/10 top-10 overlap between the two measured runs (AC1a.3)

## TypeScript functions at ≥5% self time

| Scenario | Function | Share | Decision |
|---|---|---:|---|
| compaction | anonymous closure in `registrySelectorResolvesToModel` — `packages/coding-agent/src/config/model-registry.ts:789` | 41.6% | Fixed in TypeScript (#6125); not a port candidate |
| replay | same closure | 24.4% | same |

After #6125, the passing profile-stability run (https://github.com/Yeachan-Heo/gajae-code/actions/runs/36694983955, dev `929e0fb367`, all seven scenarios >=8/10 overlap) shows 0% in both scenarios; the earlier run 36548743458 failed its stability comparison and is provisional only. It also shows two remaining compaction functions over the threshold:

| Scenario | Function | Share | Decision |
|---|---|---:|---|
| compaction | `serializeCanonicalJson` — `packages/coding-agent/src/config/model-preset-registry.ts:668` | 7.8% | Pure-TS fix, 32% faster with byte-identical output (#6127); Rust port rejected |
| compaction | `getQualifiedNamespaceSuffixes` — `packages/coding-agent/src/config/model-equivalence.ts:364` | 5.2% | Rust port rejected (napi overhead per short-string candidate) |

startup, session-save, tools and keystroke have no TypeScript function at ≥5%. Their top self time is runtime and native: module resolution, `spawnSync`, file I/O and the xterm test terminal. Session-load has two TypeScript functions over the threshold (see Critical paths below).

## Critical paths

| Window | Top self time |
|---|---|
| per keystroke | `match` (regex, runtime) 91–100%, `nativeKeys` 8.6% |
| per token delta | `structuredClone` 6.8–7.0%, `managedChargeStringBytes` 3.1–3.7%, `stringify` 5.1–6.1% (profiled across all 19,719/26,292 per-token windows) |
| session-load | `openSync`, `entries`, `writeFileSync`, `materializeResidentValueSync` 10.8%, `measureJsonLikeBytes` 6.8% |

None of the Phase 1a hand-port candidates (E-H*, E-M*, E-TUI-*) reaches 5% self time in any scenario or leads a critical path (except E-M01, where per-token attribution is measured below the threshold: `managedChargeStringBytes` 3.1–3.7%; see E-M01 note below). Each is recorded as `rejected` or `unconfirmed` in `docs/rust-porting-inventory.md`. The five functions that crossed 5% or showed significant critical-path presence are the rows E-P4-REGISTRY-SELECTOR, E-P4-CANONICAL-JSON, E-P4-NAMESPACE-SUFFIXES, E-P4-MATERIALIZE-RESIDENT, and E-P4-MEASURE-JSON-LIKE. None was hand-ported: in each case the cost is TypeScript work over JS objects or strings, where a napi boundary adds per-call overhead or the function is a utility that enables higher-level TypeScript optimizations.
