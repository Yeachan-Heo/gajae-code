# web_search

> Run one web query through the first available search provider and return LLM-formatted answer, source URLs, and optional citations.

> Note: `insane-search` is **not** a `web_search` provider and does not affect search-provider selection. It is an opt-in fallback for the `read` tool's URL fetch path (`web.insaneFallback`); see `docs/tools/read.md`.

## Source
- Entry: `packages/coding-agent/src/web/search/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/web-search.md`
- Key collaborators:
  - `packages/coding-agent/src/web/search/provider.ts` — lazy provider registry; availability chain.
  - `packages/coding-agent/src/web/search/types.ts` — unified `SearchResponse` / `SearchProviderError` types.
  - `packages/coding-agent/src/web/search/render.ts` — TUI renderer details type.
  - `packages/coding-agent/src/web/search/providers/base.ts` — provider interface and shared params contract.
  - `packages/coding-agent/src/web/search/providers/utils.ts` — credential lookup; source normalization.
  - `packages/coding-agent/src/web/search/providers/anthropic.ts` — Anthropic model web-search provider.
  - `packages/coding-agent/src/web/search/providers/brave.ts` — Brave Search API adapter.
  - `packages/coding-agent/src/web/search/providers/duckduckgo.ts` — keyless DuckDuckGo html/lite scrape adapter (permissionless default/fallback).
  - `packages/coding-agent/src/web/search/providers/insane.ts` — keyless safe public-route adapter inspired by upstream `fivetaku/insane-search`.
  - `packages/coding-agent/src/web/search/providers/openai-code.ts` — OpenAI code provider SSE adapter.
  - `packages/coding-agent/src/web/search/providers/exa.ts` — Exa API adapter.
  - `packages/coding-agent/src/web/search/providers/gemini.ts` — Gemini grounding SSE adapter.
  - `packages/coding-agent/src/web/search/providers/jina.ts` — Jina Reader search adapter.
  - `packages/coding-agent/src/web/search/providers/kagi.ts` — Kagi provider wrapper.
  - `packages/coding-agent/src/web/search/providers/kimi.ts` — Kimi search adapter.
  - `packages/coding-agent/src/web/search/providers/parallel.ts` — Parallel provider wrapper.
  - `packages/coding-agent/src/web/search/providers/perplexity.ts` — Perplexity API / OAuth adapter.
  - `packages/coding-agent/src/web/search/providers/searxng.ts` — self-hosted SearXNG adapter.
  - `packages/coding-agent/src/web/search/providers/synthetic.ts` — Synthetic search adapter.
  - `packages/coding-agent/src/web/search/providers/tavily.ts` — Tavily search adapter.
  - `packages/coding-agent/src/web/search/providers/zai.ts` — Z.AI remote search adapter.
  - `packages/coding-agent/src/web/parallel.ts` — Parallel search/extract HTTP client.
  - `packages/coding-agent/src/web/kagi.ts` — Kagi HTTP client.
  - `packages/coding-agent/src/tools/index.ts` — built-in tool registration and enable flag.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Search query. `executeSearch()` rewrites any `2020`-`2029` substring to the current year before dispatch. |
| `recency` | `"day" \| "week" \| "month" \| "year"` | No | Time filter. Only providers that implement it use it. Prompt text says Brave and Perplexity; code also maps it for Tavily and SearXNG. |
| `limit` | `number` | No | Max results to return. Usually becomes the provider request's result-count parameter when `num_search_results` is absent. |
| `max_tokens` | `number` | No | Passed through as `maxOutputTokens` / `max_tokens` only by Anthropic, Gemini, and Perplexity API-key mode. Ignored by the other providers. |
| `temperature` | `number` | No | Passed through only by Anthropic, Gemini, and Perplexity API-key mode. Ignored by the other providers. |
| `num_search_results` | `number` | No | Requested upstream search breadth. For most providers this is the same count used for returned sources. Perplexity is the only adapter that keeps it distinct from `limit`. |

## Outputs
The tool returns a single text content block plus structured `details`.

- `content`: `[{ type: "text", text: string }]`
- `details`: `SearchRenderDetails` from `packages/coding-agent/src/web/search/render.ts`
  - `response: SearchResponse`
  - `error?: string`

`text` is produced by `formatForLLM()` in `packages/coding-agent/src/web/search/index.ts`:

- If `response.answer` exists, it is emitted first.
- If sources exist, a `## Sources` section follows with a source count, then one entry per source:
  - `[n] <title> (<formatted age or published date>)`
  - `    <url>`
  - optional snippet line truncated to 240 chars.
- If citations exist, a `## Citations` section follows with URL/title plus optional cited text truncated to 240 chars.
- If related questions exist, a `## Related` bullet list follows.
- If search queries exist, a `Search queries: <n>` section follows, capped to the first 3 queries and 120 chars each.

Failure output is not thrown at the tool boundary when at least one provider was attempted. Instead the tool returns:

- `content[0].text = "Error: ..."`
- `details.response.provider = <last attempted provider> | "none"`
- `details.error = ...`

Streaming: none. `WebSearchTool.execute()` does not forward its `_signal` argument into `executeSearch()`, so provider cancellation is only available to internal callers that place `signal` inside `SearchQueryParams`.

## Flow
1. `WebSearchTool.execute()` in `packages/coding-agent/src/web/search/index.ts` delegates directly to `executeSearch()`.
2. `executeSearch()` resolves the provider list via a single `resolveProviderChain(authStorage, params.provider ?? "auto", activeModelProvider)` call. The active model's provider is threaded in from `WebSearchTool` (`this.#session.model?.provider`, falling back to parsing `getActiveModelString()`) and from the CustomTool path (`ctx.model?.provider`).
3. `resolveProviderChain()` is active-model-gated, not credential-scanning:
   - an explicitly preferred/selected provider that is `isAvailable()` becomes the primary;
   - otherwise the active model's own native search (`MODEL_PROVIDER_TO_SEARCH` + `inferNativeProviderFromModel()`) becomes the primary, when that provider's canonical credentials exist (`isAvailable()`);
   - failing that, **native-over-proxy** kicks in: `activeContextNativeId()` matches the active model's wire `api` (+ model-id family) to a native provider, and if the active model's OWN credential resolves (`getApiKey(ctx.provider, { baseUrl, modelId })`), that native provider is attempted reusing those credentials and `ctx.baseUrl`. Dispatch: `anthropic-messages`+`claude-*`→`anthropic`, `openai-responses`/`openai-completions`→`openai-compatible`, `google-generative-ai`+`gemini-*`→`gemini`;
   - keyed standalone providers are never auto-selected — explicit selection only.
4. DuckDuckGo (keyless, `isAvailable()` always true) is always appended as the terminal fallback, so a missing primary — or a primary runtime failure — still returns results with zero configuration. There is no longer a "No web search provider configured" path.
5. For each provider in order, `executeSearch()` calls `provider.search()` with:
   - `query` after year-rewrite,
   - `limit`, `recency`, `temperature`, `maxOutputTokens`, `numSearchResults`,
   - `systemPrompt` from `packages/coding-agent/src/prompts/tools/web-search.md`.
6. On the first successful `SearchResponse`, `formatForLLM()` renders answer/sources/citations/related/search-queries into one text block and returns it with `details.response`.
7. If a provider throws, `executeSearch()` records the error and tries the next provider. Fallback is sequential, with one exception: when DuckDuckGo is a non-primary chain member, `executeSearch()` fires it as a background hedge after `DDG_HEDGE_DELAY_MS` (3s). A successful primary aborts the hedge; a failing primary reuses the (typically already-settled) hedge result, collapsing fallback latency from `t(primary failure) + t(ddg)` to `max(t(primary failure), t(ddg))`.
8. After all candidates fail, `formatProviderError()` normalizes the last error:
   - Anthropic `404` becomes `Anthropic web search returned 404 (model or endpoint not found).`
   - `401`/`403` become `<Provider> authorization failed ...` except Z.AI, which preserves its raw message.
   - other `SearchProviderError`s surface `error.message`.
9. If more than one provider was attempted, the final message is `All web search providers failed (<labels>). Last error: <message>`; otherwise it is just the normalized last error.

## Modes / Variants
- **Provider selection**
  - **Forced provider**: internal callers may pass `provider`; an unavailable forced provider falls back to the chain (which always ends in DuckDuckGo) instead of hard-failing (`packages/coding-agent/src/web/search/index.ts`). This field is not in the model-facing schema.
  - **Preferred provider**: `setPreferredSearchProvider()` sets a module-global default consumed by `resolveProviderChain()`. `packages/coding-agent/src/sdk/session.ts` and `packages/coding-agent/src/modes/controllers/selector-controller.ts` wire this from settings.
  - **Tavily selection**: set `providers.webSearch` to `tavily` and provide `TAVILY_API_KEY` (or a stored Tavily provider credential). In `auto`, Tavily is not scanned just because an env key exists, so keyless/default behavior remains unchanged until Tavily is selected or listed as an available fallback.
  - **Active-model-gated auto**: in `auto` mode, resolution first maps the active model's provider to its own native search via `MODEL_PROVIDER_TO_SEARCH` (`openai|openai-codex→codex`, `anthropic→anthropic`, `google|google-gemini-cli|google-antigravity|gemini→gemini`, `moonshot|kimi-code|kimi→kimi`, `zai`, `perplexity`, `synthetic`) and `inferNativeProviderFromModel()`, used when that provider's canonical creds exist. When no canonical native is selected, `activeContextNativeId()` drives native search through the active model's OWN credential + `baseUrl` (native-over-proxy), dispatched by wire `api`: `anthropic-messages`+`claude-*`→`anthropic` (reuses `ctx` key/baseUrl via `searchAnthropic`), `openai-responses`/`openai-completions`→`openai-compatible`, `google-generative-ai`+`gemini-*`→`gemini` (Generative Language `generateContent`). The native provider fails closed (and the chain falls through to DuckDuckGo) if the endpoint does not actually support web search. `SEARCH_PROVIDER_ORDER` no longer drives auto credential scanning — it is retained for explicit selection, labels, and CLI option lists.
- **Provider adapters**
  - **Insane** — `packages/coding-agent/src/web/search/providers/insane.ts`
    - Availability: always available; no API key, OAuth, cookies, browser profile, subprocess, or auto-installed dependency.
    - Querying: if the query is a supported public URL, tries deterministic no-auth public routes first; otherwise uses DuckDuckGo discovery and enriches supported result URLs through the same safe routes.
    - Safe upstream concepts ported: Phase 0 public route table and route-attempt metadata for Reddit RSS, X/Twitter tweet-result/oEmbed/syndication, YouTube oEmbed/channel feed, and Hacker News Firebase item metadata.
    - Explicitly not ported from upstream: TLS impersonation, Playwright/browser fallback, cookie warming/storage, CAPTCHA/paywall/login bypasses, credential storage, and auto dependency installation. Unsupported or blocked routes fail closed with a provider error.
    - `limit` / `num_search_results`: collapsed together, clamped to `1..20`, default `10`.
    - Output: `sources` only, with snippets annotated by the public route used and `searchQueries` containing compact route-attempt diagnostics.
  - **Tavily** — `packages/coding-agent/src/web/search/providers/tavily.ts`
    - Availability: API key from env or `agent.db` via `findCredential()`.
    - Querying: POST `https://api.tavily.com/search`.
    - `recency` maps to Tavily `time_range`; code explicitly keeps `topic` at default general scope instead of narrowing to news.
    - `limit` / `num_search_results`: adapter uses `params.numSearchResults ?? params.limit`, clamped to `5..20` with default `5`.
    - Output: `answer`, `sources`, `requestId`, `authMode: "api_key"`.
  - **Perplexity** — `packages/coding-agent/src/web/search/providers/perplexity.ts`
    - Availability: auth precedence is `PERPLEXITY_COOKIES` -> OAuth token in `agent.db` -> `PERPLEXITY_API_KEY` / `PPLX_API_KEY`.
    - OAuth/cookie mode: POSTs to `https://www.perplexity.ai/rest/sse/perplexity_ask`, consumes SSE, merges partial events, extracts answer and source URLs, sets `authMode: "oauth"`.
    - API-key mode: POSTs to `https://api.perplexity.ai/chat/completions` with `model: "sonar-pro"`, `search_mode: "web"`, `num_search_results`, optional `search_recency_filter`, `max_tokens`, `temperature`.
    - `num_search_results` controls upstream API breadth only in API-key mode. `limit` is preserved separately as `num_results` and slices returned `sources` after parsing in both auth modes.
    - Output may include `answer`, `sources`, `citations`, `usage`, `model`, `requestId`, `authMode`.
  - **Brave** — `packages/coding-agent/src/web/search/providers/brave.ts`
    - Availability: `BRAVE_API_KEY` only.
    - Querying: GET `https://api.search.brave.com/res/v1/web/search` with `count`, `extra_snippets=true`, and `freshness=pd|pw|pm|py` for `recency`.
    - `limit` / `num_search_results`: `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`.
    - Output: `sources`, `requestId`.
  - **Jina** — `packages/coding-agent/src/web/search/providers/jina.ts`
    - Availability: `JINA_API_KEY` only.
    - Querying: GET-like fetch to `https://s.jina.ai/<encoded query>` with bearer auth.
    - Ignores `recency`, `max_tokens`, and `temperature`.
    - `limit` / `num_search_results`: adapter slices sources to `params.numSearchResults ?? params.limit` when provided; otherwise returns all payload items.
    - Output: `sources` only.
  - **Kimi** — `packages/coding-agent/src/web/search/providers/kimi.ts`
    - Availability: `MOONSHOT_SEARCH_API_KEY`, `KIMI_SEARCH_API_KEY`, `MOONSHOT_API_KEY`, or `agent.db` credentials for `moonshot` / `kimi-code`.
    - Querying: POST to `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` / default `https://api.kimi.com/coding/v1/search` with `text_query`, `limit`, `enable_page_crawling`, `timeout_seconds: 30`.
    - `limit` / `num_search_results`: `params.numSearchResults ?? params.limit`, clamped to `1..20`, default `10`.
    - Output: `sources`, `requestId`.
  - **Anthropic** — `packages/coding-agent/src/web/search/providers/anthropic.ts`
    - Availability: `findAnthropicAuth()` from `@gajae-code/ai`.
    - Querying: Anthropic model Messages API with web-search tool enabled.
    - `max_tokens` and `temperature` pass through.
    - `limit` and `num_search_results` are collapsed together before dispatch: `num_results = params.numSearchResults ?? params.limit`.
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage.searchRequests`, `model`, `requestId`.
    - When a search ran (`web_search_tool_result` / `server_tool_use` / `usage.server_tool_use.web_search_requests`) but only inline citations were emitted, sources are recovered from the answer text via `providers/text-citations.ts`. If no search ran and nothing is grounded, it fails closed (`424`) so the chain falls through to DuckDuckGo.
  - **Gemini** — `packages/coding-agent/src/web/search/providers/gemini.ts`
    - Availability: OAuth credentials in `agent.db` for `google-gemini-cli` or `google-antigravity`.
    - Querying: SSE `streamGenerateContent` call with Google Search grounding enabled. Antigravity auth tries two fallback endpoints and retries `401/403/400 invalid auth` once after token refresh; `429/5xx` retry with exponential backoff and server-provided retry delay, capped by a `30 * 1000` ms rate-limit budget (the chain always terminates in keyless DuckDuckGo, so a rate-limited Gemini fails through fast instead of parking the chain).
    - `max_tokens` and `temperature` pass through as `generationConfig.maxOutputTokens` / `generationConfig.temperature`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include `answer`, `sources`, `citations`, `searchQueries`, `usage`, `model`.
  - **OpenAI code** — `packages/coding-agent/src/web/search/providers/openai-code.ts`
    - Availability: non-expired OAuth credential for `openai-code` in `agent.db`.
    - Querying: SSE POST to `https://chatgpt.com/backend-api/openai-code/responses` with `tool_choice: { type: "web_search" }` and `search_context_size: "high"` by default.
    - Ignores `recency`, `max_tokens`, and `temperature` in this tool path.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include `answer`, `sources`, `usage`, `model`, `requestId`. If the streamed response has no `url_citation` annotations, the adapter falls back to scraping markdown links and bare URLs from the answer text.
  - **Z.AI** — `packages/coding-agent/src/web/search/providers/zai.ts`
    - Availability: env or `agent.db` credential for `zai`.
    - Querying: JSON-RPC `tools/call` against the Z.AI `web_search_prime` search endpoint.
    - Fallback chain inside the provider: tries `{query,count}`, then `{search_query,count}`, then `{search_query, search_engine:"search-prime", count}` when earlier attempts fail with argument-shape errors.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output may include parsed free-text `answer`, `sources`, `requestId`.
  - **Exa** — `packages/coding-agent/src/web/search/providers/exa.ts`
    - Availability: requires `EXA_API_KEY` and settings must not disable `exa.enabled` or `exa.enableSearch`.
    - Querying: POST `https://api.exa.ai/search` with `EXA_API_KEY`. No no-key fallback is used.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output: synthesized `answer` from up to 3 result summaries, `sources`, `requestId`.
  - **Parallel** — `packages/coding-agent/src/web/search/providers/parallel.ts`, `packages/coding-agent/src/web/parallel.ts`
    - Availability: env or `agent.db` credential for `parallel`.
    - Querying: POST `https://api.parallel.ai/v1beta/search` with `objective=query`, `search_queries=[query]`, `mode:"fast"`, `max_chars_per_result: 10000`, beta header `search-extract-2025-10-10`.
    - There is no provider fan-out here despite the name; the current adapter always sends a one-element `search_queries` array.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..40`, default `10`.
    - Output: `sources`, `requestId`.
  - **Kagi** — `packages/coding-agent/src/web/search/providers/kagi.ts`, `packages/coding-agent/src/web/kagi.ts`
    - Availability: env or `agent.db` credential for `kagi`.
    - Querying: GET `https://kagi.com/api/v0/search?q=<query>&limit=<n>` with `Authorization: Bot <key>`.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..40`, default `10`.
    - Output: `sources`, `relatedQuestions`, `requestId`.
  - **Synthetic** — `packages/coding-agent/src/web/search/providers/synthetic.ts`
    - Availability: env or `agent.db` credential for `synthetic`.
    - Querying: POST `https://api.synthetic.new/v2/search` with `{ query }`.
    - Ignores `recency`, `max_tokens`, and `temperature`.
    - `limit` and `num_search_results` are collapsed together before dispatch.
    - Output: `sources` only.
  - **SearXNG** — `packages/coding-agent/src/web/search/providers/searxng.ts`
    - Availability: endpoint from `searxng.endpoint` setting or `SEARXNG_ENDPOINT` env.
    - Querying: GET `<endpoint>/search?format=json&q=...`; optional settings add `categories` and `language`.
    - Auth precedence: Basic auth (`searxng.basicUsername` / `searxng.basicPassword` or env equivalents) over bearer token (`searxng.token` / `SEARXNG_TOKEN`). Basic credentials are validated for RFC 7617 restrictions.
    - `recency` maps to `time_range`; `week` is downgraded to `month` because SearXNG does not support week.
    - `limit` and `num_search_results` are collapsed together before dispatch, clamped to `1..20`, default `10`.
    - Output: `sources`, `relatedQuestions` from `suggestions`.

## Side Effects
- Network
  - Calls one or more external search providers over HTTPS until one succeeds or all fail.
  - Provider-specific transports include JSON POST, JSON GET, SSE streaming (Perplexity OAuth/API, Gemini, OpenAI code), and JSON-RPC over HTTP (Z.AI).
- Subprocesses / native bindings
  - None.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Uses a module-global provider-instance cache in `packages/coding-agent/src/web/search/provider.ts`.
  - Uses a WeakMap-keyed resolved-chain cache (per AuthStorage, 60s TTL) in the same file; `WebSearchTool`'s constructor prewarms it via `prewarmSearchProviders()`.
  - Uses a module-global preferred-provider setting in the same file.
  - `packages/coding-agent/src/tools/index.ts` gates tool availability behind `session.settings.get("web_search.enabled")`.
- Background work / cancellation
  - Many provider adapters accept `AbortSignal`, but `WebSearchTool.execute()` does not pass its `_signal` into `executeSearch()`. Internal callers can still use cancellation by calling `runSearchQuery()` / `executeSearch()` with `signal` embedded in params.

## Limits & Caps
- Provider registry size: 16 providers (`SEARCH_PROVIDER_ORDER` in `packages/coding-agent/src/web/search/provider.ts`), including the keyless `duckduckgo` default/fallback and selectable `insane` safe-public-route provider. `SEARCH_PROVIDER_ORDER` no longer drives auto selection — see "Active-model-gated auto" above.
- Insane result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/insane.ts`).
- `formatForLLM()` truncates source snippets and citation text to 240 chars (`packages/coding-agent/src/web/search/index.ts`).
- `formatForLLM()` emits at most 3 search queries, each truncated to 120 chars (`packages/coding-agent/src/web/search/index.ts`).
- Brave result count: default `10`, max `20` (`DEFAULT_NUM_RESULTS`, `MAX_NUM_RESULTS` in `packages/coding-agent/src/web/search/providers/brave.ts`).
- Tavily result count: default `5`, max `20` (`packages/coding-agent/src/web/search/providers/tavily.ts`).
- Kimi result count: default `10`, max `20`; request timeout field fixed to `30` seconds (`packages/coding-agent/src/web/search/providers/kimi.ts`).
- Parallel result count: default `10`, max `40`; per-result excerpt cap `10_000` chars (`packages/coding-agent/src/web/search/providers/parallel.ts`, `packages/coding-agent/src/web/parallel.ts`).
- Kagi result count: default `10`, max `40` (`packages/coding-agent/src/web/search/providers/kagi.ts`).
- SearXNG result count: default `10`, max `20` (`packages/coding-agent/src/web/search/providers/searxng.ts`).
- Perplexity API-key mode defaults: `max_tokens = 8192`, `temperature = 0.2`, `num_search_results = 10` (`packages/coding-agent/src/web/search/providers/perplexity.ts`).
- Anthropic defaults: model `anthropic-model-haiku-4-5`, `DEFAULT_MAX_TOKENS = 4096` when the provider omits `max_tokens` (`packages/coding-agent/src/web/search/providers/anthropic.ts`).
- Gemini retries: up to `3` retries per endpoint, base delay `1000` ms, rate-limit delay budget `30 * 1000` ms (`packages/coding-agent/src/web/search/providers/gemini.ts`).
- Hard timeouts are class-based (`packages/coding-agent/src/web/search/providers/utils.ts`): pure search APIs `SEARCH_API_TIMEOUT_MS = 15_000`, LLM-mediated providers `SEARCH_LLM_TIMEOUT_MS = 120_000`, legacy fallback `SEARCH_HARD_TIMEOUT_MS = 300_000` for untagged call sites. Kimi uses an explicit `KIMI_HARD_TIMEOUT_MS = 35_000` aligned with its upstream `timeout_seconds: 30` budget. An explicitly configured `web_search.timeout` overrides class defaults (`applyConfiguredSearchTimeout()` gates on `settings.has`, so the schema default 300 does not reinstall a uniform ceiling).
- DuckDuckGo hedge delay: `DDG_HEDGE_DELAY_MS = 3_000` (`packages/coding-agent/src/web/search/index.ts`).
- Resolved provider chains are cached per `AuthStorage` instance for `CHAIN_CACHE_TTL_MS = 60_000`, keyed on the storage credential generation so login/logout invalidates immediately; `setPreferredSearchProvider()` / `setSearchFallbackProviders()` clear the cache (`packages/coding-agent/src/web/search/provider.ts`).

## Errors
- There is no "no provider configured" case: DuckDuckGo (keyless) is always appended as the terminal fallback, so the chain is never empty.
- Tool-level all-failed case also returns a normal tool result with `Error: ...`; failures are summarized from the last attempted provider.
- Provider adapters usually throw `SearchProviderError(provider, message, status)` for HTTP or protocol failures.
- Availability probes intentionally swallow lookup errors and report `false` in many providers via `isApiKeyAvailable()`.
- Per-provider notable failures:
  - Anthropic: missing credentials throw a plain `Error`; a `404` is remapped to a special final message by `formatProviderError()`.
  - Perplexity: missing auth throws a plain `Error`; OAuth stream `error_code` events become `SearchProviderError("perplexity", ...)`.
  - Gemini: auth refresh, endpoint fallback, and retry logic are internal; final exhausted failures surface as `SearchProviderError("gemini", ...)`.
  - OpenAI code and Gemini both fail if the HTTP response has no body after a `200`.
  - Z.AI treats malformed SSE/JSON-RPC payloads as provider errors and retries only argument-shape failures across request variants.
  - SearXNG `findAuth()` can throw configuration errors before any HTTP call if Basic auth fields are incomplete or invalid.

## Notes
- The model-facing schema does not expose `provider`, but internal callers can force one through `SearchQueryParams`.
- `resolveProviderChain()` lazily imports provider modules and caches singleton instances. Just asking for labels via `getSearchProviderLabel()` does not trigger those imports.
- Most providers treat `limit` and `num_search_results` as the same number because adapters pass `params.numSearchResults ?? params.limit`. Perplexity is the only implementation that preserves both concepts.
- The prompt says `recency` is for Brave and Perplexity, but code also implements it for Tavily and SearXNG.
- The year rewrite in `executeSearch()` is blunt: any `2020`-`2029` substring is replaced with the current year.
- `packages/coding-agent/src/config/settings-schema.ts` exposes provider preferences for `auto`, `duckduckgo`, `insane`, `exa`, `brave`, `jina`, `kimi`, `perplexity`, `anthropic`, `gemini`, `codex`, `xai`, `zai`, `tavily`, `kagi`, `synthetic`, `parallel`, and `searxng`.
- Exa availability fails closed unless `EXA_API_KEY` is present and Exa settings remain enabled.
