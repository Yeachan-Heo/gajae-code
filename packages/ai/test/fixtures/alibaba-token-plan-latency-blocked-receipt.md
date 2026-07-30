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

## What was validated (synthetic loopback smoke test)

This harness is a **synthetic loopback smoke test**, not a production-fidelity
benchmark. It constructs raw `fetch` requests against an in-process local HTTP
server (not the production OpenAI SDK request shape), so it validates the
measurement machinery and the per-arm header-transport logic — it does **not**
measure the real Gajae-Code vs Alibaba request fingerprint or establish
production latency impact. Production fingerprint parity is proven separately by
the wire-capture unit tests
(`packages/ai/test/alibaba-token-plan-headers.test.ts`), which exercise the
real SDK fetch path.

The harness proves: it captures TTFT, total latency, success/error/timeout
counts; it interleaves with a fixed seed; it excludes warmups; and it
partitions captures per A/B arm with an **exact per-capture** wire check (every
B capture carries all four canonical values; every A capture lacks all three
DashScope-specific headers). Local-server numbers reflect only raw-transport
overhead and are **not** representative of real Alibaba endpoint latency.


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
