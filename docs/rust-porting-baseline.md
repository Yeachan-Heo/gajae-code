# Rust porting profiling baseline

Baseline CPU profile for the Rust porting inventory (Phase 1a). Produced by the session-replay harness (`bun run bench:profile -- --scenario all`, see `docs/perf-profiling-corpus.md`). Raw `.cpuprofile` and report files stay under the gitignored `.gjc/profiles/`; only aggregated function names and shares are recorded here. No transcript text is included.

- Git SHA: `d84ec8697170486d822e17c064be15804857df3c`
- Bun: `1.4.0`, host `darwin/arm64`, sampling interval 100 µs
- Corpus manifest SHA-256: `4e6f50a2485350fffeca7c7addf3b946830e96da7b80cdcec0c1f24d9791a108` (sanitizer version 1; three `sanitized-real` sessions and one `synthetic` stress session)
- Replay fidelity: every session replayed with equal assistant-turn counts, equal tool-call sequence hashes, and a non-empty final frame (real-compaction-01 48/48, real-long-01 51/51, real-tools-01 24/24, synthetic-stress-01 20/20).

## Hot TypeScript functions (≥5% self time)

| Scenario | Function | Share |
|---|---|---:|
| tools | `push` — `packages/coding-agent/src/session/streaming-output.ts:1052` | 13.6% |
| compaction | `serializeCanonicalJson` — `packages/coding-agent/src/config/model-preset-registry.ts:668` | 7.3% |
| startup | `recordResolution` — `scripts/trace-loader.ts:113` (harness trace loader, excluded) | 9.3% |

session-load, session-save, replay and keystroke have no single TypeScript function at ≥5%; their top self time is runtime/native (`spawnSync`, `structuredClone`, xterm parse).

## Critical paths

| Window | Top self time |
|---|---|
| startup | `scanImports` 21.6%, `readFileSync` 17.0% (module loading) |
| per keystroke | xterm `parse` 10.6% (test terminal), `matchesKey` 8.4%, `TUI#doRender` 6.9%, `structuredClone` 3.9%, `TUI#renderPreparedFrame` 3.8%, `parseKey` 3.4% |
| per token delta | `structuredClone` 11.6%, `managedChargeStringBytes` (`packages/agent/src/agent-loop.ts:1574`) 7.9%, `spawnSync` 4.8%, `stableStreamingEditArgsVersion` (`agent-session.ts:2297`) 4.0%, `validatePersistedUsageTotals` (`session-manager.ts:6653`) 3.4%, `walkPrepared` (`agent-loop.ts:1627`) 3.4% |

## Hand-port candidates for Phase 4

Confirmed by this baseline: `streaming-output.ts` `push` (tools), `serializeCanonicalJson` (compaction), and `managedChargeStringBytes` (per-token critical path). The remaining `docs/cpu-hotspot-map.json` entries are unconfirmed at this baseline. Phase 4 re-profiles on the post-vendoring build with the same corpus manifest hash before choosing hand-ports.

## Stability

AC1a.3 passes on the dedicated `macos-14` runner (`native-bench-ab.yml`, suite `profile-stability`, run https://github.com/Yeachan-Heo/gajae-code/actions/runs/36502046414 on dev `1011a4aede`). The job waits for the post-build load to settle below half the cores (1-minute load 1.36 before, 1.45 after), runs one warm-up profile, then two measured `--scenario all` runs compared with `--compare`:

| Scenario | Top-10 overlap |
|---|---:|
| compaction | 8/10 |
| keystroke | 9/10 |
| replay | 9/10 |
| session-load | 10/10 |
| session-save | 9/10 |
| startup | 10/10 |
| tools | 8/10 |

Earlier local runs fell short because of host load and three harness defects, fixed before this run:
- `bench:profile` never exited after the tools scenario: a leaked shell session held the event loop open (#6073).
- Self time credited each sample with the whole gap since the previous one, so idle waits (child processes, I/O) made the last sampled frame look hot. Credit is now capped at ten sampling intervals. On-CPU work, including long synchronous native calls, keeps being sampled at the configured interval (#6092).
- Startup children were sampled at 1 ms with 5 repeats. They now use the harness interval with 60 repeats, and the I/O-bound tools scenario runs for 45 s (#6092, #6103).
