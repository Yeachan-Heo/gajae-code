# Issue #5770 — Codex-style code-mode evaluation

**Status:** Evaluation not run; protocol and blocker recorded. No code-mode product implementation is proposed by this document.

**Reviewed:** 2026-09-23
**Base:** `dev` at `1431b449495be731d44aa6ee21092aee45f88b82`

## Decision requested before live runs

Authorize one non-GPT model route and a bounded inference budget:

1. **First-party Anthropic route (recommended):** provide or enable an Anthropic credential for `anthropic/claude-sonnet-5` (or name an approved equivalent) and authorize the pilot cap below. This gives the clearest provider identity, but requires access and may incur API charges.
2. **Configured custom non-GPT route:** explicitly authorize a named custom endpoint/model after confirming its operator, model identity, and terms, and authorize the same cap. This is faster if already approved, but results apply only to that route and cannot establish general Anthropic behavior.
3. **GPT-only feasibility check:** narrow the evaluation to `openai/gpt-5.4`. This avoids the missing non-GPT route, but does not answer the cross-provider question and cannot justify a global default or `CodeModeOnly` decision.

The requested pilot is at most **48 sessions** (6 tasks × 2 arms × 2 models × 2 repetitions), with at most 4 model requests and 512 generated tokens per request. Do not start paid or third-party inference until the non-GPT route and budget are authorized. If option 3 is selected, report it as a scoped feasibility check, not completion of the issue's cross-provider gate.

## Existing-state evidence

- The issue is open and proposes measurement before implementation; its body explicitly says the measurements decide the design. Its only comment is the owner's filing/credit note. The issue has no linked PR or cross-reference event.
- The checked open PRs contain no PR linked to #5770 and no title/body matching Codex-style code mode. The current `origin/dev` source has no `CodeModeOnly`, `CODE_MODE`, or code-mode executor implementation. It does already carry the OpenAI Responses custom Lark-grammar path used by `apply_patch`; that is transport precedent, not a tool-calling code mode.
- `packages/orchestration-token-benchmark` currently describes itself as having no live-model calls. Its `bench:live` runner compares two prebuilt binaries' fixture reports; it does not send model requests or compare direct tool calls with an exec tool.
- No direct Anthropic account is configured (`gjc accounts check anthropic --json` returned no checks). The available custom non-GPT configuration reports `unknown` and `unsupported API-key probe`; its endpoint identity and authorization are not established here. No local inference listener was reachable at the standard Ollama, LM Studio, vLLM, SGLang, or oMLX ports. No model requests were made and no numeric results are claimed.

These conditions prevent a reproducible two-provider measurement in this session. The configured custom route is deliberately not used without owner authorization; the existing offline fixture runner cannot substitute for live model evidence.

## Pre-registered pilot

### Models and arms

Use exact, non-aliased model/provider identifiers and record the resolved model revision and API transport on every run:

- GPT arm candidate: `openai/gpt-5.4` over OpenAI Responses, provided the run verifies the catalog capability and service route still permit the custom Lark grammar.
- Non-GPT arm candidate: `anthropic/claude-sonnet-5` over Anthropic Messages, or the exact owner-authorized replacement. This arm uses a normal function schema containing one `program: string` argument because the provider does not expose OpenAI's custom grammar tool type.

Run both arms for each model:

- **Direct:** expose the same read-only `find`, `search`, and `read` APIs as ordinary function tools.
- **Code mode:** expose one `exec` tool whose description lists those exact APIs. The GPT arm sends a Lark grammar via the existing custom-tool transport. The non-GPT arm sends a plain string function argument, then validates it against the same restricted grammar locally. A malformed program is a failed attempt; do not repair it or fall back to direct tools.

The prototype executor is evaluation-only: parse a straight-line sequence of named API calls and references to earlier results. Permit no shell, filesystem writes, network, dynamic imports, arbitrary JavaScript evaluation, loops, or tools outside the read-only allowlist. Both arms use the same underlying fixture-backed API implementations and output limits.

### Task set

Pin the fixture corpus to the reviewed `dev` commit and keep expected answers outside the model prompt. Use six read-only repository investigation tasks with deterministic graders:

1. Find the declaration of `customFormat` and report its supported transport contract.
2. Trace how the OpenAI Responses provider selects and serializes a grammar-constrained tool.
3. Locate the model capability flag and identify which model/provider metadata controls the freeform path.
4. Compare internal and wire-level tool names and cite where dispatch accepts each.
5. Find the existing freeform `apply_patch` tests that distinguish a custom grammar tool from a function tool.
6. Summarize which provider families ignore the custom-format field and cite the type contract.

Each expected answer must contain the required facts and file evidence. The grader must reject unsupported claims and missing citations. Freeze task text, fixture hashes, expected answers, and the grader before the first model call.

### Controls and metrics

- Use fresh conversations for every repetition. Pair runs by model/task/repetition and randomize arm order. Keep system/task wording, reasoning setting, temperature, tool API behavior, and output limits fixed within each model pair. Record prompt-cache usage separately.
- No retries for malformed programs or task failures. Record provider/network failures separately; exclude them from quality scoring only under a predeclared transport-failure rule and report the denominator.
- **Input tokens:** sum provider-reported input tokens across all model requests in a session, including tool schemas and tool results. Preserve cached/uncached usage separately; never substitute local estimates for missing provider usage.
- **Turns:** count model API requests/assistant responses. Also report tool invocations separately so one `exec` call is not confused with the number of underlying API operations.
- **Wall clock:** monotonic elapsed time from the first request start through final answer, including provider latency and tool execution. Report per-run values and median by model/arm; do not infer provider-only latency.
- **Task success:** deterministic grader outcome per attempt. Report successful attempts divided by all eligible attempts, plus exact failure reasons. No self-reported model success counts.
- Record provider/model revision, API, capability/grammar mode, source commit, task/grader hashes, request usage, timings, tool calls, failures, and run order in a machine-readable report. Do not store credentials or authorization headers.

### Decision rule

Keep the result descriptive; this pilot is not a statistically powered product-quality claim.

- Consider `CodeModeOnly` only if code mode has no task-success or safety regression for either model and reduces input tokens or model turns without a material median wall-clock regression.
- If the non-GPT code-mode arm has lower task success than its direct arm, do not make code mode a default. Any follow-up implementation must be provider-gated and preserve direct exposure for that provider.
- If results are mixed, usage data is missing, the model revision cannot be pinned, or the task set fails its own grader checks, make no product decision and extend the evaluation before implementation.

## Results

**Not run.** No per-arm token, turn, wall-clock, or success measurements are available. This is a specification and blocker record, not a benchmark result.

## Exit criteria for the evaluation

1. Owner authorizes a reproducible non-GPT route and the bounded usage cap.
2. The benchmark harness and pinned fixture/grader are independently reviewed before model calls.
3. Both model arms complete the same task/repetition matrix with auditable raw usage/timing records.
4. Publish the measurements, failures, limitations, and recommendation before any product implementation decision.
