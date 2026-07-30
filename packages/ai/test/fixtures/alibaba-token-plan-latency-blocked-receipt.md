# Alibaba Token Plan Header-Parity A/B — Blocked Live-Data Receipt

**Issue:** gajae-code #3557
**Harness:** `packages/ai/scripts/alibaba-token-plan-latency-ab.ts`
**Date:** 2026-07-30

## Status: BLOCKED (no live credentials)

A live Alibaba Token Plan A/B benchmark could not be run during this lane
because **no `ALIBABA_TOKEN_PLAN_API_KEY` is present** in this host's process
or login environment, and there is no Alibaba entry in `~/.gjc/agent/models.yml`.

Per the issue's latency-analysis requirements, live results were **not
fabricated**. The harness is landed and validated against a deterministic local
server so it is reproducible the moment credentials become available.

## What was validated (local deterministic server)

The harness was validated end-to-end against an in-process local HTTP server
that emits a fixed-size SSE stream. This proves the measurement machinery
correctly captures TTFT, total latency, success/error/timeout counts, and
partitions the wire captures per A/B arm. Local-server numbers reflect only
transport/header overhead — they are **not** representative of real Alibaba
endpoint latency and are included solely as a smoke test of the harness.

Representative local run (`--n 15 --warmup 3 --seed 42`):

```
A (legacy/mismatched): n=15 success=15 err=0 to=0
  TTFT  median≈0.7ms  total median≈14.2ms
B (Qwen-identical):   n=15 success=15 err=0 to=0
  TTFT  median≈0.6ms  total median≈13.5ms
Wire: arm-B canonical headers PRESENT ✓ | arm-A DashScope headers absent ✓
```

These local numbers are intentionally **not** reported as the issue's latency
results. They only demonstrate the harness runs, interleaves with a fixed seed,
excludes warmups, and verifies the per-arm wire fingerprint.

## Reproducing the harness

```sh
bun --cwd=packages/ai scripts/alibaba-token-plan-latency-ab.ts --n 30 --warmup 5 --seed 42
```

Options: `--n` (samples/arm), `--warmup` (excluded warmups/arm), `--seed`
(interleave RNG seed), `--port` (local server port, 0 = ephemeral).

The harness prints a JSON stats object to stdout and a human summary to stderr.
No tokens, prompts, or private response bodies are printed; `Authorization` is
captured only as `Bearer <redacted>`.

## Running a bounded live A/B when credentials are available

When a valid `ALIBABA_TOKEN_PLAN_API_KEY` is provisioned through the normal GJC
auth store, run the same harness pointed at the real endpoint. The harness must
be extended to target `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
with the live key; keep endpoint/model/prompt/body/process/connection policy
identical across arms and interleave with the fixed seed. **Never print the
token, the prompt, or private response bodies.** Compare `Authorization` by
presence/scheme only.

## Why local-only for now

- No credential in env or GJC auth store → any live number would be fabricated.
- The local server proves the harness is deterministic and correct.
- The canonical header set itself is proven by the wire-capture unit tests
  (`packages/ai/test/alibaba-token-plan-headers.test.ts`), not by latency.
