# Multi-session host — Phase A measurement harness (RFC #6247)

Phase A of [Discussion #6247](https://github.com/Yeachan-Heo/gajae-code/discussions/6247) asks one question before any production refactor is admitted: **does running sessions as Bun Workers inside one host process materially reduce memory compared with one OS process per session, at acceptable cost?**

This document describes the bench-only harness under `packages/coding-agent/bench/multisession/` that answers it. Nothing under `packages/*/src`, `crates/`, or `scripts/` is changed. The harness does not change how `gjc` runs sessions.

## Result: stop at Phase A (memory)

The gated runs used commit `f6edcaa5ac` with contract digest `678a6887…9334`. They ran on macOS 26.5.1, an Apple M5 Max, and Bun 1.4.0 in its default config.

At N=5 there were 5 of 5 valid repetitions per arm. The Worker arm's gated steady mean is 1907.0 MB, against 1896.6 MB for standalone. The gate requires the Worker to be at most 50%; it is about 100.5%. The sampled peak also regresses by 5.6%.

Each added session costs about 300 MB in both arms, because every Worker carries its own heap and module graph.

Gate by gate:

- **Memory:** fails (above).
- **Cold readiness:** fails, 1236 ms against 1007 ms.
- **Churn:** insufficient evidence. The Worker host crashed in cycle 4 with the Bun 1.4.0 `Worker`-thread `EXC_BREAKPOINT`.
- **Latency, throughput, lag, teardown, orphans:** pass.

Per the stop rule, Phases B–E are not admitted. Full results and disclosures: [discussion comment](https://github.com/Yeachan-Heo/gajae-code/discussions/6247#discussioncomment-18744865).

**Known harness limitation: the fidelity gate is uninformative.** Two repetitions of the same arm differ at the same rate as standalone does against Worker. The reason is that the workload's async `task` completion notice can land before or after the next prompt.

A future run needs a deterministic notice point, or a same-arm control that sets the noise floor. Without one of these, the fidelity gate cannot distinguish Worker effects from noise.

## Measurement boundary

The two arms run identical work. The only difference between them is process vs Worker isolation.

| Arm | Topology |
|---|---|
| standalone | N `runner-process.ts` processes, one session each |
| worker | one `worker-host.ts` process holding N Workers (`worker-entry.ts`), one session each |

Both arms run the same `session-runner.ts`, `bootstrap.ts` manifest, `workload.ts` script, `mock-provider.ts` provider, and tools (bash, read, grep, task, compaction) through the real `createAgentSession` path.

**Neither arm runs behind the SDK Broker.**
- The Broker's existing `BrokerSettings.spawnSubstrateProvider` seam serves only master-mode `session.spawn` (`src/sdk/broker/broker.ts` `#driveSpawn`).
- Ordinary `session.create` launches a dedicated `session-host-internal` process (`src/sdk/broker/lifecycle.ts`).
- That process binds its lifecycle authority to its own pid and OS incarnation (`src/commands/sdk.ts`).
- So N Workers in one host cannot sit behind the unchanged Broker. Making that possible is RFC Phase D (items 19–21).
- Instead, one idle Broker is measured on its own (`broker-baseline.ts`, value **B**). B is added **once to each** arm total, because production keeps one Broker in front of either model.

**Consequences:**
- A passing result shows that the isolation model saves memory. It does **not** show that the Broker can route sessions into a Worker host.
- The verdict carries a capability label. It reads `full-capability` only when `characterize.ts` shows that the runner's normalized evidence equals the real Broker `session.create` path. Otherwise it reads `isolation-model opportunity evidence`.
- **Observed characterization (macOS arm64, Bun 1.4.0).** The real Broker `session.create` path completes the streaming, bash/read/grep, and `task` turns of the same workload. To get that far, the host needs the runner's active tool surface (`tools.essentialOverride`), because product tool discovery hides `task`. It also needs a compaction threshold above the host's full product prompt; that is why `thresholdTokens` is 16384. The host then rejects the compaction-sized turn. Its pre-prompt auto-compaction opens an `auto-compaction` session transition, which invalidates the prompt's admission generation. The prompt then fails after 30 s with `Timed out waiting for prior agent run to finish before prompting.` The in-process runner submits that same turn with `skipCompactionCheck` and compacts after it. The SDK `turn.prompt` path does not expose that option. `characterize()` therefore returns `unavailable` with that observed cause (taken from the isolated host log), and the verdict label is `isolation-model opportunity evidence`. Fixing the host path is out of scope for Phase A, which makes no `src/` changes.
- `bootstrap.ts` lists by name every service that differs from `session-host-internal` (`excludedServices`).

## Accounting

**Metric.** macOS `phys_footprint` via `proc_pid_rusage(RUSAGE_INFO_V4)` (`footprint.ts`). RSS is reported alongside but never gates.
- Each read is bracketed by process-incarnation observations.
- A changed identity is `raced`. A failed read is `unresolved`. Neither is ever treated as zero.

**Cohort (`cohort.ts`).**
- Each arm root blocks on a stdin `ack` until the driver has registered its pid and incarnation (`channel.ts`).
- Ownership comes from an inherited `GJC_BENCH_COHORT` env token, read for every same-user process via `KERN_PROCARGS2`. The Darwin unique-id ancestry tracker is secondary evidence.
- XNU redacts the environment of many same-user processes (platform binaries such as `/bin/sh`, `sleep`), so most of them are `argv-only`. For these, ownership is settled from the original-parent chain (`PROC_PIDUNIQIDENTIFIERINFO` `p_puniqueid`, which survives reparenting to launchd). The process is owned if the chain reaches the driver, a root, or a tracked descendant. It is excluded if the chain reaches launchd or a live pre-run process. A process that started before the run is also excluded.
- A process whose ownership still cannot be proven (for example, its original parent already exited) is `unresolved-ownership` and makes the sample incomplete. A process that the OS confirms has exited before its footprint read holds no memory, so it contributes nothing either way. An identity that first reads as unknown is re-read once after 20 ms, so a process caught mid-exit is not mistaken for a live unresolved one. The final orphan check counts only processes still alive, and its receipt records whether the process enumeration itself completed.

**Totals.** `gatedTotal = Σ owned phys_footprint (driver counted once) + B`.

**Eligibility (zero tolerance).**
- A sample is complete only when every member read and every ownership decision resolved.
- A rep is valid only when every scheduled 1 Hz tick in its gated window, its post-close teardown sample, and its marker visibility self-check are complete.
- The steady-state (gated) window runs from 2 s after the last session is ready until the first session starts disposing. It includes the scripted idle between workload phases: mock-provider turns finish in milliseconds, so a 1 Hz sampler cannot isolate them.
- If an arm has fewer than 5 valid reps, the verdict is `insufficient-evidence`, never pass.
- B is eligible only from at least 5 complete 30-sample (1 Hz × 30 s) repetitions; shortened `--seconds` baselines are diagnostic only.
- Churn is eligible only when all 20 Worker cycles finish with no session failure and every post-close sample is complete.
- An orphan receipt whose process enumeration or ownership scan failed is incomplete, which makes the orphan gate `insufficient-evidence`. A surviving process whose identity cannot be read, or whose ownership cannot be proven, is an unresolved orphan and fails the gate.
- `--report` refuses to combine run directories whose `environment.json` pins differ (source SHA, dirty flag, workload/bootstrap digest, Bun, macOS, CPU, contract digest).
- When every gate passes, the verdict is `pass` only if characterization is `equal`. Otherwise it is `pass (isolation-model opportunity evidence only)`, per `capabilityLabelRule.claimRule`.

## Gates

The gates are pre-registered in `bench/multisession/preregistration.json`. `contract.ts` computes the contract digest, and the run guard refuses preflight and Worker runs until that digest matches the comment posted to #6247.

| Gate | Threshold |
|---|---|
| Memory at N=5 | worker `gatedTotal` steady-state mean ≤ 50% of standalone; sampled peak not higher |
| Turn latency | p95 ≤ +10% |
| Throughput | ≥ −10% |
| Event-loop lag | max-over-threads p95 ≤ 50 ms; each sample is how late a 100 ms timer tick fired relative to the previous tick (`lag.ts`) |
| Cold readiness | median not slower (Worker arm includes host spawn; warm admission reported separately) |
| Teardown | host footprint 10 s after the 5th close ≤ B × 1.15 |
| Churn | 20 create×5/close×5 cycles on one resident host; cycle 20 ≤ cycle 1 × 1.10 |
| Orphans | zero owned or unresolved processes after shutdown, both arms |
| Fidelity | every Worker session's normalized transcript / request / tool / event evidence equals the same (N, rep, session) standalone session; a missing counterpart is a difference (`normalize.ts`) |

**Deviation from RFC A.3:** both arms use the default Bun configuration. `--smol` is not measured.

**Platform:** macOS arm64 only. Linux PSS is follow-up work.

## Preflight

`preflight.ts` runs two Workers in one host on the shortened native-backed script: bash, grep, then one model turn the mock provider holds in flight for 4 s. Session 1 starts once session 0 has streamed text and then pays a Worker cold start (~1 s), so its in-flight turn begins about 1 s after session 0's. Session 0 then disposes while session 1's in-flight turn is still running. The close barrier is judged from recorded evidence, not a sampled flag: some session 1 `turn` interval must span from session 0's `disposing` phase until its Worker termination is confirmed. The interval is checked after session 0 has been closed and session 1 has completed. The preflight passes only if all of these hold:
- The close barrier holds.
- Worker 1 completes.
- Both evidence sets equal a standalone run of the same script.
- The host pid and incarnation are unchanged.
- No owned process remains.

If the preflight fails, the verdict is **stop at Phase A (infeasible without Phase B)**. No production code is changed to make it pass.

Known process-global risks it exercises:
- the native crash hooks (`crates/pi-natives/src/crash.rs`, `packages/natives/native/index.js`);
- the process-cwd WeakRef in `src/session/session-manager.ts`.
- **Observed during harness bring-up (Bun 1.4.0+34cbb9a40, macOS arm64):** the Worker host crashed twice in about 20 Worker-arm smoke runs (N=2). Both crashes were `EXC_BREAKPOINT` (a runtime trap) on a thread named `Worker`, with identical faulting offsets, about 0.3 s after host launch (`~/Library/Logs/DiagnosticReports/bun.exe-*.ips`). The driver sees `root … exited with code 137 before session 0 completed` and marks the rep invalid, so the crash can produce `insufficient-evidence` but never a pass. Phase A run records keep these failures and do not retry them away.

## Inventory: Broker `session.create` surface vs. what Phase A touches

The table maps entrypoint × transport × lifecycle outcome to the existing coverage that pins today's behavior. Phase A changes none of these paths. A future Worker host would have to preserve every row.

| Entrypoint | Transport | Lifecycle outcome | Existing coverage |
|---|---|---|---|
| SDK client | Broker WebSocket | hello / dispatch / typed errors | `test/sdk-client.test.ts`, `test/sdk-client-dispatch.test.ts`, `test/sdk-broker-transport.test.ts` |
| ACP (production path) | Broker adapter | session.list / create routing | `test/sdk-acp-production-path.test.ts`, `test/sdk-acp-two-client-race.test.ts` |
| `gjc sdk session` CLI | Broker | close, scope, wait budget | `test/sdk-session-cli-close.test.ts`, `test/sdk-session-cli-wait-budget.test.ts`, `test/sdk-session-cli-list-scope.test.ts` |
| Broker `session.create` | child `session-host-internal` | ready / ready-then-exit / startup diagnostics | `test/sdk-broker-lifecycle-e2e.test.ts`, `test/sdk-lifecycle-ready-then-exit.test.ts`, `test/sdk-session-readiness-lifecycle.test.ts` |
| Broker `session.close` | lifecycle ledger | idempotent close, replay across host generations | `test/sdk-session-close-idempotency-regression.test.ts`, `test/sdk-lifecycle-idempotency-restart.test.ts` |
| Session host | endpoint | idle reap, first-attach grace | `test/sdk-session-host-idle-reap.test.ts` |
| Session host | streamed turns | turn frames, steer replay | `test/sdk-host-turn-streaming.test.ts`, `test/sdk-host-steer-integration.test.ts` |
| Broker process | detached | reparenting out of the spawner tree, cleanup markers | `test/sdk-broker-reparent-process.test.ts`, `test/sdk-broker-lifecycle-cleanup.test.ts` |
| `createAgentSession` | in-process | storage isolation per agentDir | `test/sdk-session-isolation.test.ts` |

The Worker arm adds two behaviors that no existing test covered. Phase A adds characterization tests for both:
- **Session fidelity under a Worker isolate:** normalized evidence equality, in `test/bench-multisession-runner.test.ts` and `test/bench-multisession-normalize.test.ts`. The normalizer replaces each run root in two spellings: absolute and home-abbreviated (`~/…`). The per-turn reminder renders the cwd home-abbreviated, so without the second spelling, a run under the home directory differs only by its arm directory name. The first gated preflight (at `2fa4bdd2be`) failed `fidelity` on exactly this, before the fix. The fix is a harness defect, not a Worker difference, and that attempt's artifacts are kept with the results.
- **Closing one session while a sibling in the same host has an in-flight model turn** (request issued, mock response delayed 4 s, interval spanning session 0's `disposing` through its confirmed Worker termination `closedAt`; delta streaming during closure is not measured): `test/bench-multisession-preflight.test.ts` covers the decision logic, and `preflight.ts` exercises it live.

## Worker policy exception (decision C5)

AGENTS.md normally requires every Worker to use the compile-safe hybrid constructor **and** to be registered as an extra compile entrypoint.

`worker-host.ts` follows the hybrid constructor but is **deliberately not registered** in `packages/coding-agent/scripts/compile-args.ts`. This harness is a source-only experiment, and registering it would ship benchmark code in the `gjc` binary.

Revisit this exception if a bench Worker ever needs to run from a compiled binary.

## Reproducing

Run from the repository root on macOS arm64, with a clean tree:

```sh
bun test packages/coding-agent/test/bench-multisession-*.test.ts

# 1. Broker baseline (B)
bun packages/coding-agent/bench/multisession/run.ts --arm broker --reps 5
# 2. Standalone arm + churn
bun packages/coding-agent/bench/multisession/run.ts --arm standalone --n 1,3,5 --reps 5 --churn 20
# 3. Preflight (requires the posted pre-registration receipt)
bun packages/coding-agent/bench/multisession/run.ts --arm preflight
# 4. Worker arm (requires receipt + passing, current preflight)
bun packages/coding-agent/bench/multisession/run.ts --arm worker --n 1,3,5 --reps 5 --churn 20
# 5. Non-gating real-provider sanity (both arms, N=3, your default configured model;
#    records "skipped" when no model or credentials resolve; same admission as step 4)
bun packages/coding-agent/bench/multisession/run.ts --sanity
# 6. Characterization against the real Broker session.create path
bun packages/coding-agent/bench/multisession/run.ts --characterize
# 7. Report (sanity-*.json files are deliberately excluded)
bun packages/coding-agent/bench/multisession/run.ts --report artifacts/multisession
```

Raw samples, environment pins (git SHA, Bun version, macOS build, CPU), and `preflight.json` are written under the gitignored `artifacts/multisession/`. Arguments and admission are checked before anything is written. A malformed argument or refused admission exits 1 with one `multisession:` line and creates no run directory.

## Rollback

There is nothing to roll back. The harness is bench-only and never loaded by `gjc`.
