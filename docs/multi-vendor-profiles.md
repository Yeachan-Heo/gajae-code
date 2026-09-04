# Choosing models in GJC: role-based profiles

A practical guide to picking models for GJC's roles, for every subscription situation — one vendor, two vendors, or the full multi-vendor set. It adds curated cross-vendor `profiles:` for `~/.gjc/agent/models.yml` and verified selector notes on top of the mechanism in [Model profiles](./models.md#model-profiles---mpreset). Everything here is **user config**; it complements the built-in `--mpreset` presets and overrides a built-in only when it shares its exact name.

> Selectors, prices, and "axis leaders" are catalog- and time-sensitive (selectors and prices observed 2026-07 on the current bundled catalog; the measured latency and single-message-limit notes below were observed 2026-06 on `claude-opus-4-8` and have not been re-measured on `claude-opus-5`). Re-verify any selector with `gjc -p --no-session --no-tools --model <selector> "Reply OK"`.

## The five roles

`default` runs the main loop and most turns; `executor` / `architect` / `planner` / `critic` are the four bundled task agents, delegated only when the work calls for it.

| Role | What it optimizes for |
| --- | --- |
| `default` | tool-calling reliability + honesty (it routes — its quality bounds the whole system) |
| `executor` | real coding (SWE-bench Verified) |
| `planner` | reasoning + sequencing (GPQA / ARC-AGI-2) |
| `architect` | large-context + multimodal review |
| `critic` | independent adversarial review (different family from what it reviews) |

## Pick by what you subscribe to

| You have | Use |
| --- | --- |
| **One vendor** | the built-in preset for that vendor — `claude-opus` (Anthropic), `codex-{eco,medium,pro}` (OpenAI/Codex), `opencodego` (OpenCode Go), or a single-vendor flagship tier (`zai/glm-5.2`, `kimi-code/...`, `xiaomi/...`, `xai/grok-4.3`, `minimax-code/...`). These already map all five roles inside one vendor. |
| **Claude + Codex** | the built-in `opus-codex` (Claude main loop + Codex support roles). |
| **Three or more / all five** | the cross-vendor profiles below — each role on its axis leader, `critic` kept cross-family. |

The single guiding rule across all of these: **keep `default` on the strongest router you have** (Anthropic Opus when available). A weak `default` caps quality regardless of the delegated models.

## Cross-vendor profiles (3+ vendors)

No single vendor leads every axis, so these put each role on its axis leader and keep `critic` on a different family from the `executor` it reviews.

```yaml
profiles:

  daily:                 # everyday balance
    required_providers: [anthropic, openai-codex, google-antigravity, xai]
    model_mapping:
      default:   anthropic/claude-opus-5:medium
      executor:  openai-codex/gpt-5.4:high
      planner:   google-antigravity/gemini-3.1-pro-low:high
      architect: google-antigravity/gemini-3.1-pro-low:high
      critic:    xai/grok-4.3:medium

  ultimate:              # cost-no-object, best per role
    required_providers: [anthropic, openai-codex, google-antigravity, xai]
    model_mapping:
      default:   anthropic/claude-opus-5:high
      executor:  anthropic/claude-opus-5:max
      planner:   openai-codex/gpt-5.5:xhigh
      architect: google-antigravity/gemini-3.1-pro-low:high
      critic:    xai/grok-4.3:high

  eco:                   # cheapest delegated work; main loop stays on Opus
    required_providers: [anthropic, opencode-go, google-antigravity, xai]
    model_mapping:
      default:   anthropic/claude-opus-5:low
      executor:  opencode-go/deepseek-v4-flash
      planner:   xai/grok-4-1-fast:high
      architect: google-antigravity/gemini-3.1-pro-low
      critic:    google-antigravity/gemini-3.5-flash

  monorepo:              # huge codebases (openai-codex excluded: 372k context cap)
    required_providers: [anthropic, google-antigravity, opencode-go]
    model_mapping:
      default:   anthropic/claude-opus-5:medium
      executor:  anthropic/claude-opus-5:high
      planner:   google-antigravity/gemini-3.1-pro-low:high
      architect: anthropic/claude-opus-5:high
      critic:    opencode-go/glm-5.2

  reviewer:              # review/audit stance — the author-mode role split, inverted
    required_providers: [anthropic, openai-codex, google-antigravity]
    model_mapping:
      default:   anthropic/claude-opus-5:high                 # aggregator restraint: preserve raw reviewer verdicts
      executor:  openai-codex/gpt-5.5:high                      # support — repro PoCs, failing tests, harnesses
      planner:   google-antigravity/gemini-3.1-pro-low:high     # review checklists / audit scoping
      architect: anthropic/claude-opus-5:high                 # lead 1 — primary code-review judge (effective long-context)
      critic:    openai-codex/gpt-5.5:high                      # lead 2 — merge gate, cross-family vs Claude-authored code
```

## Reviewer stance and the external review gate

The profiles above assume an **authoring** stance: `executor` is the lead and `architect`/`critic` verify its work. In a session whose primary job is reviewing or auditing (not writing) code, the roles invert — `architect`/`critic` become the leads and `executor` is support (reproduction PoCs, failing tests). The `reviewer` profile encodes that inversion, with one generalized provenance rule: **the reviewing model family must differ from the family that authored the code under review**, not merely from the session's own executor.

A verified use is the cross-session final review gate: the authoring session launches a fresh, stateless reviewer sub-session so the finished diff is judged without the authoring context:

```sh
# the one-shot gate needs only a cross-family --model; add --mpreset reviewer as an
# optional enhancement AFTER installing this profile in ~/.gjc/agent/models.yml:
gjc -p --no-session --model openai-codex/gpt-5.5:xhigh --tools read,search,find "<review prompt: diff + spec paths, severity findings, final line VERDICT: APPROVE|REQUEST_CHANGES>"
```

The `--tools` allowlist is part of the contract: it enforces the reviewer's read-only boundary for the built-in tool surface instead of trusting the prompt (the runtime still injects the session `goal` tool unless `goal.enabled` is off — disabling it for the reviewer invocation is **mandatory**, via a dedicated gate directory outside the repo so the reviewed checkout stays clean, see the template — plus `generate_image` when an image credential exists). In this one-shot form the session's `default` model authors the verdict — a tool-restricted print session cannot delegate to the profile's `critic`/`architect` roles — so the explicit cross-family `--model` carries provenance, and the `reviewer` profile itself serves the interactive review-session case (activate it with `--mpreset reviewer` only after copying it into `models.yml`; otherwise activation fails with an unknown-profile error). Profile names in this document live in the user namespace — a user profile overrides a builtin preset only on an exact name match, and a future builtin with the same name would be silently shadowed by your copy.

See [Extragoal local skill template](./extragoal-skill-template.md) for the full gate workflow (verdict contract, findings triage, bounded re-sign loop, secret-scan and injection guards) built on this recipe.

## Model cheatsheet (by need)

Current axis leaders and the cheaper second option, with metered price ($/1M in/out; Gemini via Antigravity runs on the Google AI subscription):

| Need | First pick | Cheaper option |
| --- | --- | --- |
| Router / tool-calling (`default`) | `anthropic/claude-opus-5` (5/25) | `anthropic/claude-sonnet-5` (3/15) |
| Coding (`executor`) | `anthropic/claude-opus-5` (5/25) — the prior `claude-opus-4-8` scored SWE-bench Verified ~88.6; no Opus 5 measurement yet | `openai-codex/gpt-5.4` (2.5/15) · `opencode-go/deepseek-v4-flash` (0.14/0.28) |
| Reasoning (`planner`) | `openai-codex/gpt-5.5` (ARC-AGI-2) / `google-antigravity/gemini-3.1-pro-low:high` (GPQA) | `xai/grok-4-1-fast` (0.2/0.5) |
| Large context (`architect`) | `anthropic/claude-opus-5` (effective long-context) | `xai/grok-4-fast` (2M nominal, 0.2/0.5) |
| Multimodal review (`architect`) | `google-antigravity/gemini-3.1-pro-low:high` | `google-antigravity/gemini-3.5-flash` |
| Independent critic | `xai/grok-4.3` (1.25/2.5) | `opencode-go/glm-5.2` · `google-antigravity/gemini-3.5-flash` |

On standard tasks, all current frontier models in the catalog are accurate; **pick by cost, latency, and role fit, not by raw accuracy on easy prompts.** As an indicative GJC-routed latency reference (`gjc -p`, identical coding + reasoning prompts, all correct): `grok-4.3` and `glm-5.2` ≈ 2–3s, `deepseek-v4-pro` ≈ 3–4s, `claude-opus-4-8` / `gpt-5.5` ≈ 4–7s, `gemini-3.1-pro-low:high` ≈ 7s. `claude-opus-5` shares Opus 4.8's published context/output envelope but has not been latency-measured here.

## Verified selector notes (current catalog)

Observed via live `gjc -p` calls; useful when wiring the profiles above:

- **Antigravity Gemini, high reasoning** → use `google-antigravity/gemini-3.1-pro-low:high`. The id `gemini-3.1-pro-high` returns HTTP 400 (no matching backend model); `thinkingLevel` is a per-request parameter, so raising it on `gemini-3.1-pro-low` invokes the model's native high-reasoning mode rather than a degraded one.
- **openai-codex on a ChatGPT account** has entitlement-dependent model access: base GPT includes `gpt-5.5` and `gpt-5.4`. Standalone `-codex` variants (`gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex-max` / `-mini`) return `not supported when using Codex with a ChatGPT account`. GPT-5.6 Sol access for Plus and unknown plans is decided by live provider entitlement: those local usage labels only rank Sol accounts, while a confirmed Free-only pool remains locally unsupported; provider-confirmed entitlement failures surface actionable guidance. Spark models retain their existing local filter: if any connected account is confirmed Pro, non-Pro candidates are excluded; if none is confirmed Pro, Plus or unknown-plan candidates may still be attempted.
- **Single-message input limit is separate from the context window.** Measured on `claude-opus-4-8` (not yet re-measured on `claude-opus-5`, which publishes the same 1M window): the model runs with a 1M window via multi-turn accumulation, but a single `@file` message above ~400k tokens returns 400 on `anthropic` / `google-antigravity`; `xai` / `opencode-go` accept larger single messages. Chunk very large inputs across turns instead of pasting one block.
- **Some selectors come from a provider's live catalog, not the bundled snapshot.** `opencode-go/glm-5.2` and `google-antigravity/gemini-3.5-flash` resolved in `gjc -p` tests but are **not** in `packages/ai/src/models.json`; they appear only after the provider's online model discovery has populated the registry. `required_providers` verifies credentials at activation — it does **not** guarantee fresh, non-stale discovery — so activation can still fail with `selector did not resolve` until discovery runs (re-login or retry to refresh). If you hit that, substitute a bundled id: `opencode-go/deepseek-v4-pro` for the critic, or `zai/glm-5.2` (add `zai` to `required_providers`) for GLM 5.2.

## Activation

```bash
gjc --mpreset daily               # this session only
gjc --mpreset ultimate --default  # persist as the startup default (config.yml)
```

### Delegation is what makes vendor separation pay off

Worker roles only consume the other vendor's quota when the main agent actually delegates, and the strong "delegate by default" directive is gated behind `task.eager`. When `executor` or `planner` is pinned to a provider other than the `default` role's provider, GJC therefore turns eager delegation on for that session unless `task.eager` is set explicitly in config. Setting `task.eager false` by hand stays authoritative and keeps the separated workers idle — `gjc config doctor` reports that combination as an advisory.

Activation hard-blocks when any provider in `required_providers` lacks credentials, so log in first: `/login anthropic`, `/login openai-codex`, `/login google-antigravity`, `/login xai` (and `opencode-go` via `OPENCODE_API_KEY`).

### Serving cross-vendor profiles through one OpenAI-compatible proxy

When a single gateway (LiteLLM, OpenRouter, or a custom proxy) fronts several vendors, you do not need to configure every `required_providers` entry directly. Add the gateway as a provider — `gjc setup provider --preset litellm --base-url <url>` or `gjc setup provider --preset openai-compatible-proxy --base-url <url>` — and point `modelProfile.proxyProvider` at it in `config.yml`:

```yaml
modelProfile:
  proxyProvider: litellm
  proxyMode: always # route all supported built-in preset selectors through the gateway
```

`proxyMode: fallback` is the default and uses the gateway only when the direct provider is unauthenticated. Set `proxyMode: always` when the gateway must be the single audit, quota, or spend-control surface: it routes all proxy-routable **built-in** preset selectors through the proxy even when direct credentials exist. The configured proxy must be authenticated and expose every routed model; activation fails closed for missing or ambiguous models. User-defined profiles are never rewritten — set their selectors to `litellm/…` explicitly if you want them proxied. Routing and fail-closed behavior are documented in [Routing built-in presets through a proxy](./models.md#routing-built-in-presets-through-a-proxy-modelprofileproxyprovider).
