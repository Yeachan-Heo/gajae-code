# Changelog

## [Unreleased]

- Maintenance reasoning now fails closed for Anthropic models routed through an unverified custom endpoint and for raw reasoning-enabled models without thinking metadata. This prevents unsupported thinking controls and avoids a synchronous missing-metadata crash before provider wire transformation.

## [0.16.4] - 2026-09-05

### Added

- Bundled `openai-codex/gpt-6-astra` from the authenticated Codex catalog so eligible ChatGPT accounts can select Astra before a live discovery refresh. The reviewed snapshot records Codex's 272K prompt budget, 128K output cap, text-and-image input, websocket preference, low-through-max reasoning efforts, freeform `apply_patch`, and published tiered OpenAI pricing.

### Fixed

- OpenAI Codex HTTP failures with an empty response body and empty status text now include the HTTP status in the surfaced message instead of the opaque `Request failed`, while structured provider errors retain their existing messages and classification.
- Direct xAI reasoning effort now requires the exact production HTTPS `api.x.ai` origin: HTTP, userinfo, query/fragment components, and explicit non-default ports fail closed. Bedrock Claude cache-pricing metadata now shares the request prompt-caching generation policy, retaining only Claude 3.5 Haiku, Claude 3.7 Sonnet, and Claude 4+ support.

- OpenCode Go requests across chat completions, Responses, and Anthropic-compatible models now send the provider-required `x-opencode-session` header at their exact canonical Go endpoints using the coding-agent's existing opaque provider session id. The provider-owned identity is typed separately from generic cache affinity, so auth-gateway prompt-derived cache keys cannot become the header. The value remains stable across turns and every retry layer in one conversation, differs with the conversation lifecycle, cannot be injected or replaced by caller/model request headers or transforms on unauthorized routes, and is never added to OpenCode Zen or unrelated compatible endpoints (#5295).
- Bedrock prompt caching is now gated on the Claude generation parsed from the model id instead of version-literal fragments (`-4-`/`-4.`, `claude-haiku`, and two 3.x literals). A future generation's Bedrock id (`us.anthropic.claude-opus-5-…`, or a new model kind) matched none of the literals, so cache points were silently omitted and every request re-paid full input pricing. Behavior for the documented support set — 3.5 Haiku, 3.7 Sonnet, and 4.x naming including `us.`/`eu.`/`au.`/`jp.`/`global.` inference profiles — is unchanged, per AWS's prompt-caching support matrix. A bundled-catalog tripwire now fails when a regenerated catalog introduces a Claude id shape the parser cannot read, so shape drift is loud instead of silently disabling caching.

- Direct-xAI `reasoning_effort` support is now derived from a strictly parsed canonical grok generation (4.5+) instead of the exact ids `grok-4.5`/`grok-4.6` in the compat layer and the coding-agent thinking-choice gate; a future grok release failed the id list, so `supportsReasoningEffort` stayed `false` and the user's thinking level was silently dropped from requests with no error. The generated-policy `reasoning` pin stays scoped to the two rows whose upstream metadata shipped stale — a per-row data correction, not a family rule — so catalog `reasoning: false` flags (including the bundled grok `-non-reasoning` variants) remain authoritative for everything else. Direct capability requires the official xAI origin; private and proxy OpenAI-compatible origins fail closed unless explicitly configured, while reseller routes such as OpenRouter keep their existing audited transport behavior.

- Cursor payload hooks now receive protobuf requests as JSON-safe values, await asynchronous inspection or replacement, and validate replacement payloads before transport. Checkpoint state containing 64-bit protobuf fields no longer makes hook-side `JSON.stringify` fail on JavaScript `bigint` values.
- The OpenAI Codex GPT-5.6 Sol entitlement preflight no longer rejects Business, Enterprise, or Team ChatGPT OAuth accounts. Eligibility was decided by `plan_type.includes("pro")`, so a `business`/`enterprise`/`team` plan (which is entitled to Sol on the backend) failed credential selection before dispatch with a spurious "cannot use model" error, even though a direct request to the ChatGPT Codex backend succeeds for those plans. A shared classifier now recognizes exact Pro/Business/Enterprise/Team tier names and known Free/Plus denials. Missing or unfamiliar plan names remain unknown and reach the provider instead of gaining entitlement through a substring match or being rejected by a client-side guess.

## [0.16.3] - 2026-09-04

## [0.16.2] - 2026-09-04

- OpenAI Codex GPT-5.6 Sol selections now reject a known non-Pro ChatGPT OAuth account before dispatch, instead of allowing a binding that fails later with the provider's raw entitlement error. The same rejection is normalized for HTTP and streaming provider responses with guidance to choose a callable model or use an API-key credential.

## [0.16.1] - 2026-09-03

### Added

- Exported `fetchModelsDevPayload` from `provider-models/openai-compat` and coalesced its downloads. models.dev publishes one catalog document describing every provider, but each models.dev-backed provider downloaded it separately, so a single discovery pass transferred the same payload once per provider (and `packages/coding-agent` kept a second downloader of its own). Downloads are now shared per fetch implementation for a 60s window, failures are not retained, and `coding-agent` model discovery consumes the same fetcher.

- Exported `detectDiscoveredApiFamily` from `utils/discovery/openai-compatible`: infers the wire API family (`anthropic-messages` vs `openai-completions`) for a discovered model on a mixed OpenAI-compatible gateway, using the OpenAI `owned_by` owner first and the model id (`claude-*` vs `gpt-*`/`o1`/`codex`/…) as fallback, returning `undefined` when inconclusive. Consumed by custom-provider auto model discovery in `packages/coding-agent`.

### Fixed

- Antigravity discovery now keeps mid-rollout models that the backend marks `isInternal` when the same response surfaces them through `agentModelSorts`. Internal models absent from the IDE's surfaced model groups remain hidden, and denylisted or retired selectors still take precedence.
- Tokenless loopback auth-broker requests carrying a browser `Origin` header are now rejected before credential reads or mutations. Native loopback clients without `Origin`, authenticated browser-origin clients, and the public health endpoint retain their existing behavior.
- `glm-zcode` login instructions now warn users who have the ZCode desktop app installed to cancel the browser's `zcode://` open prompt. The app exchanges the single-use authorization code itself, so a code pasted afterwards is rejected by the broker (`500 {"code":2007}`) and the documented paste flow failed without explanation.
- Cursor Connect watchdog and terminal admission now preserve buffered raw progress, partial output, and usage across bounded held-exec backpressure and transport failures.
- Cursor Connect streams now own their raw protobuf-progress watchdog, so valid heartbeat, usage, checkpoint, and exec frames keep active turns alive even when no normalized assistant event is emitted. Truly silent transports still time out through Cursor's provider terminal, preserving accumulated partial output and usage instead of replacing them with a zero-usage message (#4831).
- Coalesced Cursor Connect bursts now apply bounded parser backpressure instead of rejecting the 257th valid frame before queued microtasks can drain; HTTP/2 end waits until every buffered frame is parsed, preserving raw progress and partial usage through the final terminal (#4831 review).
- Cursor's provider-owned idle timeout uses the established `stream stalled while waiting for the next event` identity, and gRPC trailer, queue, and transport failures all settle behind any in-flight non-abortable exec fence before publishing a terminal (#4834 review).
- The non-abortable terminal fence now covers every Cursor mutation dispatch, not only `piWrite`: native `writeArgs` dispatches and Pi edit dispatches forward `markNonAbortable` through `resolveExecHandler`, so no started non-abortable filesystem mutation can still be running after the exec terminal is published on caller abort or the local deadline (#4834 review).
- Cursor arms its first-event watchdog BEFORE the proxy tunnel handshake, so a caller-supplied `streamFirstEventTimeoutMs` shorter than the tunnel's fixed 30-second connect timeout actually bounds proxy setup instead of being ignored until after the handshake completes (#4834 review).
- The pre-proxy first-event deadline actually interrupts a stalled tunnel handshake: the connect is raced against the same deadline, a tunnel that completes after the deadline won is destroyed instead of leaking, and the authenticated request is never created once the stream already settled (#4834 review).
- The Cursor bridge withholds the per-exec AbortSignal from non-abortable tools (matching agent-loop.ts) so an `untilAborted(signal, ...)` rejection can no longer make the settlement fence publish the terminal while the mutation still runs; the production Agent run guard forwards the `markNonAbortable` marker for native write dispatches (#4834 review).
- Cursor Connect exec handlers now receive a per-exec AbortSignal. The caller abort and the local exec deadline both abort it, and the coding-agent bridge threads it into `tool.execute`, so timed-out or caller-cancelled Cursor-local tools can actually stop instead of running to completion after the turn terminalizes. The transport abort fence is also installed before payload setup and rechecked immediately before proxy connect and request creation, closing the race where cancellation won after the check while bearer credentials were still transmitted (#4834 review).
- A started non-abortable Cursor mutation now settles behind a bounded fence: once the exec deadline (or caller abort) fires, a mutation that still has not settled within a grace window (exec deadline ÷ 4, minimum 5 s) rejects the exec, so an OS-level blocked read or wedged mutation can no longer hang the turn forever — pre-#4834 the wrapper terminalized such turns at ~120 s (#4834 review).
- Cursor `delete` is now part of the non-abortable settlement fence: its dispatch forwards `markNonAbortable` through the Agent run guard and the coding-agent bridge marks before the unlink runs, so a caller abort or deadline can no longer publish the exec terminal while the deletion is still in flight (#4834 review).

- Cursor sessions now report prompt tokens instead of zero. `ConversationTokenDetails.used_tokens` counts the whole conversation, but the checkpoint handler assigned it to `usage.output` and returned early whenever token deltas had been seen — which is the normal streaming path — so `usage.input`, `usage.cacheRead`, and `usage.cacheWrite` were left at their zero initializers for every cursor request. `calculatePromptTokens` therefore fell through to its output-only fallback, so the context indicator tracked the last response's output size rather than the conversation, and automatic compaction never observed a full context. Conversation usage is now recorded through the stream and split into prompt and output tokens when the stream finalizes.

- OAuth callback responses now serialize provider-controlled result fields as safe JSON script data, preventing callback values from terminating the embedded state element while preserving exact JSON values and callback behavior.

## [0.16.0] - 2026-09-02

### Added

- Bundled `anthropic/claude-fable-5-1` (Claude Fable 5.1): 1M context, 128K output, `anthropic-adaptive` thinking clamped to `xhigh` on the Messages API, matching the Fable 5 effort ladder exactly. The model is served only by Anthropic's first-party API and requires a Claude Code compatibility version of at least `2.1.251`; older fingerprints are answered with an HTTP 400 `claude_code_version_too_old`, which the `2.1.257` attribution bump clears. Verified live: `2.1.219` returns the 400, `2.1.257` returns 200, `low`/`high`/`xhigh` all stream, and adaptive thinking returns visible summarized content rather than signature-only billed thinking.

### Fixed

- Cursor's `kimi-k3-low`, `kimi-k3-high`, and `kimi-k3-max` now declare their real 1,048,576-token context window instead of 200,000. The bundled value was understated by 5.2x, so context management compacted these models at roughly a fifth of their usable window. The same underlying model already declares 1,048,576 elsewhere in this catalog (`openrouter/moonshotai/kimi-k3`, `kilo/moonshotai/kimi-k3`, and `opencode-go/kimi-k3` in `provider-models/openai-compat.ts`), so the cursor entries were the inconsistent ones. Measured against the live `cursor-agent` transport, which reports `usage.inputTokens` per request: 1,026,459 input tokens were accepted and answered correctly, while 1,161,948 tokens were silently summarized down to 20,552 and lost the answer. Output `maxTokens` is unchanged at 64,000, which this change did not measure.

- The Cursor Kimi K3 context correction is now enforced by the deterministic model-generation policy, so a future catalog regeneration cannot reintroduce the stale 200,000-token fallback.

- OpenCode Go's bundled catalog now contains all 33 models advertised by its live provider list, including the seven newly published models. Canonical endpoint metadata supplies their transport, multimodal input, limits, pricing, and reasoning capabilities, while generated output remains deterministic and preserves fail-closed selection when a live catalog is unavailable (#5144).

- SQLite corruption detection is now shared by credential and capability-cache surfaces, so callers can recognize `SQLITE_CORRUPT` and `SQLITE_NOTADB` without inspecting provider-specific error details.

- OpenAI Codex WebSockets are now opt-in on Windows. Bun 1.4.0 can segfault in its Windows TLS WebSocket handshake, so the automatic model preference uses SSE on Windows while the explicit WebSocket setting remains available for operators who have a newer safe runtime.
- MCP dispatcher tools now preserve dynamic nested `args` and `params` objects when a server declares them as propertyless JSON Schema objects. `normalizeSchemaForMCP` makes the implicit open-map semantics explicit with `additionalProperties: true` without loosening objects that declare properties or an explicit closure, so provider tool schemas no longer collapse valid nested arguments to `{}`.
- Schema normalization now copies `default`, `const`, `enum`, and `examples` payloads verbatim. These keywords carry instance data, not subschemas, so the previous recursive walk rewrote user payloads as if they were schemas (a `default` of `{"type":"object","nullable":true}` lost `nullable`, and literal `anyOf`/`const` branches collapsed into `enum`).
- Schema copies now write property names as own data properties. A `JSON.parse`d tool schema carries `__proto__` as an ordinary key, and plain assignment routed it to `Object.prototype`'s `__proto__` setter, dropping that valid property from the normalized schema.
- Schema-valued maps now remain maps even when dispatcher argument names collide with JSON Schema keywords (`type`, `default`, `const`, `enum`, or `examples`), and prototype-colliding names survive draft-upgrade, dereference, and Zod cleanup copies without polluting `Object.prototype`.
- Claude Code compatibility attribution moved from `2.1.219` to `2.1.257`, and the Gemini CLI spoofed version from `0.52.0` to `0.58.0`. Anthropic gates newer models behind a minimum client version, so a stale `claude-cli/<version>` fingerprint surfaces as an HTTP 400 on a model the account can otherwise reach. `scripts/check-spoofed-versions.ts` now covers `claudeCodeVersion` (resolved from Anthropic's `latest` native-installer release channel, with the `@anthropic-ai/claude-code` npm dist-tag as a second source and the higher of the two winning so one lagging channel cannot pin us back), spans multiple source files, and compares by semver instead of string equality. Both constants had only ever been bumped by hand and the check was never scheduled, so the new read-only daily `spoofed-version-sync` workflow now runs it and fails with a one-command remediation on drift.
- Bedrock and both Kiro credential transports now reject malformed project-aware AWS regions before interpolating them into authenticated service authorities. Valid lowercase ASCII region labels and explicit Kiro model `baseUrl` overrides are unchanged.
- Kiro Builder ID device-code login no longer aborts on the first poll. AWS SSO OIDC `CreateToken` reports the in-progress states (`authorization_pending`, `slow_down`) as HTTP 400 responses whose body carries the error code, but the poll loop went through the shared `fetchOidc` helper that throws on any non-2xx status, so the `authorization_pending` branch it already implemented was unreachable and every login failed within one interval of printing the verification URL. The poll now reads the JSON payload before classifying the response; non-2xx responses without an `error` field still fail closed.

## [0.15.6] - 2026-08-30

### Added

- `AuthGatewayServerOptions` now requires `providerScope`; `AuthGatewayBootOptions` requires the provider-filtered `listModels` callback and an exact-catalog-object `resolveModel`. Direct `@gajae-code/ai` callers must construct one gateway instance per provider and pass a provider-filtered source catalog. This matches the mandatory `--provider=<id>` CLI migration and prevents cross-provider model and credential ambiguity.
- `AuthGatewayBootOptions` now requires live authority callbacks (`hasProviderCredential`, `reloadProviderCredentials`, and `validateProviderCredential`). Gateway dispatch holds the authority lease through `streamSimple()` admission and rejects credentials revoked during asynchronous selection instead of sending a stale key.
- `auth-broker serve` now requires an `AuthCredentialStore` with atomic `allocateMonotonicSequence` support for durable broker incarnation epochs; unsupported custom stores fail closed before binding and must migrate to the durable cache-backed contract.

### Fixed

- Cursor HTTP/2 streams now drain admitted exec responses before normal teardown and centralize terminal failures, preventing delayed handlers and retained shell callbacks from writing after the request has ended.
- Auth-gateway boot and dispatch are now provider-scoped: model catalogs reject cross-provider id ambiguity, Codex rows retain `openai-codex-responses`, and requests cannot borrow credentials from another provider.
- Broker-backed gateway dispatch leases now remain held until the provider's transport-admission boundary, preventing lazy stream construction from releasing authority before outbound dispatch.
- Kiro (Amazon Q Developer / CodeWhisperer) OAuth is now fully wired end-to-end: `AuthStorage.login("kiro", ...)` previously had no dispatch case despite `kiro` being advertised in `getOAuthProviders()`, so every advertised login path (`gjc auth-broker login kiro`, the interactive `/login` provider picker, direct `@gajae-code/ai` CLI `login kiro`) failed with `Unknown OAuth provider: kiro`. `mapOptionsForApi()` also had no case for `kiro-codewhisperer-stream`, so any chat call on a Kiro model threw `Unhandled API in mapOptionsForApi` regardless of auth method. The bundled model catalog had no `kiro` entries at all, leaving OAuth-only users with an empty model list; the provider descriptor's default model id also did not match any catalog entry. The OAuth CodeWhisperer request now also carries `modelId` in every wire message, matching the sibling API-key transport's request shape (issue #5064).

## [0.15.5] - 2026-08-29

### Added

- The built-in `kiro` provider now accepts long-lived `KIRO_API_KEY` values (`ksk_…` from [app.kiro.dev](https://app.kiro.dev/settings/api-keys)) in addition to AWS Builder ID OAuth. API-key auth talks to the Kiro service root with `tokentype: API_KEY` and discovers the live model catalog via `ListAvailableModels`. Builder ID login (`gjc auth-broker login kiro` / `AWS_BEARER_TOKEN_KIRO`) is unchanged.

### Fixed

- The generic OpenAI Responses transport now preserves the typed `server_is_overloaded` code from an HTTP 200 terminal envelope as transport facts (`openaiErrorCode` / `providerCode`), and that statusless code classifies as a `server` fallback trigger. Both terminal shapes that carry the structured failure are covered: `response.failed`, and `response.completed` whose response `status` is `failed` (including the nested `status_details.error` form). Previously the envelope became a plain `Error`, so the only structured evidence of a capacity rejection was lost and consumers had to read provider prose. The code is matched case-sensitively and exactly, so near misses (`server_is_overloaded_now`), case variants (`SERVER_IS_OVERLOADED`), padded variants, and a `cancelled` response carrying the same code all stay untyped and unclassified; the displayed error message is unchanged in every case. The shared Azure Responses path inherits the same parsing. (#5018)
- Kiro credential selection now rejects control-character injection and keeps non-`ksk_` values on the Builder ID bearer path. API-key failures redact the credential before reaching assistant error output, and the transport accepts provider header overrides without changing the documented endpoint contract.
- API-key model discovery also retains the contributor-supplied static catalog for offline print-mode resolution, while live `ListAvailableModels` results remain authoritative when available.
## [0.15.4] - 2026-08-29

## [0.15.3] - 2026-08-27

### Fixed

- Valid JSON `\uXXXX` tool arguments now execute as their canonical decoded strings instead of entering the escaped-non-ASCII resample loop. This intentionally treats every syntactically valid decoded scalar as canonical; runtime validation cannot infer whether a valid hex digit differed from the model's intent. Provider adapters retain guard metadata for malformed escape-bearing JSON, duplicate/deep suspicious escape evidence, and unpaired UTF-16 surrogates, while standard escaped Hangul, emoji surrogate pairs, and printable ASCII no longer consume retries or terminate managed runs.
- Explicit positive `maxTokens` values declared for custom `models.yml` models
  and model overrides now reach the provider request across the shared stream
  mapping (`max_tokens`, `max_completion_tokens`, and `max_output_tokens`).
  Built-in and discovered metadata retain the conservative 32,000-token default,
  while positive per-request overrides keep precedence; `compat.extraBody` is
  not required to alter the wire budget.
- `/login vllm` no longer stores the `vllm-local` no-auth sentinel as a persisted API key. `AuthStorage.getApiKey()` resolves stored `api_key` credentials before environment variables, so a stored sentinel from an empty login could outrank a real `VLLM_API_KEY` env var and reach normal inference. `/login vllm` now requires a real API key (empty input throws `vLLM API key is required; local no-auth servers are discovered automatically`); local no-auth servers remain discovered automatically via the descriptor's `allowUnauthenticated` flag and need no login.
- `classifyContextOverflow` no longer misclassifies Anthropic context overflow as a terminal request error. Anthropic reports overflow inside a generic `invalid_request_error` envelope (`{"type":"invalid_request_error","message":"prompt is too long: 1158066 tokens > 1000000 maximum"}`), and that envelope type was listed as an authoritative non-overflow code, so it vetoed classification before the `prompt is too long` match could run. Overflow was then treated as a terminal 4xx and auto-compaction never ran. The envelope is now separated from cause-naming codes (auth, quota, rate limit), which keep full veto authority. To preserve the existing hostile-prose defense, only Anthropic's self-verifying measured form (`<used> tokens > <limit> maximum`, where the reported usage actually exceeds the reported maximum) can override the envelope; loose prose such as `too many tokens` still cannot flip a typed transport classification.
- The OpenAI↔Anthropic compatibility shim (Kimi Code, Synthetic) no longer drops the model's `thinking` metadata when routing an OpenAI-compatible model through the Anthropic Messages API. The shim rebuilt the Anthropic model descriptor field-by-field and omitted `thinking`, so a reasoning-capable model such as `kimi-code/k3` failed every effort-qualified request with `Model kimi-code/k3 is missing thinking metadata` (`getSupportedEfforts` throws when a reasoning model lacks thinking metadata). The descriptor now copies `model.thinking` through, restoring effort validation and the effort→`budget_tokens` mapping for the Anthropic-format route.

## [0.15.2] - 2026-08-25

### Changed

- Version 0.15.1 was tagged but never published: release automation failed while deriving release notes, before any package reached npm. Everything listed under `## [0.15.1]` below ships in this release.

## [0.15.1] - 2026-08-25

### Added

- Added an `sglang` provider for local OpenAI-compatible servers: its bundled provider descriptor discovers a running SGLang server at `http://127.0.0.1:30000/v1` implicitly, with hardened discovery (`redirect: "error"`, a 500ms loopback probe timeout, and `max_model_len` accepted only as a safe positive integer). `SGLANG_API_KEY` / `SGLANG_BASE_URL` follow the trusted env conventions used by vLLM. Local no-auth discovery needs no stored credential; `/login sglang` stores only a supplied API key, and discovery-only SGLang catalogs are never bundled into release defaults.
- Added Kilo's `stealth/ox-alpha` model with its reviewed 1,048,576-token context, 131,072-token output ceiling, text/image input, and low/high/max reasoning-effort contract.

### Fixed

- Exact ID-selected stored literal API keys can now authorize existing model-cache provenance without resolving or exposing secret bytes; command-backed rows, stored environment references, OAuth, runtime overrides, and config overrides remain ineligible, while an explicitly selected stored row keeps precedence over provider environment fallback.
- Tool-call parsing now preserves bounded, payload-free raw `\uXXXX` position/scalar evidence across provider adapters. Printable ASCII escapes are included because a one-nibble mutation can move an intended non-ASCII scalar into ASCII before decoded-value validation. Process-keyed scalar/path tags, raw and decoded offsets, value ordinals, duplicate-key/depth rejection, total-position accounting, and a process-local integrity tag make partial, altered, malformed, or overflowed evidence explicitly fail-closed without retaining recoverable argument characters or field names (#4927).
- Hid the non-callable `google-antigravity/gemini-3.7-flash-{low,medium,high}` selectors from bundled, dynamic, and cached catalogs after live Cloud Code Assist calls returned HTTP 404; `google-antigravity/gemini-3.7-flash-tiered` remains available and callable.
- Ollama Cloud discovery now keeps curated output limits authoritative and gives unknown models a bounded 32,000-token fallback capped by their discovered context window. This replaces the truncation-prone 8,192 fallback without treating the server context length as a verified 131,072-token output capability or sending unbounded `num_predict` requests. Hosted cold starts and long prefills also receive a 300-second first-event window while explicit timeout overrides keep precedence (#4921).
- Direct model selections now retry zero-token empty OpenAI-compatible responses.
- OpenAI-compatible chat streams now replay an exact `finish_reason: "network_error"` only when no text, reasoning, refusal, or tool-call delta has been exposed. Retries honor `streamMaxRetries`, exponential backoff, caller cancellation, and managed-fallback ownership; failed-attempt usage, cost, response IDs, and partial chunks are discarded while terminal error wording remains compatible (#4918).

- Cursor `requestContext` rules now forward normalized system prompts, Cursor HTTP/2 transport honors standard proxy environment variables, and GPT effort siblings are sent as their base model with the corresponding reasoning parameter.
- `AuthStorage.getEarliestUnblockAt(provider)` now exposes the earliest stored credential `blockedUntil` instant so quota exhaustion can report when a row becomes usable again without waiting for it (#4908).
- vLLM's `allowUnauthenticated: true` now lives on the descriptor itself, not only inside its `catalogDiscovery` config. The runtime discovery gate in `packages/coding-agent/src/config/model-registry.ts` checks `isAuthenticated(apiKey) || descriptor.allowUnauthenticated`, so a local no-auth vLLM server previously needed a credential (`VLLM_API_KEY` or `/login vllm`) before its models would be discovered — unlike lm-studio/omlx, which already carry the descriptor-level flag. Catalog-generation behavior is unchanged.

## [0.15.0] - 2026-08-22
- A failed dynamic-model refresh no longer blanks a legacy cache row in an unbound provider context. `resolveProviderModels` only reused the last-known rows when the latest cache row was provenance-bound to the current discovery context, so a provider that supplies no `cacheDynamicModelProvenance` (e.g. the Codex family) lost every cached model on a refresh failure AND had its row overwritten with an empty snapshot — the stale-while-error fallback the surrounding code documents never applied to it. Legacy rows now serve through a failed refresh whenever the request context is unbound; bound contexts still fail closed on foreign rows.
- Added OpenRouter as an API-key login provider in `/login` (`openrouter`). Pasting an `sk-or-v1-...` key validates against `https://openrouter.ai/api/v1` (`openrouter/auto` chat completion probe) and stores a reusable `OPENROUTER_API_KEY` credential, closing the gap where OpenRouter had catalog/env support but no interactive login entry point.
- Fixed `/logout` (and `gjc accounts logout`) silently ignoring stored API-key credentials. Removal-target enumeration and hard removal were both scoped to `credential_type = 'oauth'` rows, so API-key logins (OpenCode Go/Zen, Cursor, Venice, DeepSeek, …) could never be removed and the flow answered `API-key credentials are not managed here`. Removal targets now include every stored row, `removeAuthCredentialsHard` accepts non-OAuth rows, and the interactive/CLI logout removes stored credentials of either kind.
- The auth-broker presentation sidecar default is now derived when a `RemoteAuthCredentialStore` is constructed instead of once at module import (#4786). The trusted config root has been call-time state since #4761/#4772, so the import-time constant kept pointing at the home in effect when the module first loaded; a process whose home was established or changed after load read and wrote one logical profile through two different roots — the same split that made user-scope skills and MCP disappear, one layer out, with credential-coherence impact since `<configRoot>/.env` is one of the files `$credentialEnv` treats as trusted. Explicit `presentationPath` options are unchanged, and the E2E `testauth.db` helper derives its path at use time for the same reason.
- OpenAI Responses-family providers (`openai-responses`, `azure-openai-responses`, `openai-codex-responses`) now batch consecutive tool results so every `function_call_output`/`custom_tool_call_output` of one assistant tool-call turn stays contiguous before a single collected image user message, instead of emitting a standalone image user message after each individual output (#4807). The interleaved form made an OpenAI Responses→Anthropic Messages proxy (e.g. `cliproxyapi`) see a `tool_use` without its `tool_result` in the immediately following user message, and every replay of the poisoned tail failed with a deterministic HTTP 400. Call-id pairing, result arrival order (including reverse order), custom-tool outputs, text-only runs, and single-result shapes are unchanged; non-vision models still degrade to the image placeholder. Each result's image group inside the collected message is labeled with its `call_id` so parallel results keep image-to-call attribution.
- OpenAI-family idle watchdog floors now key on the Grok model as well as the provider: Grok model ids served through any OpenAI-compatible host (openrouter `x-ai/grok-*`, kilo, litellm, zenmux, venice …) get the same 300-second idle window as native xAI and Grok Build, so a long Grok reasoning gap no longer surfaces as `OpenAI completions stream stalled while waiting for the next event` under the 120-second shared default (#4797). Env overrides still win; non-Grok models are unchanged.
- Codex stale-continuation recovery now also recognizes prose anchor references — `Previous response with id 'resp_1' not found.`, `The previous response 'resp_1' has expired.`, `Unknown previous response 'resp_1'.` — when the specific stale code is masked to `invalid_request_error` by codex-lb (the same masking already handled for `codex_previous_response_stale`) or omitted entirely (#4802). The #4752 matcher required the compact `previous_response_id` field token, so these shapes reached users as fatal `invalid_request_error` events. Prose matching is tempered against sub-field tokens (tool/function/custom-tool call, call/message/item id, output item): a fault naming something INSIDE the previous response (`Unknown item in previous response.`) is a deterministic history fault and stays fatal, since replaying full context re-sends the same offending item. Retry semantics are unchanged and remain one-shot with full context, gated on the failed request actually having carried an anchor.
- GLM ZCode OAuth now refreshes its authenticated `/v1/models` catalog automatically, so newly available GLM models are selectable without waiting for the bundled catalog to catch up. Discovery preserves bundled model metadata, sanitizes and bounds every remote display name, rejects catalog entries whose model IDs cannot be handled safely (control-bearing, blank, or overlong IDs are dropped, never renamed — model-selector identity is rendered verbatim), uses the same trusted `ZCODE_PLAN_ANTHROPIC_BASE_URL` decision as model requests, and refreshes legacy static-only cache rows once when live discovery becomes available.
- Terminal provider safety-stop authority is now adapter-minted provenance instead of a wire-assignable field: a package-private, module-branded capability lets only first-party adapter parse sites mint authority from a structured refusal signal they actually validated (Anthropic `stop_reason` refusal/sensitive, OpenAI `content_filter`, Google prompt/candidate block reasons), while the public surface exposes only `isProviderSafetyStopAuthenticated` (#4777). Managed runtime rebuilds keep their own module-private destination set; public consumers cannot transfer authority from a genuine source to an arbitrary object. Unrecognized signals fail closed with no kind and no authority, so an adapter bug degrades to ordinary fallback rather than a forced refusal; clones, JSON/persistence round-trips, reloaded messages, and custom streams cannot mint authority from public imports or structural fields. The anthropic, openai-completions, google-shared, and google-gemini-cli adapters now mint through the private path instead of assigning `errorKind` directly.
- The safety-stop mint module is now unreachable through the package export map: `./adapter-internals/*` resolves to a null export, so the `"./*"` wildcard can no longer deep-import `mintProviderSafetyStop` or the adapter capability, and public consumers keep only `isProviderSafetyStopAuthenticated` (#4777 review). Pi-native SSE payloads no longer regain safety-stop authority from a caller-controlled fetch or loopback URL; serialized gateway messages stay unauthenticated until the protocol has an authenticated gateway envelope.
- Public `stream()` callers can no longer clone a bundled model and redirect its `baseUrl` while still receiving the runtime adapter-invocation token. Safety-stop minting now requires an unchanged bundled model identity and endpoint fingerprint; custom, redirected, or mutated models remain fallback-eligible (#4777 review).
- Low-level public provider adapters are now fail-closed parser seams: only the first-party `stream()` dispatcher supplies adapter provenance, while direct adapter calls (including bundled or manually constructed models) remain fallback-eligible. This prevents mutable global or caller-selected transports from minting terminal safety-stop authority; callers requiring terminal classification should use `stream()`/`streamSimple`.
- Kimi Code, Synthetic, and GitLab Duo wrapper dispatches now preserve the runtime safety-stop invocation provenance into their inner Anthropic/OpenAI adapters, so genuine structured refusals remain terminal without making wrapper options caller-mintable (#4777 review).
- Google candidate and prompt safety refusals now remain terminal across later benign finish reasons even when caller-selected transport prevents provenance minting; the result stays an untyped error instead of flipping to `stop`/`toolUse` (#4777 review).
- Codex stale-continuation recovery now classifies anchor rejections by provider message as well as by error code, so a provider event shaped `{"type":"error","error":{"type":"invalid_request_error","code":"invalid_request_error","message":"Invalid `previous_response_id`."}}` clears `previous_response_id` and the websocket append state and retries exactly once with full conversation context instead of terminating the active session (#4752). Previously only the `previous_response_not_found` and `codex_previous_response_stale` codes (#731) were recognized, and this shape reached users as a fatal `Codex error event: Invalid \`previous_response_id\`. (code=invalid_request_error)`. Three properties bound the new retry: `invalid_request_error` stays in the non-retryable code set so a generic invalid-request failure that does not implicate the anchor remains fatal; classification reads a new `CodexProviderStreamError.providerMessage` (the raw provider text) rather than the display message, because the display message appends `(code=…)` metadata that would otherwise supply a stale qualifier the provider never sent; and the matcher requires the canonical `previous_response_id` field token, so deterministic history faults such as `Previous response's tool call ID is malformed.` stay fatal instead of replaying full context. Recovery additionally requires that the failed request actually carried an anchor (`sentPreviousResponseId`, tracked from the dispatched websocket request), so a rejection naming the field on an anchor-free request — `Invalid request: previous_response_id is required` on a first turn or after an append reset — stays fatal instead of clearing valid session metadata and resending an identical non-retryable body. Recovery is one-shot per turn (`previousResponseRecoveryAttempted`) — once the anchor is cleared the replay carries no anchor, so a repeated rejection surfaces rather than consuming the five-attempt provider retry budget on full-context replays.
- Anthropic streaming now distinguishes a tool call that merely passed through an incomplete JSON fragment from one orphaned by a duplicate content-block index. Membership in the truncation set alone is not evidence that a terminal `tool_use` call is incomplete, so normally completed calls remain executable while genuine orphaned calls stay blocked.
- OpenAI-family streams now give xAI Grok and the Grok Build (`grok-cli-responses`) wrapper the same 300-second default idle window as Anthropic, so long Grok reasoning gaps no longer surface as `OpenAI responses stream stalled while waiting for the next event` under the 120-second OpenAI default. Env overrides still win. The observed stall was `grok-build/grok-4.6` on `openai-responses`; keying only `xai` would have left that path on 120s because `streamGrokCli` keeps `model.provider === "grok-build"`.
- `getCachedUsageReport` now surfaces provider-level cached usage reports for stored API-key credentials, not only OAuth rows. `checkCredentials` fetches and caches usage for API-key providers (for example `zai`, whose login flow stores an API key by design), but the display lookup rejected every non-OAuth row, so `/usage` and account listings could never show usage data that had been successfully fetched and cached. The lookup builds the same cache identity `checkCredentials` writes, and the returned observation stays redacted — credential bytes never appear in the cached report.
- Anthropic clients now set an SDK request `timeout` derived from the first-event window (`resolveAnthropicSdkRequestTimeoutMs`; 300s by default for Anthropic, floored at the env/default first-event window, disabled by an explicit `streamFirstEventTimeoutMs: 0`). The Anthropic first-event watchdog deliberately arms only after response headers arrive, so a connection that silently died before headers — the exact failure mode of recent Anthropic stream instability right after a completed tool call — was previously bounded only by the SDK's 10-minute default per attempt multiplied by its internal retry budget, observable as an endless "Working…" spinner for up to an hour with no error, no retry indicator, and no automatic recovery. This mirrors the existing `resolveOpenAISdkRequestTimeoutMs` stalled-before-headers bound on the OpenAI family.
- Anthropic `input_json_delta` and Codex `function_call`/`custom_tool_call` argument increments now fail the turn closed for every non-string value instead of continuing with missing, default, or silently altered tool arguments. Primitive thinking/text/signature anomalies still degrade to an empty string, and each stream emits at most one payload-free diagnostic per increment type naming only the envelope (`deltaType`/`eventType` and `receivedType`).
- Anthropic-compatible and Codex stream handlers now coerce non-string prose, thinking, and signature increments to an empty string before emitting `*_delta` events, so a Z.AI or Codex thinking delta that arrives as `undefined` or a numeric token count cannot produce a non-string `delta` that managed snapshot staging rejects as `event.delta`. Executable tool-argument fragments remain fail-closed for every non-string shape. Anthropic `signature_delta` likewise appends only string signatures, so a numeric or missing signature cannot pollute `thinkingSignature` as `"1"` / `"[object Object]"`.
- Added the `ask-round-zero-metadata-requires-full-topology-fields` raw-argument rejection code so the ask tool's Round-0 deep-interview validator can name the omitted topology fields and their correction; previously the incomplete-object failure surfaced only as generic zod issues with a full payload echo (#4649).
- oMLX OpenAI-compatible completions now send `chat_template_kwargs.reasoning_effort` with `enable_thinking` when `thinkingFormat` is `qwen-chat-template`. Discovered oMLX models are treated as reasoning models with `low`/`medium`/`high` effort so local Qwen presets can differentiate roles without swapping weights.
- Fixed a resume-breaking HTTP 400 on `google-gemini-cli`/`google-antigravity` replay: assistant thinking blocks whose `thinkingSignature` is missing, empty (persistence clears oversized signatures to `""`), or invalid no longer emit an unsigned `{"thought": true}` part. Cloud Code Assist maps such parts to Anthropic `thinking` blocks and rejects the whole request with `messages.N.content.0.thinking.signature: Field required`, permanently bricking resumed sessions (#4630). Unsigned thinking now degrades to plain text — the same treatment cross-model reasoning already gets — while validly signed thinking still replays natively as a thought part with its `thoughtSignature`.
- `validateApiKeyAgainstModelsEndpoint` no longer accepts an API key on HTTP status alone. A 200 whose body is not JSON or carries no recognizable model list (OpenAI-compatible `data` array, gateway `models` array, or a bare array) now fails closed with an actionable error — previously a captive portal or broken gateway answering 200 with an HTML page silently validated and stored the key. Affects every provider using `kind: "models-endpoint"` (Synthetic, DeepSeek, DeepInfra, Fireworks, BizRouter, NanoGPT, OpenGateway, ZenMux, Fugu). Upstream bodies echoed into validation errors are now bounded to 200 characters on both validators.
- `ToolCall.escapedNonAsciiArguments` doc updated: the agent loop resamples unconditionally then rejects terminally, with a single bounded after-budget exception for tools that enumerated display fields (`displaySafeEscapedArgFields`) whose non-ASCII content is benign typographic punctuation. The scanner itself is unchanged and still flags every non-ASCII escape (#4627).
- The auth-gateway `/v1/chat/completions` request schema now accepts explicit `null` for unset optional fields and for message `content`. Clients that serialize an omitted option as `null` (Aside, LangChain, LiteLLM, Vercel AI SDK style serializers) — a shape api.openai.com accepts — were rejected with a zod `invalid_union` 400 before a single token streamed, surfacing in client UIs as a generic connection failure. `null` is now collapsed to `undefined` at the schema boundary (and to `""` for required `system`/`developer`/`user` content), so every downstream consumer keeps the existing `T | undefined` shape.

## [0.14.2] - 2026-08-20

### Fixed
- Grok Build now gets the same 300s idle window as other long-turn providers, so turns no longer stall waiting on a shorter default.
- `getCachedUsageReport` surfaces cached usage for API-key credentials, not only OAuth accounts (#4686).
- The auth gateway accepts explicit `null` fields on openai-chat requests instead of rejecting the payload (#4667).

## [0.14.1] - 2026-08-18
- Anthropic clients now set an SDK request `timeout` derived from the first-event window (`resolveAnthropicSdkRequestTimeoutMs`; 300s by default for Anthropic, floored at the env/default first-event window, disabled by an explicit `streamFirstEventTimeoutMs: 0`). The Anthropic first-event watchdog deliberately arms only after response headers arrive, so a connection that silently died before headers — the exact failure mode of recent Anthropic stream instability right after a completed tool call — was previously bounded only by the SDK's 10-minute default per attempt multiplied by its internal retry budget, observable as an endless "Working…" spinner for up to an hour with no error, no retry indicator, and no automatic recovery. This mirrors the existing `resolveOpenAISdkRequestTimeoutMs` stalled-before-headers bound on the OpenAI family.
- oMLX OpenAI-compatible completions now send `chat_template_kwargs.reasoning_effort` with `enable_thinking` when `thinkingFormat` is `qwen-chat-template`. Discovered oMLX models are treated as reasoning models with `low`/`medium`/`high` effort so local Qwen presets can differentiate roles without swapping weights.
- Fixed a resume-breaking HTTP 400 on `google-gemini-cli`/`google-antigravity` replay: assistant thinking blocks whose `thinkingSignature` is missing, empty (persistence clears oversized signatures to `""`), or invalid no longer emit an unsigned `{"thought": true}` part. Cloud Code Assist maps such parts to Anthropic `thinking` blocks and rejects the whole request with `messages.N.content.0.thinking.signature: Field required`, permanently bricking resumed sessions (#4630). Unsigned thinking now degrades to plain text — the same treatment cross-model reasoning already gets — while validly signed thinking still replays natively as a thought part with its `thoughtSignature`.
- `validateApiKeyAgainstModelsEndpoint` no longer accepts an API key on HTTP status alone. A 200 whose body is not JSON or carries no recognizable model list (OpenAI-compatible `data` array, gateway `models` array, or a bare array) now fails closed with an actionable error — previously a captive portal or broken gateway answering 200 with an HTML page silently validated and stored the key. Affects every provider using `kind: "models-endpoint"` (Synthetic, DeepSeek, DeepInfra, Fireworks, BizRouter, NanoGPT, OpenGateway, ZenMux, Fugu). Upstream bodies echoed into validation errors are now bounded to 200 characters on both validators.

- OpenAI Codex requests now sanitize OS-derived `User-Agent` components, preventing non-ASCII Android kernel release names from being rejected as invalid HTTP headers.
- Kimi OAuth requests now sanitize OS-derived `X-Msh-Device-Name`/`X-Msh-Device-Model`/`X-Msh-Os-Version` header values, preventing non-ASCII hostnames and kernel release names (e.g. Android `Minimal™` builds) from being rejected as invalid HTTP headers. `getKimiCommonHeaders` now memoizes a pure `buildKimiCommonHeaders()` builder.

## [0.14.0] - 2026-08-17
- Cursor native tool calls (shell/read/write/… oneof variants) now convert their protobuf payloads into plain JSON-safe data before attaching them as toolCall `arguments`: `$typeName` markers are stripped, safe-range bigints become numbers (decimal strings beyond `Number.MAX_SAFE_INTEGER`), byte arrays become base64 strings, and cycles/functions collapse to null. Raw protobuf-es payloads carry `bigint` fields (`fileSize`, `durationMs`, `fileOutputThresholdBytes`, …) that defeat `JSON.stringify`, which broke managed snapshot staging, JSONL transcript persistence, and provider replay — the issue #4578 local-snapshot producer defect class fixed at its producer boundary.
- Generic OpenAI-compatible `/v1/models` discovery now reads served context-window and output-limit metadata instead of defaulting every dynamically listed model to the unknown-window sentinel. `max_model_len` (vLLM/SGLang/oMLX), `context_length`, `context_window`, `max_context_length` (LM Studio), and `max_position_embeddings` populate `contextWindow` in that precedence order, while `max_tokens`/`max_output_tokens` populate `maxTokens`; total-window fields never leak into the output-token ceiling. Malformed values (non-finite, zero, negative, non-numeric) are rejected per-field with fallback to the next candidate, so a `1e400`-style catalog entry can no longer poison compaction thresholds or compact-input budgets.
- Codex websocket requests now abort and close their transport when the downstream event-stream consumer returns early (including managed provisional-buffer rejection), so the next turn opens a clean connection instead of inheriting `websocket request already in progress` (#4534).
- Refreshed the bundled ZAI catalog with GLM-5.3 and made it the provider's default model.
- Added the typed `local_snapshot_failure` and `local_buffer_overflow` assistant error kinds so downstream retry policy can distinguish local event-snapshot and staging-buffer failures from provider failures.
- Anthropic first-event timeouts now report safe elapsed time, serialized request bytes, canonical-vs-custom endpoint class, and the `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` override without exposing URL credentials, query tokens, or body content. Large requests through custom endpoints receive one bounded two-minute observation grace so a slightly later proxy 529 can surface without extending explicit-zero, small-request, or canonical deadlines; full-window multi-megabyte requests are never automatically re-uploaded and small requests get at most one session replay. Credit: @probepark (#4464).
- A ceiling-bound Anthropic upload that fails before stream iteration begins (for example an immediate 529 surfacing from response setup) now carries the one-attempt upload ceiling to the outer provider retry loop as well. Previously only the SDK's internal retries were suppressed for these requests, so the multi-megabyte body could still be re-uploaded up to the default `streamMaxRetries` budget. The delayed-setup grace test was also rescaled from a 1ms window/5ms setup pair — which made the grace-boundary outcome a coin flip on runner scheduling latency — to a regime where the contract is decidable, with a new complementary test proving an in-window 529 after delayed setup keeps its ordinary retry budget. Credit: @probepark (#4464).
- Unknown Anthropic stream rejections are normalized to a mutable `Error` before retry facts are stamped. An injected custom client rejecting `withResponse()` with a primitive string previously had its facts assigned onto a temporary boxed value — silently discarding them — so a ceiling-bound multi-megabyte upload slipped past the one-attempt ceiling and a string-matched corrective branch (CPA tool-alias restore) re-uploaded the body. Credit: @probepark (#4464).
- Defense-in-depth: a completed Anthropic stream whose assembled assistant content carries directly adjacent `thinking`/`redacted_thinking` blocks now emits a bounded diagnostic per stream invocation naming only the envelope shape (block count, adjacency presence, model, provider), never raw thinking text, signatures, or redacted payloads. The send-boundary collapse remains the wire source of truth; this is a read-only observation that helps surface upstream producers of the rejected shape (#4443).

- The adjacent-thinking-block collapse now treats `thinking` and `redacted_thinking` as one adjacency class at the final Anthropic send boundary, matching the maintainer-approved send-time invariant (#4425). The earlier replay-phase collapse (#4418) and its test asserted that a `redacted_thinking` block following a `thinking` block survived; the final send-boundary pass (#4425) correctly collapses that pair, and the replay-phase test and doc comment are reconciled to that authoritative behavior (#4382).
- Assistant turns that carry two directly adjacent `thinking` blocks are now collapsed to the first block before replay on `anthropic-messages`. Anthropic rejects that shape with `messages.N.content.M: thinking or redacted_thinking blocks in the latest assistant message cannot be modified`, citing the second block of the pair, and because the offending message keeps its index as the transcript grows, one such turn made every later request in the session fail - observed on two live sessions stuck for 9+ hours, each turn spending two rejected ~1.5 MB uploads, with the cited index frozen (`messages.5.content.118`) while the history grew from 103 to 430 messages. Verified against the captured transcript: the unmodified 430-message replay returns 400 and the collapsed replay returns 200. Thinking blocks separated by a `tool_use` are ordinary interleaved-thinking shape and are preserved, and a `redacted_thinking` blob following a thinking block is untouched (#4416).
- Dev CI now runs each AI test file in a fresh process instead of sharing one Bun test runtime across the package. This prevents leaked fetch spies, fake timers, environment overrides, auth-broker state, and module caches from contaminating later files while using the same bounded, root-preloaded harness as coding-agent shards (#4378).
- The deterministic Anthropic cache-eval fixture moved from the untracked root `artifacts/` directory to `packages/ai/test/fixtures/issue-3670-anthropic-cache-eval.json` where test fixtures belong. The integration test import path is updated accordingly (#4420).
- Anthropic thinking-replay repair now fingerprints the exact serialized outbound body before any application-level resend. A no-op latest-assistant transform is skipped in favor of a safe all-assistant transform, and if neither changes the body the turn fails without uploading the same large request again. The rejected request, transform disposition, hashes, sizes, and cited `messages.N.content.M` mismatch are recorded through the existing redacted HTTP-400 capture and warn path; thinking mode and the `context-management-2025-06-27` beta remain unchanged (#4382).
- Anthropic 400 errors that name a `clear_thinking_*` context-management strategy now explain when GJC's captured outgoing body contains neither `thinking` nor `context_management`: an intermediary at the redacted configured base URL likely injected the strategy. The diagnostic recommends explicitly enabling thinking or fixing/replacing the intermediary, never silently enables thinking or retries, and annotates the sanitized raw-request capture without changing its body. Credit: @probepark (#4380).
- Anthropic streams now repair the CPA Claude-OAuth "cannot restore tool alias" 500 instead of blindly resending the unchanged request: the exact SSE signature is classified, the base tool name is extracted, and the request is corrected exactly once with steering that names the unique callable tool (or directs tool discovery when no unique match exists). Recurrence surfaces an actionable terminal error with no transport facts, so neither the provider generic 5xx retry nor the managed fallback controller re-sends; managed attempts record the steering against the same turn and the next attempt applies it (#4338).
- Tool calls whose raw argument JSON spells a printable non-ASCII character as a `\uXXXX` escape instead of literal UTF-8 are now flagged with `ToolCall.escapedNonAsciiArguments`. Such a payload parses cleanly but is unverifiable — one mistyped hex digit decodes to a different, equally valid character — so the agent loop rejects it instead of executing silently corrupted text. Required control escapes and lone surrogates never trip the flag, and `\\uXXXX` (the source syntax of code being written) is not an escape and is ignored. New `findUnnecessaryUnicodeEscape` helper in `utils/json-parse`. The Kimi tool-call healer samples the signal from the raw leaked payload before its normalizing JSON round-trip, which would otherwise decode the escapes and erase the evidence.
- Persist learned tool-choice incapabilities in a bounded, expiring, digest-keyed cache so fresh processes avoid repeating known-invalid forced-choice probes while retaining automatic revalidation and existing first-discovery fallback behavior. Credit: @probepark (#4319).

### Added
- Added first-class support for oMLX (Apple Silicon MLX local inference server), including automatic discovery at `http://127.0.0.1:8080/v1`, `OMLX_BASE_URL`, and `OMLX_API_KEY`.

- Added first-class direct xAI `grok-4.6` catalog support over the existing xAI OAuth/subscription transport. Grok 4.5 now exposes exactly `low` through `high` reasoning effort, Grok 4.6 exposes exactly `low` through `xhigh`, and both serialize the selected level through `reasoning_effort`.
- `AuthStorage.switchSessionCredential(provider, sessionId, selector)` forces a running session's OAuth credential for a provider to a specific stored row, independent of quota/rate-limit state — backing the coding-agent `/credential` slash command for a manual mid-session account switch (as opposed to the existing automatic quota-triggered fallback). Mutates only the session-scoped sticky pointer keyed by `sessionId` (never a provider-wide runtime override), so it cannot bleed into other sessions with a different credential identity; subagents/team workers inherit the parent's credential identity by design and switch with it. Fails closed when a stronger override already re-decides the provider's credential every call (`--credential` hard pin, `--api-key` runtime override, or a config-sourced `models.yml` `apiKey`), and deliberately leaves credential-blocked state untouched so a switch to a still-backoff-blocked row safely falls back to a usable account instead of drawing another 429/quota error.

- Added the authoritative OpenRouter `meta/muse-spark-1.2` catalog fallback with a 1,048,576-token context window and `minimal` through `xhigh` reasoning effort, so stale or credential-limited catalog generation still closes the Muse Spark preset alias deterministically.
- `AuthStorage` supports a soft, per-provider preferred OAuth credential (`setRuntimePreferredCredentialSelector` / `hasRuntimePreferredCredentialSelector` / `removeRuntimePreferredCredentialSelector`, plus `AuthApiKeyOptions.preferredCredentialSelector`) that backs the coding-agent `--prefer-credential` CLI flag. A usable preferred row is placed ahead of the provider's normal balanced/earliest-reset ranking; a content-free quota or rate-limit failure marks it blocked and rotates to another active credential immediately, same as the existing session-stickiness fallback. It is mutually exclusive with the existing hard `setRuntimeCredentialSelector` pin (`--credential`) for the same provider, and `resolveRuntimePreferredCredentialSelectorProvider` resolves an unqualified selector to its single matching active OAuth provider or fails closed on ambiguity.

### Changed

- Documented multi-account auth behavior: credential ranking (`balanced` or `earliest-reset`) runs at session start or after a blocked preferred account, explicit OAuth checks run sequentially, and API-key sources remain visible/checkable without entering OAuth pooling, pinning, or removal.

- Model discovery now retains the authoritative dynamic provider model IDs separately from the merged static/cache catalog. Consumers can distinguish a fresh provider omission from bundled offline availability through `ModelResolutionResult.dynamicModelIds`; cache schema v5 persists those IDs through fresh-cache reuse and static transport re-merges, scoped to the credential-and-endpoint provenance that produced them.

### Fixed

- Cursor OAuth `GetUsableModels` discovery now reads the live million-token window from model display names and aliases (`Claude Opus 5 1M Thinking`) instead of keeping the bundled 200k default. `GetUsableModels` still has no numeric `context_window` field, so the named window is the authoritative live signal; larger bundled fallbacks such as Gemini's 1048576-token window are preserved.
- Grok Build `/usage` now uses the weekly credits quota when the monthly billing endpoint reports a zero limit, avoiding misleading `100% free` and `used/0` output.
- A deterministic Anthropic thinking-replay rejection now converges under a managed fallback attempt instead of repeating forever (#4262). Every coding-agent turn prompts with `fallbackManaged: true`, and the whole in-provider thinking-replay repair sits behind `!options?.fallbackManaged` because the fallback controller owns retries — the shipping CLI therefore never repaired anything: each turn rebuilt the same replay from the same history, drew the same 400, and the session burned one rejected request per turn without ever self-healing (reported as ~1 rejected 1.3 MB request every 12s, ~300/h, never converging). The provider still does not retry inside a managed attempt — it records the full-history repair escalation on the provider session state instead, so the next managed attempt builds a repaired replay at the cost of zero extra round trips. Only the two deterministic rejections (`blocks ... cannot be modified`, ``Invalid `signature` in `thinking` block``) qualify; the proxy-masked generic `api_error` names no cause and may be a transient blip, so it still never costs the session its native replay.
- A long-lived process now recovers when the OAuth row it holds in memory is soft-disabled or replaced in the shared store by a peer (`invalid_grant` disable, credential removal, or a re-login that inserts a new row). The refresh lease answers `missing` for a row that is no longer active, which surfaced as `OAuth refresh credential disappeared` — an error the failure classifier reads as transient, so the vanished row was temp-blocked and retried for the life of the process while a valid re-login row sat unused in the store. Resumed sessions therefore failed every request with the misleading `No credentials found for <provider>` until the CLI was restarted, even though `gjc` had just been logged back in (observed as a per-request refresh-failure flood against `anthropic`). `#tryOAuthCredential` now detects that the attempted row is gone from the store, reloads the snapshot, and re-resolves within the existing reload budget, alongside the peer-rotation recovery it already performed.
- OpenAI Responses streams now preserve canonical terminal function-call arguments when compatible relays such as llama.cpp emit an empty placeholder in `response.output_item.added`. Tool-call correlation also accepts llama.cpp’s `call_id`-only event shape, while conflicting streamed/terminal arguments, malformed terminal JSON, and terminal payloads that decode to something other than a JSON object fail closed instead of reaching execution. Argument source precedence is terminal item, then streamed deltas, then the `output_item.added` snapshot, so a relay that only ever populates the added snapshot keeps its real payload.

- Added bundled Gemini 3.7 Flash next to every existing Gemini 3.6 Flash catalog selector (`google`, `google-gemini-cli`, `github-copilot`, `google-antigravity` effort variants, `opencode-zen`, `openrouter`, `vercel-ai-gateway`, `cursor`, `kilo`, `venice`). Gemini 3.7 Flash accepts only `low`, `medium`, and `high` thinking levels; `minimal` is rejected because the official API returns an error, so the Cursor `-minimal` suffix is not cloned.

## [0.13.3] - 2026-08-15

### Added

- Added first-class direct xAI `grok-4.6` catalog support over the existing xAI OAuth/subscription transport. Grok 4.5 exposes `low` through `high` reasoning effort and Grok 4.6 exposes `low` through `xhigh`.
- Added a native TypeScript Kiro (Amazon Q Developer / CodeWhisperer) provider: AWS SSO OIDC device-code login, bearer-token transport to the CodeWhisperer streaming endpoint over `application/vnd.amazon.eventstream`, and a `kiro` model-manager descriptor for Claude 3.7 Sonnet (#4304).
- Added the authoritative OpenRouter `meta/muse-spark-1.2` catalog fallback with a 1,048,576-token context window and `minimal` through `xhigh` reasoning effort, so stale or credential-limited catalog generation still closes the Muse Spark preset alias deterministically.

### Fixed
- Validate Synthetic API key via models endpoint, not retired Kimi probe (#4385).
- Tool-call arguments that spell printable non-ASCII text as `\uXXXX` escapes are now flagged on the raw wire (`escapedNonAsciiArguments`) by the Anthropic, OpenAI Responses, and OpenAI Completions streams — after JSON decode the defect is unobservable, and a mistyped hex nibble silently becomes a different character (#4515).

## [0.13.2] - 2026-08-13

### Fixed

- `clear_thinking`-emptied Anthropic thinking blocks now drop stale signatures before replay, preventing the next request from failing with `Invalid signature in thinking block` after a provider-side reasoning clear (#4247, reported by @probepark).

## [0.13.1] - 2026-08-11

### Fixed

- Anthropic thinking-replay repairs caused by a deterministic rejection now stay in force for the rest of the session instead of being released as soon as the repaired retry succeeds. `thinking`/`redacted_thinking` blocks that draw a 400 (`blocks ... cannot be modified`, `Invalid \`signature\` in \`thinking\` block`) stay in the session history, so releasing the repair made the very next turn replay the same blocks and spend another rejected round trip — every turn, indefinitely. Observed against a proxied Claude Code session as a sustained ~50% 400 rate that never converged. The speculative masked-`api_error` probe is still released on the first completed stream, since that one may have been a transient blip (#4011).
- Anthropic requests no longer spend a rejected round trip discovering that the latest assistant turn cannot replay its thinking block. Anthropic streams a `thinking` block as a start/stop pair with no `thinking_delta` and no `signature_delta` when it withholds reasoning, which lands in history empty and unsigned; `convertAnthropicMessages` then dropped it, and the turn went back carrying only its `tool_use`. Anthropic validates the latest assistant message against the turn it produced and rejects the missing block with 400 `blocks ... cannot be modified`. A captured production request showed exactly this shape — 1214 messages, 29 signed-but-empty thinking blocks preserved, and the latest assistant turn reduced to a bare `tool_use`. The condition is visible locally, so the replay now degrades during the first build instead of after the rejection.
- The unreplayable-thinking detection now correctly excludes non-signing endpoints (DeepSeek, Z.AI), which replay unsigned blocks verbatim and never validate thinking presence, and signed-but-empty blocks, which `convertAnthropicMessages` forwards natively via the signed-thinking path. The original detection treated empty text as always unreplayable, which degraded valid reasoning on non-signing endpoints and dropped natively replayable signed-empty blocks (#4172).

## [0.12.21] - 2026-08-09

## [0.12.20] - 2026-08-09

### Fixed

- OpenAI Responses transports no longer send tool declarations whose names the provider reserves for its own built-ins. OpenCode Zen/Go reject `web_search` as a custom function with `invalid tools in request: custom function name "web_search" is reserved`, and that rejection is request-scoped — one colliding declaration failed the entire tools array before any token streamed, so the bundled `critic`, `planner`, and `architect` agents failed 100% of the time on those providers (#4104). The collision is dropped rather than renamed, because a renamed function tool returns as a `function_call` under the wire alias and that path does not populate `Tool.customWireName`, which would leave the agent-loop dispatcher unable to route the call. `compat.reservedToolNames` overrides the per-provider default.
- Anthropic streams now use a 300-second default idle window so long extended-thinking gaps do not trip the shared 120-second watchdog; explicit stream timeout overrides still take precedence.
## [0.12.19] - 2026-08-08

## [0.12.18] - 2026-08-08

## [0.12.17] - 2026-08-08

## [0.12.16] - 2026-08-08
### Added

- Added opt-in `compat.supportsResponsesSessionAffinity` for OpenAI Responses custom relays. When enabled, supported `openai-responses` models may send `session_id` and `x-client-request-id` affinity headers to a custom endpoint; canonical OpenAI routing remains automatic and known non-OpenAI provider IDs remain excluded.
- Added the `jetbrains-junie` provider, serving JetBrains-hosted models over the documented Ingrazzio gateway `https://ingrazzio-cloud-prod.labs.jb.gg` (#3626). Auth is the officially documented `JUNIE_API_KEY` access token only — no OAuth login flow and no reverse-engineered client credentials. JetBrains AI rejects requests carrying `x-api-key`, so the provider passes `apiKey: null` to the Anthropic SDK and relies solely on the `Authorization: Bearer` header that `buildAnthropicHeaders` already emits for non-Anthropic hosts. The gateway multiplexes transports by family via the `X-LLM-Model` routing header: 7 Claude models on `anthropic-messages` (1M prompt window), 7 GPT models on `openai-completions` and `gpt-5.3-codex` on `openai-responses` (922K and 272K respectively); all cap output at 128K. The GPT lane pins a `/v1`-suffixed base URL because the OpenAI transports append a bare route while the Anthropic one supplies its own prefix. Ids come from Junie CLI's own catalog cross-checked against the 2470.4 jar; Gemini and Grok are excluded because their Grazie translation protocol is not implemented, and the bare `opus`/`sonnet` aliases are CLI shorthands the gateway rejects. Limits are the gateway's probed ceilings, not Junie CLI's smaller per-request budgets.

### Changed

- Forced the OpenAI code (Codex) GPT-5.6 family prompt budget to 372K input tokens: `CODEX_GPT_5_6_CONTEXT_CAP.enforced` is 372K and is applied as a hard override at discovery (`resolveCodexGpt56DiscoveryContext`), generated-catalog policy (`applyGpt56ContextWindow`), and final model-manager cap (`applyFinalCodexGpt56ContextCap`). The live backend metadata still reports the old 272K budget for the tier, so smaller observations are overridden rather than preserved. The bundled `openai-codex` GPT-5.6 Sol/Terra/Luna catalog entries now advertise 372K context (matching `bun run generate-models` output). Non-5.6 codex variants (`gpt-5.5`, `gpt-5.4-codex`, `gpt-5.6-codex`, GPT-5.4 mini/nano) keep the generic 272K budget via the shared `CODEX_GENERIC_CONTEXT_WINDOW`, first-party OpenAI is untouched, and the 272K long-context pricing threshold is unchanged.

### Fixed

- Codex named-tool fallback now keeps its downgraded request body across later same-turn provider retries and uses an independent one-shot budget, so retries cannot reintroduce `tool_choice` or suppress a later capability downgrade (#3669).
- Stored command-backed API keys that resolve empty now fall through to another usable API key or OAuth credential instead of suppressing it. AuthStorage also exposes the credential type its request dispatcher will select, with selector validation, runtime/config overrides, session OAuth stickiness, blocked/expired OAuth retry, command-key recovery, environment fallback, and `openai-codex-device` normalization sharing one precedence contract.
- `google-generative-ai` and `google-vertex` generate-content streams now consume newline-delimited JSON responses when the response media type declares NDJSON or JSONL, while preserving standard event-stream parsing and diagnostics.
- Anthropic requests rejected with `A maximum of 4 blocks with cache_control may be provided. Found N.` now step their generated breakpoints down instead of dying on the first attempt (#3934, supersedes #3943). An Anthropic-compatible gateway may attach its own block-level cache markers before forwarding, and those never appear in the params we serialize, so the total is unpredictable locally and the rejection itself is the only usable signal. Because that rejection says "too many", not "none allowed", recovery gives up one breakpoint at a time: explicit mode normally emits two (a conversation-prefix anchor plus a current-turn refresh point), so the first retry keeps the prefix anchor — the higher-value marker — and only a second rejection disables generated caching entirely. The reduced budget persists for the provider session so later turns neither re-trigger the 400 nor lose more caching than the endpoint requires. Only a genuine breakpoint-overflow `invalid_request_error` is claimed — other `cache_control` complaints, unrelated 400s, non-400 statuses, and our own pre-flight validation failure still surface immediately. The classifier is exported as `isAnthropicCacheBreakpointOverflowError`.
- A stale in-memory OAuth snapshot can no longer replay an already-rotated refresh token at the provider's token endpoint. Several gjc processes share one credential store, but each holds its own in-memory snapshot; when a peer rotated the token, the existing recovery only re-read the row AFTER the failed refresh — by which point the stale token had already been replayed upstream. Providers with refresh-token rotation plus reuse detection (Anthropic) treat that replay as token theft and can revoke the entire grant family, killing the peer's freshly rotated, still-valid tokens mid-request (observed in the wild as a live session dying with 401 `OAuth access token has been revoked` while sibling processes flooded the log with `invalid_grant` / `Refresh token not found or invalid` refresh failures all day). The local refresh path now re-reads the persisted row (via the canonical storage provider, so the `openai-codex-device` alias is covered) before dialing out: if a peer already rotated and the rotated access token is still fresh, it is adopted with no upstream call at all; if the rotated token has also expired — or the caller demanded a force refresh — the refresh spends the newest persisted refresh token instead of the stale snapshot one, and dispatch re-checks the adopted credential's MCP binding so a bound refresh token is only ever sent to its bound token endpoint. Failure recovery now compares the row against the refresh token that was actually sent (not the caller's stale snapshot), so an adoption that fails is classified and disabled instead of looping reload-retry, and a locally failed (credential, token) attempt is memoized for 30s so automatic refresh retries never immediately replay a token the provider may already have consumed after an ambiguous failure (timeout, lost response) — explicit force refreshes are the deliberate exception: they bypass the memo check so an operator/broker retry always reaches the endpoint, while their failures are still recorded. Broker-routed refreshes are unaffected, and the post-failure reload recovery remains as the backstop for rotations that land inside the now-milliseconds-wide window.
- Codex GPT-5.6 OAuth context windows now follow an explicit acceptance contract: live `/codex/models` `context_window` metadata is the authoritative runtime source, the bundled 272K fallback/ceiling remains the evidence-gated product guard, and explicit user `contextWindow` overrides survive the final cap instead of being silently re-clamped (#3987).
## [0.12.15] - 2026-08-06

### Fixed

- Anthropic requests rejected with `A maximum of 4 blocks with cache_control may be provided. Found N.` now retry once with generated caching suppressed, instead of dying on the first attempt (#3934). An Anthropic-compatible gateway may attach its own block-level cache markers before forwarding, and those never appear in the params we serialize, so the total is unpredictable locally and the rejection itself is the only usable signal. The retry keeps generated caching off for the rest of the provider session so later turns do not re-trigger the same 400. Only a genuine breakpoint-overflow `invalid_request_error` is claimed — other `cache_control` complaints, unrelated 400s, non-400 statuses, and our own pre-flight validation failure still surface immediately. The classifier is exported as `isAnthropicCacheBreakpointOverflowError`.

## [0.12.14] - 2026-08-06

## [0.12.13] - 2026-08-06

### Changed

- Anthropic prompt caching now defaults to top-level automatic caching (`cache_control: { type: "ephemeral" }`) on the canonical Anthropic API and explicit block-level caching for Claude-family models on non-canonical Anthropic-compatible gateways (Cloudflare AI Gateway, GitHub Copilot, GitLab Duo, Vercel AI Gateway, zenmux, CLIProxyAPI, etc.). Explicit mode is the safer compatible default because gateways commonly inject, rewrite, or reject the top-level field; verified gateways can opt into it with `compat.promptCacheMode: "automatic"`. Non-Claude models on unknown compatible endpoints keep the no-cache default; `promptCacheMode: "none"` and configured or per-request `cacheRetention: "none"` still opt out. Non-canonical Claude models get the default ~5m lifetime unless the endpoint sets `compat.supportsLongCacheRetention: true`.

### Added

- Added the `@gajae-code/ai/core` entrypoint for shared model and protocol types without loading provider construction code.

### Fixed

- `todo_write` raw argument rejections now carry bounded, authority-controlled correction codes for each rejected shape: unknown root keys, unknown operation-entry keys, done/drop entries missing a task or phase target, and unknown init list-entry keys. Each code maps to a fixed correction message naming the accepted shape (never echoing the offending input), so invalid calls surface specific guidance while valid payloads keep the existing passthrough/coercion path (#3916).
- Anthropic Sonnet 5 now exposes Anthropic's real `xhigh` and `max` thinking efforts on the Messages API (`minimal`/`low`/`medium`/`high`/`xhigh`/`max`), matching official support. The previous generic `kind === opus` gate excluded it from the full preset range; the capability predicate is now an explicit version-scoped list (Opus 4.7+, Sonnet 5+), so older Sonnet generations and Bedrock Converse routes stay fail-closed at their previously advertised levels (issue #3913).
- Alibaba Token Plan now exposes Qwen 3.8 Max under the provider-supported `qwen3.8-max` wire id instead of the rejected `qwen-3.8-max` spelling; catalog regeneration canonicalizes a legacy discovered alias rather than retaining a broken duplicate (#3909).
- Canonicalized first-class MiniMax M3 catalog ids (issue #3896). The bundled catalog previously shipped stale lowercase `minimax-m3` duplicates (512K) next to the canonical `MiniMax-M3` (1M) on all four first-class MiniMax providers, plus a non-official `minimax-v3` entry under `minimax-code`. The lowercase `minimax-m3` entries and `minimax-v3` are removed; `MiniMax-M3` is the single canonical first-class id (the regen-safe 1M pin in `applyGeneratedModelPolicy` now keys on `MiniMax-M3` / `MiniMax-M3[1m]` instead of the removed lowercase id), `DEFAULT_MODEL_PER_PROVIDER` points at `MiniMax-M3`, and the official Anthropic Token Plan id `MiniMax-M3[1m]` is first-class on the `minimax` / `minimax-cn` Anthropic routes with 1M context semantics. Unrelated catalog providers keep their own `minimax-m3` contracts.
- Anthropic thinking-replay repair now also triggers when the mutation/signature `invalid_request_error` arrives as a statusless in-stream SSE `error` event (issue #3900). Proxies such as CLIProxyAPI forward the upstream 400 body over an HTTP 200 SSE stream, so the thrown error carries no HTTP status; the classifiers previously required `status === 400` and let the session loop on an unrecoverable replay rejection. Statusless errors still require the full `invalid_request_error` thinking wording, so unrelated transport failures never claim the one-shot repair.
- Anthropic thinking-replay repair now also recovers when a proxy masks the rejection entirely (issue #3900). Live CLIProxyAPI captures replace the upstream 400 body with a generic `{"type":"api_error","message":"An error occurred while processing the request."}` SSE event on an HTTP 200 response, which names no cause and matches no transient phrase, so the turn died on the first attempt. Such a masked rejection now takes the same one-shot latest-then-full-history repair, but only before the first token and only while the request actually replays signed `thinking`/`redacted_thinking` blocks; masked failures on requests without replayed thinking still surface immediately. The classifier is exported as `isAnthropicMaskedProxyRejection`.

- Anthropic cache-control resolution now falls back to `model.cacheRetention` at the provider boundary, preserving configured retention and request-over-model precedence through special dispatch wrappers such as GitLab Duo. A configured `cacheRetention: "none"` can no longer be dropped and replaced by the new automatic Claude-family cache marker.
- Anthropic explicit prompt caching now advances its conversation breakpoint during tool-use loops by marking the latest completed assistant tool-use turn while leaving the newest tool result uncached. Previously it kept refreshing only the original human message until another human turn arrived, pinning proxy cache reads to the static tools/system prefix throughout long agentic runs.
## [0.12.12] - 2026-08-05

### Fixed

- OpenAI Responses and Azure OpenAI Responses now map the first-event timeout into the SDK request/setup timeout the same way Completions does, so a never-resolving pre-headers fetch on a provider-owned lazy stream cannot wait the SDK's 10-minute default before any transport watchdog exists. Alibaba Responses honors an explicit shorter first-event override before headers; Azure/env-pinned setup timeouts normalize to the typed `stream_first_event_timeout` failure.
- OpenAI Codex cost estimates now treat an explicit response `service_tier` as authoritative, so a request for priority processing that the provider serves at the default tier is no longer charged the priority multiplier; the requested tier remains the fallback when the terminal response omits the field.
- Added shared `isReasoningContentReplayError` classifier and `stripUnusableReasoningItems` repair for the DeepSeek-family reasoning-content replay rejection ("The `reasoning_content` in the thinking mode must be passed back to the API"). The classifier detects the error across message carrier shapes; the repair removes only `reasoning` items whose `encrypted_content` a proxy stripped to empty, preserving all non-reasoning history (text, tool calls, tool outputs). The agent loop consumes both for a bounded repair-and-resend circuit breaker.
- Codex statusless HTTP 200 SSE `invalid_request_error` events retry once without a forced named function choice only when the exact rejected name is still present in the request's serialized tools, before any output is emitted (#3669).

## [0.12.11] - 2026-08-03

## [0.12.10] - 2026-08-03
### Added

- Anthropic OAuth can now pair by pasting the authorization code Anthropic displays (`https://platform.claude.com/oauth/code/callback`) instead of waiting on `http://localhost:54545/callback`, so a browser with no network route back to the machine running gjc can complete the login. Opt in per login with `OAuthLoginOptions.manualCode`; the loopback flow stays the default and is unchanged. Callback flows can now opt out of binding a local listener entirely (`OAuthCallbackFlowOptions.skipCallbackServer`), which fails fast when no manual code handler is supplied instead of idling until the five-minute timeout. The hosted redirect is a hard-coded constant with no env or config override, so it cannot be repointed at an attacker-controlled collector.

### Fixed

- Composer shell-policy failures now expose a stable structured marker plus provider-specific recovery guidance, while retaining recognition of prefix-only errors from older sessions. Cursor Composer requests use a native `read`/`grep`/`write`/`delete` discipline prompt rather than the generic hashline-tool vocabulary.
- Alibaba Token Plan streams now allow 600 seconds for the first semantic event, matching observed long-context TTFT above the previous 300-second cutoff. The outer lazy watchdog and both OpenAI transports share one provider fallback; OpenAI Completions also applies it before response headers, and Alibaba SDK connection timeouts from that pre-stream phase are normalized to the typed first-event failure so session retry policy does not replay the request as an unknown timeout.
- A plain `forbidden` failure no longer mutates credential state. `classifyFallbackTrigger` still returns the same `auth` class for HTTP 401 and 403, but now carries an `authDisposition` refinement of `"credential"` or `"forbidden"`. The refinement reads every code field (`openaiErrorCode`, `anthropicErrorType`, `providerCode`) and orders by specificity: a concrete credential fault wins, a `forbidden` in any field is otherwise terminal (so `{status: 401, providerCode: "forbidden"}` does not rotate), and the status decides only when no auth code is present. `transportFailureFacts` also reads `anthropicErrorType` back from its own key so re-normalizing already-built facts no longer drops it. `streamSimple` consults the disposition at both auth-capture exits — the error-event path and the thrown-error path, the latter unwrapping a nested `error.transportFailure` carrier that the shared `transportFailureFacts` extractor does not dereference — so a forbidden failure never reaches `onAuthError`, and `createAssistantAuthError` now preserves the structured transport facts on the callback error instead of reducing it to a status. The auth gateway's managed-failure bookkeeping likewise stops invalidating a credential on a forbidden response. Previously a single 403 could block an otherwise-healthy credential, and in a multi-credential pool could cycle through and block every row.
- `AuthStorage` gains `hasRuntimeCredentialSelector()` and `getSessionCredentialRowId()`. The first reports the `--credential` runtime pin, which lives in a different map from the `--api-key` override and previously had no accessor, so callers that must not rotate away from a pinned credential could not see it. The second returns the opaque stored row id for a session's current credential — never an email, account, project, or key material.

## [0.12.8] - 2026-08-02
### Added

- Added read-only OpenCodex provider discovery with runtime-port resolution, identity-checked health probing, cached `/api/models` catalogs, raw wire model ids, and `/login opencodex` status reprobes without credential persistence.
- Added the Alibaba Token Plan `deepseek-v4-flash-0731` model with its 1M context, 384K output limit, OpenAI Completions routing, and documented low/high/max reasoning efforts.

### Changed

- OpenAI-compatible discovery and OpenAI Completions/Responses transports now preserve query-bearing endpoint routing, including repeated query parameters. Model resolution records whether a provider discovery result was fetched so consumers can distinguish current discovery evidence from cached data.

### Fixed

- Closed the two remaining ingress holes behind bare `Request Blocked` failures on OpenAI codex models. (1) The chatgpt.com/backend-api pre-model gate rejects with an HTTP 400 bare-`detail` body (`{"detail": "Request blocked."}`) carrying no `error.*` envelope and no `code=invalid_prompt`, so `parseCodexError` surfaced an unexplained message, `isInvalidPromptError` and the codex non-retryable classification missed it, and the session-level `invalid_prompt` circuit breaker never attempted a repaired resend. `parseCodexError` now reads top-level `detail` (string or `{message}`) bodies and classifies a leading `Request blocked` message without an explicit provider code as `invalid_prompt`, surfacing `Request blocked (code=invalid_prompt)` so every existing invalid_prompt contract engages. (2) Outgoing tool definitions (descriptions and JSON-schema strings) bypassed every request-boundary sanitizer on both the OpenAI Responses and OpenAI-codex-responses transports, so a `<|channel|>`-quoting MCP/skill tool description poisoned every request on the session in a way no history repair could fix. Both `convertTools` paths now neutralize reserved control tokens across the whole tool payload via the shared idempotent zero-width-space insertion (ref openai/codex#35838).
- Lazy built-in streams no longer place a normalized-event watchdog in front of providers that already monitor raw transport progress. This prevents active Anthropic, Azure OpenAI, and OpenAI-family streams from being replaced by a blank `Provider stream stalled while waiting for the next event` error when transport-only events refresh the provider watchdog; providers without their own watchdog keep the shared lazy-stream protection.

### Fixed

- Updated GPT-5.6 Sol, Terra, and Luna to current OpenAI Standard pricing, including Responses API cache-write attribution and full-request long-context pricing above 272K input tokens.

## [0.12.7] - 2026-07-31

## [0.12.6] - 2026-07-31

## [0.12.5] - 2026-07-30
### Fixed

- Alibaba Token Plan requests now carry Qwen Code's canonical DashScope request fingerprint on both transports. The built-in `alibaba-token-plan` provider (openai-responses `qwen3.8-max-preview` and openai-completions `glm-5.2`/`deepseek-v4-pro`) now emits the four upstream identity/cache/auth headers (`User-Agent`, `X-DashScope-CacheControl: enable`, `X-DashScope-UserAgent`, `X-DashScope-AuthType: openai`) matching `QwenLM/qwen-code` v0.21.1 (commit `f4cd6e1`) exactly, via a shared helper. DashScope is compatibility-sensitive to this client fingerprint, so a non-identical set can cause request instability and affect first-event latency. Caller headers still win per key (upstream `{...default, ...customHeaders}` precedence); non-Alibaba providers are byte-unchanged (#3557).

### Added

- Reproducible Alibaba Token Plan header-parity A/B latency benchmark (`packages/ai/scripts/alibaba-token-plan-latency-ab.ts`): a fixed-seed interleaved A/B comparison of legacy vs Qwen-identical headers against a deterministic local HTTP server, reporting n/success/error/timeout and TTFT/total latency median/p90/p95/mean/stddev. No live credentials are required; a public-safe blocked-live-data receipt is included (`packages/ai/test/fixtures/alibaba-token-plan-latency-blocked-receipt.md`) (#3557).

## [0.12.4] - 2026-07-30

### Fixed

- Mara Cloud login now validates pasted credentials against the authenticated chat-completions endpoint instead of the public `/v1/models` catalog. The catalog returns `200` even for random invalid bearer tokens, so the previous check could persist unusable keys.

## [0.12.3] - 2026-07-30

### Added

- Added first-class support for **Mara Cloud**, an OpenAI-compatible enterprise AI inference platform. Registers the `mara` provider descriptor, `/login` entry (API-key paste validated against `https://api.cloud.mara.com/v1/models`), `MARA_API_KEY` environment resolution, and bundled `models.json` seed models. Models are discovered dynamically from `GET /v1/models` (base URL `https://api.cloud.mara.com/v1`).

## [0.12.2] - 2026-07-30

## [0.12.1] - 2026-07-29

### Fixed

- Lazy-stream first-event timeouts now abort with `FirstEventTimeoutError` so `transportFailure.providerCode` is `stream_first_event_timeout` on the outer watchdog path shared by all bundled providers via `createLazyStream`. Idle stalls remain bare `Error`s (distinct class intentionally) (#3496).

- Provider streams now surface first-event watchdog expiry as a typed timeout so callers can apply bounded retry policy without parsing error prose.
- Codex websocket first-event timeouts now discard the timed-out connection before the outer retry/fallback layer handles the typed failure, preventing late frames from the abandoned request from being consumed by the replayed turn.
- Codex named-tool requests now recognize provider `Tool choice '<name>' not found in 'tools' parameter` errors as runtime capability failures and retry once without forcing the choice.
- The Kimi OAuth host (`KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`) is now resolved from trusted environment sources only. That host receives the device-authorization request, the authorization-code exchange, and the refresh call that carries the existing refresh token, so reading it through the merged view that includes the caller's `cwd/.env` let a repository redirect the login flow and collect the user's Kimi credentials. Resolution now uses the non-project resolver; shell and user-level configuration is unchanged.
- The documented `GJC_NO_STRICT` environment variable now takes effect. `adaptSchemaForStrict` read only the legacy `PI_NO_STRICT`, so an operator hitting a provider that rejects strict function schemas set the documented name and strict mode stayed on. Both names are honoured, canonical name first, and `GJC_NO_STRICT` is now listed in the environment-variable reference rather than only in the schema-normalisation note.
- The documented `GJC_AUTH_NO_BORROW` environment variable now takes effect. Only the legacy `PI_AUTH_NO_BORROW` was read, so an operator who followed the documentation to disable macOS native-app token borrowing still had a JWT read out of the Perplexity desktop application during login. Both names are now honoured, and the contract stays presence-based as documented so that setting it to `0` cannot silently re-enable borrowing.
- The Azure client's `AZURE_OPENAI_API_KEY` fallback is now resolved from trusted environment sources only. It read the merged view that includes the caller's `cwd/.env`, so a repository could supply the credential the client authenticates with; provider credential resolution is documented as excluding the project `.env`, and this fallback now matches. An explicit caller-supplied key still takes precedence, and shell / user-level configuration is unchanged.
- Anthropic and Ollama tool calls cut off by an output-token limit are now marked incomplete before dispatch, so repaired partial JSON is rejected instead of executing with truncated arguments.
- The Anthropic "thinking blocks in the latest assistant message cannot be modified" 400 now escalates its one-shot replay repair. The error names the latest assistant message but its cited `messages.N.content.M` path can point at an earlier replayed turn, so the latest-only repair was rejected identically and killed the turn; recovery now retries once more with thinking dropped from every replayed assistant message.
- Anthropic adaptive-thinking `display` support is now decided by the canonical model-version parser instead of a provider-local `claude-opus-(\d+)-(\d+)` regex. The regex only matched two-component ids, so a single-component alias such as `claude-opus-5` was classified as pre-4.7 while its dated snapshot `claude-opus-5-20260101` was not: the alias sent `thinking: { type: "adaptive" }` without `display: "summarized"`, additionally requested the `interleaved-thinking-2025-05-14` beta, and had its returned thinking blocks recorded as raw rather than summarized. Both Anthropic and Bedrock providers now share `supportsAnthropicAdaptiveThinkingDisplay`, so alias and dated ids of the same model send an identical request shape.
- Anthropic requests that force a tool choice no longer replay signed thinking blocks. Forcing `tool_choice` strips `thinking` from the request (the API rejects the combination), but the converted history still carried native `thinking`/`redacted_thinking` blocks from thinking-enabled turns, so eager tool-forcing turns (e.g. the todo bootstrap) sent a request whose history contradicted its own thinking setting and drew a 400. The replay now degrades in the same rebuild; the forced request trades its prompt-cache prefix for a shape the API accepts.
- A definitively failed OAuth refresh can no longer loop forever instead of disabling the credential. The refresh-failure path disables the row with a CAS conditioned on its serialized `data`, and treated a lost CAS as proof that a peer had rotated the token: it reloaded the store and re-resolved, without bound. That predicate also misses when nothing was rotated — an account switcher that replaces the provider's rows leaves the attempted id gone, and an unrelated identity-metadata write leaves the row byte-different — so a revoked credential was never disabled and every subsequent request re-issued the same `invalid_grant` refresh (observed in the wild as ~3k `OAuth token refresh failed` / `disable lost CAS` log pairs in 3.5 hours, one wasted refresh round-trip per request). When the row still holds the refresh token that just failed, it is now disabled by id (no peer rotation exists to clobber); otherwise the reload-and-retry recovery is capped, so resolution terminates instead of recursing until the runtime dies.

## [0.12.0] - 2026-07-28

### Added

- Added first-class support for **BizRouter**, an OpenAI-compatible Korean enterprise LLM gateway. Registers the `bizrouter` provider descriptor, `/login` entry (API-key paste validated against `https://api.bizrouter.ai/v1/models`), `BIZROUTER_API_KEY` environment resolution, and bundled `models.json` seed models. Models are discovered dynamically from `GET /v1/models` (base URL `https://api.bizrouter.ai/v1`).
### Fixed

- Anthropic subscription OAuth requests now use the current Claude Code compatibility attribution (`2.1.219`, `sdk-cli`) instead of the stale `2.1.63` CLI fingerprint that Anthropic can misclassify as extra usage.
- Connection failures now name the transport code and the target URL. Bun reports DNS and socket failures as a bare `Error` whose message is a standalone hint ("Was there a typo in the url or port?", "Unable to connect. Is the computer able to access the url?") and keeps the actionable facts on `code` and `path`, but only `message` reached the assistant message. A provider outage, a local DNS failure, and a mistyped custom base URL therefore all rendered as the same context-free sentence with no host in it. Such failures now read `... (transport=FailedToOpenSocket url=https://chatgpt.com/backend-api/codex/responses)`; the URL is reduced to origin and path so a key carried in the query string is not surfaced.

### Documentation

- `docs/environment-variables.md` now names the Anthropic Foundry gateway variables that are actually read: `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_CLIENT_CERT`, and `CLAUDE_CODE_CLIENT_KEY`. The page advertised `ANTHROPIC_MODEL_CODE_*` spellings that no code path reads, so an operator following it could not enable Foundry mode at all, and the mTLS client material was silently ignored.

## [0.11.11] - 2026-07-26

### Fixed

- The Kimi usage endpoint base (`KIMI_CODE_BASE_URL`) is now resolved from trusted environment sources only. That base becomes the URL the usage request sends `Authorization: Bearer <accessToken>` to, so reading it through the merged view that includes the caller's `cwd/.env` let a repository collect the user's Kimi access token. An explicit caller-supplied base URL still takes precedence, and shell / user-level configuration is unchanged.
- The Gemini CLI compatibility version used in the outbound `User-Agent` is refreshed from `0.50.0` to `0.52.0`, matching the current upstream release. The repository ships `check-spoofed-versions` for exactly this, but that check is not wired into CI, so the value had drifted two minor releases behind.
- The OpenAI and Azure endpoint decisions are now resolved from trusted environment sources only: `OPENAI_BASE_URL` (streaming responses, completions, and the model manager) and `AZURE_OPENAI_BASE_URL`. `Bun.env` is `process.env` and the env module merges the caller's `cwd/.env` into it, so a repository could previously plant a `.env` that redirected authenticated requests; the two provider paths already reached for `$inheritedEnv` but re-admitted the project `.env` through a fallback. Resolution now goes through the non-project resolver (launching shell plus GJC/user-owned `.env` files); shell and user-level configuration is unchanged.
- The OpenAI and Azure endpoint decisions are now resolved from trusted environment sources only: `OPENAI_BASE_URL` (streaming responses, completions, and the model manager), `AZURE_OPENAI_BASE_URL`, and `AZURE_OPENAI_RESOURCE_NAME` (the alternate constructor for the same Azure host). `Bun.env` is `process.env` and the env module merges the caller's `cwd/.env` into it, so a repository could previously plant a `.env` that redirected authenticated requests; the two provider paths already reached for `$inheritedEnv` but re-admitted the project `.env` through a fallback. Resolution now goes through the non-project resolver (launching shell plus GJC/user-owned `.env` files); shell and user-level configuration is unchanged.
- Google credential material is now resolved from trusted environment sources only: the `GOOGLE_APPLICATION_CREDENTIALS` service-account / authorized-user file path used by the ADC loader, and `GOOGLE_CLOUD_API_KEY` used as the Vertex API key. Both were read through the merged view that includes the caller's `cwd/.env`, so a repository could ship a key file and point the agent at it, making it authenticate to Google as an identity the repository chose. `stream.ts` already resolved the same ADC variable through the non-project resolver; the two now agree. An explicit caller-supplied API key still takes precedence.
- The Grok usage token fallback (`GROK_CLI_OAUTH_TOKEN`) is now resolved from trusted environment sources only. It authenticates the billing/usage call, and reading it through the merged view that includes the caller's `cwd/.env` let a repository decide which account that call ran against. Stored credentials keep precedence, and shell / user-level configuration is unchanged.
- The Vertex AI location (`GOOGLE_CLOUD_LOCATION`) can no longer redirect authenticated requests off Google. It is interpolated into the request host (`${location}-aiplatform.googleapis.com`), so a value containing `/` terminated the authority component and sent the Google access token to an arbitrary origin — and it was read through the merged view that includes the caller's `cwd/.env`. It now resolves from trusted sources only and must be a region label; `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` moved to the same trusted resolver.
- HTTP 400 request dumps are now bounded. Every 400 wrote a file containing the full sanitized request body and nothing ever removed one, so the directory grew without limit — a developer machine reached 27,249 files totalling 7.0 GB, which was 96% of everything under `~/.gjc`. The newest 50 are retained, matching the bounded retention the rotating application log already uses, and pruning stays best-effort so diagnostics never turn a request failure into a second failure.
- Anthropic `ping` keepalives no longer reset stream progress, so responses that stop producing content now reach the idle timeout instead of hanging indefinitely.
- The Anthropic endpoint decision is now resolved from trusted environment sources only: `ANTHROPIC_BASE_URL`, `FOUNDRY_BASE_URL`, `ZCODE_PLAN_ANTHROPIC_BASE_URL`, and the `CLAUDE_CODE_USE_FOUNDRY` mode switch. `Bun.env` is `process.env` and the env module merges the caller's `cwd/.env` into it, so a repository could previously plant a `.env` that redirected authenticated Anthropic requests — the resolved base URL becomes `${baseUrl}/v1/messages` while the headers carry the API key or OAuth token. Resolution now goes through the non-project resolver (launching shell plus GJC/user-owned `.env` files); shell and user-level configuration is unchanged.
- The documented `GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS` environment variable now takes effect: the stream-watchdog idle-timeout helpers resolve it GJC-first before the legacy `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` / `PI_STREAM_IDLE_TIMEOUT_MS` aliases (previously only the `PI_`-prefixed names were read, so setting the documented GJC name was a silent no-op).
- The documented OpenAI-code provider knobs now take effect: `GJC_OPENAI_CODE_DEBUG`, `GJC_OPENAI_CODE_WEBSOCKET`, `GJC_OPENAI_CODE_WEBSOCKET_IDLE_TIMEOUT_MS`, `GJC_OPENAI_CODE_WEBSOCKET_RETRY_BUDGET`, and `GJC_OPENAI_CODE_WEBSOCKET_RETRY_DELAY_MS` are resolved GJC-first ahead of the legacy `PI_CODEX_*` names. The Codex → OpenAI-code rename had updated the documentation but not the reads, so every documented name was a silent no-op.

## [0.11.9] - 2026-07-24
### Fixed

- Credential selection and aggregate usage callers now stop awaiting immediately when their own signal aborts without cancelling shared usage fetches, and ranking deadlines no longer re-await the same stalled usage request during credential resolution.
- Kimi Code now allows one continuous 300-second first-event wait before aborting, while preserving explicit caller and environment timeout overrides and the existing inter-event idle timeout.

### Added

- Added first-class support for **OpenGateway by Sionic AI**, an OpenAI-compatible gateway. Registers the `opengateway` provider descriptor, `/login` OAuth entry (API-key paste validated against `https://apis.opengateway.ai/v1/models`), `OPENGATEWAY_API_KEY` environment resolution, and bundled `models.json` seed models. Models are discovered dynamically from the OpenAI-compatible `/v1/models` endpoint (base URL `https://apis.opengateway.ai/v1`).

## [0.11.8] - 2026-07-23

### Fixed

- OpenAI Responses / Codex native history replay no longer submits missing resident-image placeholders as `input_image.image_url`. Invalid values (including `[Session resident imageUrl blob missing: …]`) are dropped, or retained as `file_id`-only parts when a non-empty `file_id` is present, so a single unavailable historical image cannot brick `/retry` (#2924).
- Raised the first-event stream timeout floor to five minutes for `alibaba-token-plan` models at both the OpenAI provider and outer lazy-stream watchdogs, while preserving caller and environment overrides and the existing inter-event idle timeout.
- OAuth refresh peer-rotation recovery now runs before failure classification instead of only on the definitive-failure path, and the definitive matcher recognizes the "grant is invalid" phrasing. Providers whose invalid-grant response does not contain the literal `invalid_grant` (e.g. Kimi's 400 "The provided authorization grant is invalid") previously had rotation races misclassified as transient, temp-blocking a healthy credential for five minutes on every race; with Kimi's ~12-minute access tokens and multiple processes sharing the credential store this surfaced as repeated logouts. Genuine revocations are now disabled with a cause instead of looping temp-blocks.
- Anthropic 400 `Invalid \`signature\` in \`thinking\` block` responses now trigger the one-shot thinking replay repair instead of failing the turn. The existing repair matcher only recognized the "latest assistant message ... cannot be modified" wording, so the signature-validation variant — which can cite a `thinking`/`redacted_thinking` block anywhere in the replayed history (e.g. after compaction/pruning rewrote an earlier turn) — was treated as a fatal request error. The retry now rebuilds the request with thinking blocks dropped from every replayed assistant message (`repairAllAssistantThinking`), while the latest-message mutation variant keeps the targeted latest-only repair.

### Changed

- Raw tool-argument rejection hooks can now select from bounded, authority-controlled correction codes. Unknown or extension-supplied values retain the byte-for-byte generic rejection instead of reaching model-visible validation errors.

## [0.11.7] - 2026-07-22

### Changed

- Replaced the `alibaba-coding-plan` provider with first-class `alibaba-token-plan` support. The `/login` OAuth list, provider descriptor, model manager, models.dev descriptor, and bundled `models.json` now target the maintained Alibaba Token Plan endpoint (`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`, env `ALIBABA_TOKEN_PLAN_API_KEY`) and validate logins against `deepseek-v4-pro`. The retired `alibaba-coding-plan` provider pointed at `coding-intl.dashscope.aliyuncs.com`, which rejected real token-plan keys with 401 and was the only Alibaba entry exposed in `/login`.

## [0.11.4] - 2026-07-20

### Added

- Added the native Kimi Code `k3` catalog entry with its 1M-token context window, multimodal input, and reasoning support.

## [0.11.2] - 2026-07-19

### Fixed

- `transportFailureFacts` now reduces transport headers to a plain record containing only the retained retry signals (`retry-after`, `retry-after-ms`). Providers attach these facts to error `AssistantMessage`s, and the previous shape carried the live fetch/SDK `Headers` instance — which is not structured-cloneable (`structuredClone` throws `DataCloneError`, "The object can not be cloned." under Bun) and not JSON-serializable (persisted as `{}` in session files, silently dropping the retry hint). Under a managed model fallback chain, snapshotting such an error message replaced the real provider failure with the local clone error and exhausted the whole chain. Normalization is idempotent (re-running facts on facts is structurally stable; errors carrying only unretained headers with no status/code now yield no facts instead of an empty facts object), Retry-After classification (`classifyFallbackTrigger`) is unchanged, and arbitrary response headers no longer reach persisted facts.

## [0.11.0] - 2026-07-15
### Added

- Exported the canonical thinking-control mode runtime vocabulary so packed SDK consumers can validate provider metadata against the same public `@gajae-code/ai` contract.

### Fixed

- Fixed frequent `Request blocked (code=invalid_prompt)` failures on gpt-5.6 (Sol/Terra/Luna) subagent, default-agent, and compaction turns (ref openai/codex#32028, oh-my-pi#5184). Leaked Harmony control-token markers (e.g. `<|channel|>analysis`) were only neutralized on the replayed-history payload path, so markers in assistant reasoning summaries, live-converted message/tool-output text, and user-authored content reached the OpenAI Responses and OpenAI-codex-responses transports verbatim and wedged the session (the poisoned item was re-sent every turn). Both transports now neutralize reserved control tokens across the entire outgoing `input` array at the request boundary via an idempotent zero-width-space insertion that keeps the text human-readable.

- Closed the remaining `Request blocked (code=invalid_prompt)` wedge on gpt-5.6 caused by header-form leaked Harmony markers. The reserved-control-token sanitizer only matched the simple `<|ident|>` shape, so a header-form marker carrying a recipient (e.g. `<|assistant to=functions.bash|>`) survived every sanitizer path (replay, request boundary, compaction) and kept re-poisoning history even after the earlier fixes. The pattern now also matches the scoped header grammar — a known Harmony role (`system`/`developer`/`user`/`assistant`/`tool`) plus a `to=<recipient>` assignment with unbounded recipient length — while leaving ordinary delimiter/pipe text untouched (arbitrary `<|foo bar=baz|>`, F# `value <| f |> g`, compact `sum<|a+b|>c`, and multi-line bodies never match). The simple branch remains a strict superset of the prior identifier-only pattern (#2267).

- Made the `Request blocked (code=invalid_prompt)` classification explicit and shared across transports (#2282). `invalid_prompt` was only non-retryable by omission — it appeared in neither the codex retryable nor non-retryable event set, and the plain OpenAI Responses transport surfaced it as a generic error with no durable marker. It is now in the codex `CODEX_NON_RETRYABLE_EVENT_CODES` set (code and message forms), the Responses error path tags `transportFailure.providerCode = "invalid_prompt"`, and a new exported `isInvalidPromptError` predicate is the single contract both transports and the session-level circuit breaker key on. Ordinary control-token / pipe text (F# `value <| f |> g`, `sum<|a+b|>c`, `<|foo bar=baz|>`) is unaffected; genuinely transient errors (`server_error`, `model_error`) stay retryable.

## [0.10.2] - 2026-07-14

### Fixed

- Fixed frequent `Request blocked (code=invalid_prompt)` failures on gpt-5.6 (Sol/Terra/Luna) subagent, default-agent, and compaction turns (ref openai/codex#32028, oh-my-pi#5184). Leaked Harmony control-token markers (e.g. `<|channel|>analysis`) were only neutralized on the replayed-history payload path, so markers in assistant reasoning summaries, live-converted message/tool-output text, and user-authored content reached the OpenAI Responses and OpenAI-codex-responses transports verbatim and wedged the session (the poisoned item was re-sent every turn). Both transports now neutralize reserved control tokens across the entire outgoing `input` array at the request boundary via an idempotent zero-width-space insertion that keeps the text human-readable.
### Fixed

- Fixed Fable 5 adaptive thinking being billed but never displayed: model discovery now classifies `claude-fable-*` as `anthropic-adaptive` (was cached as `budget`, sending `enabled`+`budget_tokens` that Fable answers with signature-only thinking), and `supportsAdaptiveThinkingDisplay` opts Fable into `display: "summarized"` on both Anthropic Messages and Bedrock Converse transports (#2791).

## [0.10.0] - 2026-07-12
### Fixed

- Made Bedrock model visibility reflect credential-only static/shared AWS sources with supported profile shapes, authenticated real bearer-token requests, and stopped advertising unsupported ECS/IRSA sources (#1934).
- Added a typed provider safety-stop classification across Anthropic, OpenAI-compatible, and Google streams so callers can distinguish policy terminations from generic provider errors without parsing display text.

## [0.9.6] - 2026-07-10
### Fixed

- Normalized the GPT-5.6 Sol/Terra/Luna context window to the 373K usable prompt budget on both OpenAI and OpenAI code transports (was 1,050K / 272K), matching the live openai-codex catalog.

## [0.9.5] - 2026-07-09
### Added

- Added GPT-5.6 Sol, Terra, and Luna catalog/parser support for OpenAI and OpenAI code transports, including `low` through canonical `max` reasoning efforts, verified pricing/limits, and GPT-5.6 cache-write pricing (#1925; OmX #3103).

### Fixed

- Stopped requesting `strict: true` tool use on Anthropic OAuth requests: the Claude Code OAuth surface mishandles strict tools, returning tool calls with empty/undefined arguments and occasionally corrupted tool names. API-key requests keep strict tool use; `PI_NO_STRICT=1` is no longer needed as a workaround.

## [0.9.4] - 2026-07-09
### Fixed

- Preserved Anthropic OAuth tool-call names and streamed arguments across interleaved tool-use blocks, preventing prefixed tool names and partial JSON deltas from being dropped or misattributed.
- Embedded `models.json` via a `with { type: "file" }` import so compiled release binaries load the bundled model catalog from bunfs instead of crashing at startup with `Cannot find module './packages/ai/src/models.json'` (v0.9.3 regression, #1914).

## [0.9.2] - 2026-07-09
### Added

- Added runtime credential selectors so callers can pin stored multi-account credentials by id, email, account id, or project id instead of using automatic rotation/ranking.

### Fixed

- Refreshed the default Gemini CLI impersonation version to 0.50.0 so the spoofed User-Agent freshness gate passes for the 0.9.2 release.
- Hid the non-callable `google-antigravity/gemini-3.1-pro-high` selector from bundled, dynamic, and cached Antigravity catalogs after live Cloud Code Assist calls returned HTTP 400; `google-antigravity/gemini-3.1-pro-low:high` remains the working high-thinking path.
- Preserved Anthropic tool-use arguments supplied on `content_block_start` when no `input_json_delta` chunks follow, preventing finished tool calls from collapsing back to `{}`.
- Refreshed the default Gemini CLI impersonation version to 0.50.0 so the spoofed User-Agent freshness gate passes for the 0.9.2 release.

## [0.9.1] - 2026-07-08

### Fixed

- Unified the Cursor client version used across provider requests and discovery.
- Detected ZAI weekly limit exhaustion as a structured rate-limit condition.
- Pointed Sakana Fugu OAuth/login guidance at the Sakana platform console and documented the `fish_` key prefix expectation.

## [0.9.0] - 2026-07-07

### Fixed

- Capped OpenCode Go Kimi reasoning efforts that the Go chat-completions endpoint rejects (`kimi-k2.5:minimal` → `low`, `kimi-k2.7-code:xhigh|max` → `high`) and degraded forced `tool_choice` for those models so Kimi Go sessions and title-generation turns no longer fail with generic upstream 400s.

## [0.8.2] - 2026-07-06

### Fixed

- Refreshed matching existing OAuth credentials during `importCredentialIfAbsent` and cleared provider usage caches after the write, so external credential import no longer keeps stale tokens or stale usage-limit reports for the same account.

## [0.7.9] - 2026-07-01

### Fixed

- Mapped DeepSeek-style `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` usage fields into OpenAI-compatible prompt-cache accounting (#1329).

## [0.7.5] - 2026-06-27

### Fixed

- Sanitized Codex history replay text fields so malformed/non-string replay text no longer corrupts the rebuilt request payload (#1199).
- Preserved object-valued tool replay fields when rebuilding Codex history payloads instead of coercing them to strings (#1200).

## [0.7.4] - 2026-06-27

### Fixed

- Treated `openai-codex-device` as an auth-storage alias for `openai-codex`, so headless/device Codex logins show as authenticated and logout/remove the stored Codex credential instead of appearing unsaved (#1151).
- Disabled thinking for OpenCode Go forced tool calls so forced-tool turns no longer emit unsupported thinking content (#1185).
- Restored the GPT-5.5 context window to its correct size (#1186).

## [0.7.3] - 2026-06-25
### Added

- Added the Sakana Fugu provider (`fugu`) with API-key auth (`FUGU_API_KEY`) and bundled catalog models (#1086).

### Fixed

- Wired Fugu API-key auth login so `gjc login fugu` stores a reusable `FUGU_API_KEY` credential instead of the provider having no supported login flow (#1090).
- Matched the real google-antigravity IDE request headers, system prompt, and preamble config so requests are accepted by Cloud Code Assist (#1080).
- `isContextOverflow` now detects a third proxy-level overflow case — an empty response with `stopReason: "stop"` and anomalously low usage (input + output ≤ 5 tokens), as emitted by some proxies (notably LiteLLM) when the upstream context window is exceeded — so callers surface overflow instead of treating it as a clean completion (#1102).

### Security

- In no-auth (tokenless) auth-gateway mode, requests carrying a browser `Origin` header are now rejected before CORS preflight handling or route dispatch, while local non-browser CLI clients keep the existing tokenless flow and token-configured browser clients keep the bearer-token/preflight flow (#1115).

## [0.7.2] - 2026-06-24

### Fixed

- Reject truncated or incomplete streamed tool calls instead of executing them with partial arguments, so a cut-off tool-call payload fails fast rather than running against a mismatched schema.

## [0.7.1] - 2026-06-23

### Changed

- Reworked the unofficial, opt-in `glm-zcode` provider to mirror how the ZCode desktop app actually reaches GLM: after the ZCode OAuth handshake it now auto-provisions a real Z.AI API key and calls `api.z.ai/api/anthropic` directly, instead of the `zcode.z.ai` coding-plan gateway that required an Aliyun captcha and a ZCode-JWT-bound plan entitlement. Requests also carry ZCode client source headers (`User-Agent: ZCode/<ver>`, `X-ZCode-Agent: glm`, plus platform/locale/timezone), so Z.AI recognizes the caller as the ZCode client (#1013, #1016, #1017).

## [0.7.0] - 2026-06-22

### Added

- Added the bundled `google-gemini-cli/gemini-3.5-flash` model entry so Gemini CLI users can select the model from the static registry (#965).

## [0.6.4] - 2026-06-20

### Fixed

- Fixed argument mis-attribution in the OpenAI-compatible Responses API streaming decoder when a single response emits multiple tool-call items. The decoder buffered streamed argument deltas against a single most-recent item/block slot, so interleaved or back-to-back `function_call`/`custom_tool_call` argument deltas could be applied to the wrong item — finalizing a tool call with another call's arguments (e.g. one tool's payload landing on a different tool's schema and tripping validation). Streamed deltas now accumulate against a per-item buffer keyed on stable item identity (`item_id` primary; positional `output_index` only when finite), each block records its content index at registration time, and finalization writes onto the same block stored in the message content while reading only the matching item's buffer. Single-tool-call streams, reasoning/text streaming, and the Chat Completions path are unchanged.

## [0.6.2] - 2026-06-19
### Added

- Added opt-in `compat.sendSessionHeaders` for the `openai-completions` provider. When enabled (default off), the agent session id is forwarded as vendor-neutral `session_id` and `x-session-id` request headers to any OpenAI-compatible endpoint, letting relays/proxies do session-affinity routing and reuse a server-side prompt cache keyed by the session. Previously only the `openai-responses` provider injected session headers, and only against a first-party OpenAI base URL. Injection runs after the caller's `headers`/`extraHeaders` are merged and before `requestTransform`, and uses `??=` so any header the caller already set always wins; it is skipped entirely when the flag is off or no session id is available, leaving existing provider behavior byte-identical. The first-party `openai-responses` gating is unchanged.

### Fixed

- Prevented OpenAI Codex Responses `invalid_function_parameters` / tool-schema validation error events from being treated as retryable `server_error`s, so malformed request schemas fail fast instead of burning the full retry budget.
- Read LM Studio `/v1/models` nested metadata such as `meta.n_ctx`, `meta.n_ctx_train`, and `details.max_tokens` when normalizing dynamically discovered GGUF-backed local models.
- Corrected the bundled `openai-codex/gpt-5.5` context window from an overstated 400K back to its true 272K (272,000-token) window, so context-cap / auto-compaction thresholds no longer let gpt-5.5 sessions overrun the model's real limit before compaction (#873).

## [0.6.1] - 2026-06-18

### Fixed

- Generalized tool `input_schema` root-combinator flattening across providers so discriminated-union tool inputs (e.g. the `computer` tool, a `z.union`) no longer ship a bare top-level `anyOf`/`oneOf`/`allOf` root that strict validators reject. The Anthropic-only fix from 0.5.4 is now the shared, provider-agnostic `flattenToolRootCombinators` (in `utils/schema`) and is applied by Amazon Bedrock, OpenAI Chat Completions / Responses / Codex-Responses / Azure-Responses, Ollama, and Cursor. Previously only Anthropic flattened the root, so those providers forwarded the union root verbatim and a union-root tool failed upstream — Bedrock Converse (including via Kiro/CodeWhisperer relays) returned `400 TOOL_SCHEMA_INVALID: The value at toolConfig.tools.N.toolSpec.inputSchema.json.type must be one of the following: object`. Anthropic behavior is unchanged (it now calls the shared util), Google / Cloud Code Assist keep their own object-merge, and object-root tools, nested combinators, and runtime Zod validation are all untouched.

## [0.6.0] - 2026-06-18
### Fixed

- Corrected the bundled `zai/glm-5.2` context window from 200K to its true 1M (1,000,000-token) lossless window. GLM-5.2 was added in #579 by copying GLM-5.1's 200K entry, and that stale value survived every `generate-models` run because provider-scoped models bypass the models.dev refresh in `applyGlobalModelsDevFallback`. Added a regen-safe pin in `applyGeneratedModelPolicy` (mirroring the Bedrock-Opus-4.6 precedent) so the 1M value persists, and updated the bundled catalog entry. The wrong 200K tripped auto-compaction / context-cap thresholds ~5x early for GLM-5.2 sessions.
- Corrected the bundled `minimax-m3` context window from 512K to its true 1M (1,000,000-token) window per the official MiniMax docs (platform.minimax.io documents MiniMax-M3 as a 1M-context frontier coding model). All four provider copies (`minimax`, `minimax-cn`, `minimax-code`, `minimax-code-cn`) carried the stale 512K, which survived `generate-models` (provider-scoped models bypass the models.dev refresh in `applyGlobalModelsDevFallback`) and tripped auto-compaction / context-cap thresholds 2x early on MiniMax sessions. Added a regen-safe pin in `applyGeneratedModelPolicy` keyed on `model.id === "minimax-m3"` and updated the bundled entries. `minimax-v3` (an undocumented catalog alias) is intentionally left untouched.

## [0.5.4] - 2026-06-17

### Fixed

- Fixed Anthropic tool schema compatibility for discriminated-union tool inputs by flattening only the model-facing input-schema root, avoiding top-level `oneOf`/`anyOf`/`allOf` request rejections while preserving nested combinators and runtime validation authority.

- Made the "No API key for provider" error from `stream`/`complete` actionable for OpenCode Go/Zen subscription providers in headless runs (#755). The subscription is itself an API key (`OPENCODE_API_KEY`, created at https://opencode.ai/auth), not a separate OAuth/session token; the new `formatProviderCredentialHint` helper (composed into `formatMissingApiKeyError`) names the env var GJC reads, warns that a project `.env` is intentionally ignored for provider credentials, and points OpenCode users at the one-time interactive `gjc auth-broker login <provider>` credential capture to run before headless/print mode. No auth behavior changed.

## [0.5.3] - 2026-06-16

### Added

- Added opt-in `AuthStorageOptions.credentialRankingMode` (`balanced` (default) | `earliest-reset`) for multi-account OAuth credential selection. `earliest-reset` ranks non-blocked credentials earliest-expiry-first — draining the soonest-to-reset account before its perishable tumbling-window quota (e.g. Claude 5h/7d) is lost at reset — keeping the existing drain-rate/used-fraction metrics as tiebreakers. `balanced` is byte-identical to prior behavior, and ranking only runs at session start (or when the session's preferred credential is blocked), so this never thrashes accounts mid-session.

### Fixed

- Allowed `openai-codex-responses` custom backends to use opaque `apiKey` bearer tokens by omitting `chatgpt-account-id` when the token does not expose a Codex account id.
- Fixed OpenAI code websocket continuations to treat codex-lb's `codex_previous_response_stale` response failures as expired `previous_response_id` anchors and retry with full context instead of surfacing the transient failure.
- Bounded the Cursor provider's conversation cache with an LRU(64) + 1h TTL and added `disposeCursorConversation`, so long-running sessions no longer retain Cursor conversation state without limit (#717).

## [0.5.2] - 2026-06-15

### Changed

- Changed the Anthropic provider's default prompt-cache retention to `long` (`ttl: "1h"`) when a request and model omit `cacheRetention`. The previous default (~5m) was too fragile for long-running Codex/Gajae-Code subagent workflows, where the cached prefix was frequently evicted between turns. The 1h `ttl` marker is only emitted on the canonical Anthropic API (`api.anthropic.com`) for models advertising `supportsLongCacheRetention`; proxies, gateways, and models without that capability still fall back to the default ephemeral breakpoint (Anthropic services it at ~5m). Explicit request/model `cacheRetention` and the `GJC_CACHE_RETENTION`/`PI_CACHE_RETENTION` env overrides continue to win, and `resolveCacheRetention` now accepts a `fallback` argument (defaulting to `"short"`) so non-Anthropic providers are unaffected.

## [0.5.1] - 2026-06-14

### Fixed

- Classified model/message limit exhaustion as persistent usage-limit errors so hosts fail fast or switch credentials instead of leaving sessions in an unbounded retry/working state.

## [0.5.0] - 2026-06-13

### Added

- Added a generic tool-choice capability model: `toolChoiceSupport` compat enum (`none`/`auto`/`required`/`named`) available on every forced-choice-capable API, derived from the legacy `supportsToolChoice`/`supportsForcedToolChoice` booleans when absent, with a shared `resolveToolChoice` helper that clamps requested tool choices (`named` → `required` → omit) and returns structured degradation metadata.
- Added a transparent one-shot fallback for forced `tool_choice` 400s ("tool_choice forces tool use is not compatible with this model" and equivalents): transports retry once without the forced field at a pre-content streaming boundary, record the discovery in an in-memory per-process incapability registry, and emit an internal non-rendered `toolChoiceIncapability` event. Applies to Anthropic, OpenAI Completions/Responses, Azure Responses, OpenAI code Responses, Bedrock (including event-stream `validationException`), Ollama, Google, and Gemini CLI transports.
- Added bundled catalog entries for `kimi-code/kimi-k2.7-code`, `minimax-code/minimax-v3`, and `xai/grok-composer-2.5-fast`.
- Added composer-harness anchor/edit discipline injection for Cursor Composer and Grok Composer models so provider-specific coding harness priors do not override GJC hashline/edit contracts.

### Removed

- Removed the retired `anthropic/claude-fable-5` bundled catalog entry.

### Changed

- Moved the Claude Mythos forced-tool-use incapability knowledge out of Anthropic request code into catalog compat defaults (`toolChoiceSupport: "auto"`), applied during catalog generation, dynamic discovery, and bundled-model loading via a shared predicate.
- Google `toolConfig` mapping now sends `FunctionCallingConfig` mode `ANY` for both `required` and `any` requests instead of silently relaxing `required` to `AUTO`.
- Optimized `EventStream` queue draining with a head-indexed queue to avoid repeated array shifts in hot streaming paths.
- Clarified lazy builtin provider registration as the main provider loading path.

### Fixed

- Stripped `OpenAI-Beta` in the `openai-proxy` request transform profile so OpenAI-compatible proxies do not receive SDK beta headers.

## [0.4.5] - 2026-06-12

### Changed

- Bumped the spoofed Gemini CLI User-Agent version to 0.46.0 to track the upstream release.

### Fixed

- Fixed direct Anthropic requests for Claude Mythos-style models that support tools but reject forced tool use by omitting forced `tool_choice` while preserving `auto`/`none` choices.
- Preserved catalog transport metadata for opencode-go `qwen3.7-max` model resolution.
- Set SQLite auth-store `busy_timeout` before enabling WAL so initialization is reliable under contention.
- Resolved provider credentials from inherited or GJC-owned environment sources instead of trusting the caller project's `.env` overlays.
- Rendered and executed Cursor-native tool calls without dropping provider-specific call details.

## [0.4.4] - 2026-06-10

- Version aligned with the 0.4.4 monorepo release; no functional changes in this package.

## [0.4.2] - 2026-06-09

### Fixed

- Treated `gpt-5.5` as a 400K-context model wherever context caps / auto-promote thresholds are resolved, so a ~272K session is no longer considered over-cap and no longer demotes to `gpt-5.4`. Pinned the OpenAI Codex `gpt-5.5` context window to 400K and removed its `gpt-5.4` promotion target (the smaller window made it a demotion) ([#428](https://github.com/Yeachan-Heo/gajae-code/issues/428)).

## [0.4.0] - 2026-06-06

### Added

- Added minimax-m3 model support across MiniMax providers.
- Honored the `GJC_CACHE_RETENTION` environment variable and `cacheRetention` model config so hosts can control provider prompt-cache retention (#379/#381).
- Added an Opus max reasoning preset to the model thinking presets (#372).
- Refreshed the generated models schema for the new model/config surface (#382).

### Changed

- Pinned the OpenAI Codex provider default to GPT-5.5 at `xhigh` reasoning effort (#352). This changes the default model and effort for Codex users (latency/cost/quality impact) and is a behavior change, not an API break; pass an explicit model/effort to override.
- Bumped the spoofed Gemini CLI user-agent version to 0.45.2 to track the upstream release.

## [0.3.0] - 2026-06-03

### Added

- Added xAI to the `/login` provider catalog as a Grok OAuth login with PKCE, refresh-token storage, and mocked login/refresh coverage.

## [0.2.4] - 2026-06-02

### Added

- Added configurable provider request and stream retry budgets so hosts can bound transient upstream/server retry behavior separately from session-level retries.

## [0.2.2] - 2026-05-31

### Fixed

- Fixed Anthropic extended-thinking replay after aborted turns by dropping partial `thinking`/`redacted_thinking` blocks before the next request, preserving/synthesizing matching tool results, and retrying once with repaired latest-assistant thinking when Anthropic rejects a replay with the immutable-thinking HTTP 400 ([#107](https://github.com/Yeachan-Heo/gajae-code/issues/107)).
- Fixed first-class `azure-openai` catalog models so normal provider auth resolution reads `AZURE_OPENAI_API_KEY` when streaming `azure-openai/gpt-*` models.

## [0.2.1] - 2026-05-30

### Changed

- Refreshed AI package metadata for the GJC 0.2.1 release.

## [0.2.0] - 2026-05-28

### Fixed

- Fixed OpenAI-compatible base URL handling so configured proxy URLs and inherited environment overrides are respected at model discovery, completions, responses, and streaming call sites.
- Fixed OpenAI direct-provider feature gates so prompt-cache/session behavior uses the resolved Responses base URL and only treats exact default `api.openai.com` hosts/paths as direct OpenAI.

## [0.1.3] - 2026-05-28

### Changed

- Released the current dev branch fixes with refreshed 0.1.3 package metadata.

## [0.1.2] - 2026-05-28

### Changed

- Updated package metadata for the Gajae Code npm publication.

## [0.1.1] - 2026-05-28
### Breaking Changes

- Removed `findAnthropicAuth` from `anthropic-auth` and replaced store-driven auth discovery with `buildAnthropicAuthConfig`, requiring callers to provide an already-resolved API key before building Anthropic auth config

### Added

- Added `AuthStorage.getOAuthAccess` to return a refreshed OAuth access token with identity metadata (`accountId`, `email`, `projectId`, `enterpriseUrl`) for callers that need bearer-token headers together

### Changed

- Changed OAuth selection in `AuthStorage` to treat credentials as stale when they are within 60 seconds of expiry and rotate them preemptively
- Changed Google Gemini CLI, Google Gemini usage, Antigravity usage, and Kimi usage flows to stop refreshing OAuth tokens directly and rely on `AuthStorage` for token rotation

### Removed

- Removed provider-local OAuth refresh helpers from Google Gemini CLI and Google/Kimi/Antigravity usage probes, preventing direct refresh calls from those usage paths

### Fixed

- Fixed expired OAuth handling so provider-level paths no longer attempt direct token refresh calls for expired credentials and instead rely on `AuthStorage` for rotation
- Fixed `google-gemini-cli` / `google-antigravity` aborting heavy reasoning runs with "Provider stream timed out while waiting for the first event" before the upstream had a chance to emit its first SSE frame. Cloud Code Assist routinely takes >100s on Gemini 3.x Pro at high thinking levels; the lazy-stream wrapper now floors the first-event watchdog at 5 minutes for these two providers when neither `StreamOptions.streamFirstEventTimeoutMs` nor `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` pins a value. Other providers keep the 100s default. Internally, `getStreamIdleTimeoutMs` and `getStreamFirstEventTimeoutMs` now accept an optional per-provider `fallbackMs` so other slow-first-token providers can opt into the same widening without leaking through to the global default.
- Fixed Anthropic model Opus 4.7 on Amazon Bedrock streaming no reasoning output (and appearing to hang on long reasoning runs) because Anthropic silently switched the adaptive-thinking display default to `"omitted"`. The Bedrock provider now sends `thinking.display = "summarized"` by default on Opus 4.7+ adaptive models and on budget-based Anthropic model models, mirroring the existing direct-Anthropic behavior. `BedrockOptions.thinkingDisplay` (`"summarized" | "omitted"`) is exposed for callers that want to opt out, and `hideThinkingSummary` now wires through to the Bedrock case ([#1373](https://github.com/can1357/gajae-code/issues/1373)).
- Fixed Cursor Composer resume/tool-continuation turns failing with `Cannot send empty user message to Cursor API`. Empty current user turns now use Cursor's `resumeAction` instead of constructing an invalid `userMessageAction` ([#1376](https://github.com/can1357/gajae-code/issues/1376)).

## [15.3.2] - 2026-05-25
### Added

- Added `GET /v1/snapshot/stream` for live auth-broker snapshot updates via SSE with `snapshot`, `entry`, and `removed` event frames
- Added `AuthBrokerClient.openSnapshotStream()` for consuming SSE snapshot streams from `/v1/snapshot/stream`
- Added `streamSnapshots` option to `RemoteAuthCredentialStore` (default `true`) to enable or disable SSE-based snapshot synchronization
- Added `streamKeepaliveMs` to `startAuthBroker()` to tune heartbeat frequency for the SSE stream
- Added `AuthStorage.checkCredentials({ signal?, timeoutMs?, baseUrlResolver? })` that returns a per-credential `CredentialHealthResult` with tri-state `ok` (`true` / `false` / `null`-unverifiable), the credential's identity (provider, type, email/accountId, broker-refresh flag), and the upstream error string when the probe fails. Iterates sequentially over `listAuthCredentials()`, exercises OAuth refresh on expiry, then calls the per-provider `UsageProvider.fetchUsage` without swallowing errors — so callers can identify which row in a multi-account broker is producing 401s instead of getting a silently-deduplicated `fetchUsageReports` list.
- Added `GET /v1/credentials/check` to `startAuthGateway()` that forwards to `AuthStorage.checkCredentials` and returns `{ generatedAt, credentials }`. Gated by the same bearer as the rest of the gateway.

### Changed

- Changed `RemoteAuthCredentialStore` to prefer SSE snapshot streaming and automatically fall back to long-polling when a broker returns 404 for `/v1/snapshot/stream`
- Changed snapshot write-refresh flow so `RemoteAuthCredentialStore` skips immediate `/v1/snapshot` refreshes when SSE streaming is active
- Changed broker SSE stream behavior to keep connections open with periodic keepalives and an increased server idle timeout

## [15.3.0] - 2026-05-25

### Added

- Added DeepSeek to the built-in API-key login provider catalog so `gjc login deepseek` stores a reusable `DEEPSEEK_API_KEY` credential for the bundled DeepSeek models.

### Fixed

- Fixed `openai-responses` requests intermittently 400ing with `No tool call found for function call output with call_id …` after an aborted turn or a locally-rejected tool call (e.g. argument-validation failure). `convertConversationMessages` now folds orphan `function_call_output` / `custom_tool_call_output` items — those whose matching `function_call` was wiped by an earlier `dt: false` snapshot splice or never landed in any persisted provider payload — into assistant text notes, preserving the payload while keeping the request grammatically valid ([#1351](https://github.com/can1357/gajae-code/issues/1351)).

## [15.2.4] - 2026-05-22

### Fixed

- Fixed ChatGPT Plus/Pro (OpenAI code) OAuth login returning `Token exchange failed: 403` on Windows. When port 1455 was in use, the callback server silently fell back to a random port; OpenAI's authorization endpoint accepts any localhost redirect URI (loose validation), so the browser callback succeeds and shows "Authentication Successful", but the token endpoint rejects the non-registered port with 403. The `OpenAIOpenAI codeOAuthFlow` now enforces a fixed `redirectUri` option so a busy port immediately surfaces as "port unavailable" instead of producing a confusing 403 ([#1277](https://github.com/can1357/gajae-code/issues/1277)).
- Improved `exchangeCodeForToken` error diagnostics: the 403 response body (`error` / `error_description` fields) is now included in the thrown message, matching the existing `refreshOpenAIOpenAI codeToken` behaviour.

### Added

- Added `ChatGPT Plus/Pro (OpenAI code, headless/device)` (`openai-code-device`) as an alternative login method for the OpenAI code provider. Uses OpenAI's device-code flow (`/api/accounts/deviceauth/usercode` → poll `/api/accounts/deviceauth/token`), which avoids a local callback server and port 1455 entirely. Credentials are stored under the existing `openai-code` provider key so all models and tooling continue to work without reconfiguration ([#1277](https://github.com/can1357/gajae-code/issues/1277)).

## [15.2.2] - 2026-05-22

### Fixed

- Fixed `gemini-3.1-pro-high` and `gemini-3.1-pro-low` on the `google-antigravity` provider always returning HTTP 400 from Cloud Code Assist. The `ANTIGRAVITY_SYSTEM_INSTRUCTION` identity header was not injected for these models because the internal check matched the string `"gemini-3-pro-high"` (hyphen) instead of the versioned `"gemini-3.1-pro-..."` form. The guard now matches all `gemini-3` model variants ([#1274](https://github.com/can1357/gajae-code/issues/1274)).

## [15.2.0] - 2026-05-21

### Fixed

- Fixed `/login` (and `/logout`, plus any `AuthStorage.set` / `remove` call) against a remote auth-broker throwing `RemoteAuthCredentialStore is read-only on the client. Use 'gjc auth-broker login <provider>' to mutate credentials.` Added three optional async write hooks to `AuthCredentialStore` (`upsertAuthCredentialRemote`, `replaceAuthCredentialsRemote`, `deleteAuthCredentialsRemote`); `RemoteAuthCredentialStore` implements them via the broker's `POST /v1/credential` and `POST /v1/credential/:id/disable` endpoints and applies the broker's authoritative post-write entries to the local snapshot. `AuthStorage` routes through the hooks when present, so OAuth and API-key logins (and logouts) initiated from a broker-backed client now persist server-side and surface immediately without waiting for the long-poll snapshot tick.

## [15.1.9] - 2026-05-21

### Fixed

- Fixed Ollama named tool forcing to send only the requested tool when the caller passes a named `toolChoice`, preserving `tool_choice: "required"` while preventing local models from selecting a different tool. ([#1236](https://github.com/can1357/gajae-code/issues/1236))
- Fixed `/btw` (and IRC background replies) returning a `BedrockException` 400 (`The toolConfig field must be defined when using toolUse and toolResult content blocks.`) on LiteLLM → Bedrock once the session has tool-call history. Two source fixes in `buildParams`: (1) `if (context.tools)` → `if (context.tools?.length)` so an explicit `context.tools = []` (the /btw opt-out) never routes through `convertTools` and never emits an empty `"tools"` array; (2) `else if (hasToolHistory(...))` → `else if (context.tools === undefined && hasToolHistory(...))` so the Anthropic-proxy sentinel that injects `tools: []` for tool-history turns is suppressed when the caller explicitly opted out, preventing it from re-introducing the empty array. As defence-in-depth, `tool_choice: "none"` is also dropped when the resolved tools list is missing or empty. ([#1227](https://github.com/can1357/gajae-code/issues/1227))

## [15.1.8] - 2026-05-20
### Added

- Added Fireworks Fire Pass as a separate `firepass` provider with API-key login flow, bundled `kimi-k2.6-turbo` model entry (Kimi K2.6 Turbo), and wire-id translation from the friendly catalog id to the `accounts/fireworks/routers/kimi-k2p6-turbo` router endpoint. Fire Pass keys (`fpk_…`) authorize only the dedicated router and reject `/v1/models`, so login validation pings chat completions against the router id directly. Extended the openai-completions Kimi-family safety net so the firepass entry inherits the per-Fireworks-docs "always send `max_tokens`" default ([Kimi K2 guide](https://docs.fireworks.ai/models/kimi-k2)); the router's accepted `reasoning_effort` set includes `xhigh`, so it is forwarded verbatim rather than remapped. See https://docs.fireworks.ai/firepass.

### Fixed

- Fixed DeepSeek V4 direct API requests with tools to keep documented thinking mode instead of dropping reasoning: lower GJC efforts now map to DeepSeek's supported `high`, `tool_choice` is omitted, `thinking: { type: "enabled" }` and `max_tokens` are sent, and partial user `reasoningEffortMap` overrides merge with DeepSeek defaults. ([#1207](https://github.com/can1357/gajae-code/issues/1207))
- Fixed model cache schema v2 databases so offline refreshes preserve cached provider discoveries after upgrading to schema v3 and subsequent online refreshes can overwrite the cache. ([#1219](https://github.com/can1357/gajae-code/issues/1219))
- Fixed Perplexity OAuth credentials being treated as expired one hour after login. `getJwtExpiry` was fabricating `expires = now + 1h` whenever the JWT had no `exp` claim (the common case — Perplexity sessions are server-side). Once the hour elapsed, `getOAuthApiKey` would mark the cred expired and the search provider's loader would silently skip it, surfacing as "logged out". Logins with no `exp` now persist a far-future sentinel; `getOAuthApiKey` also normalizes any stale `expires` written by older builds.

## [15.1.7] - 2026-05-19
### Added

- Added Anthropic realization of `serviceTier: "priority"`. The anthropic-messages provider now sets `speed: "fast"` on the request and appends the `fast-mode-2026-02-01` beta to `Anthropic-Beta` whenever the caller passes `serviceTier: "priority"`. When the server rejects an unsupported model with `invalid_request_error`, the provider transparently retries the same turn without the fast-mode signal (mirroring the strict-tools fallback pattern), persists the disable via a new `providerSessionState.fastModeDisabled` flag so subsequent requests in the session skip the field, and surfaces the action via the new `AssistantMessage.disabledFeatures` array (id `"priority"`) so callers can sync user-facing toggles. A new `clearAnthropicFastModeFallback(providerSessionState)` helper lets callers re-arm priority after the auto-fallback fired.
- Added scoped `ServiceTier` values: `"openai-only"` (priority on `openai`/`openai-code`, ignored elsewhere) and `"anthropic-model-only"` (priority on direct `anthropic`, ignored on Bedrock/Vertex Anthropic model and elsewhere). A new `resolveServiceTier(serviceTier, provider)` helper computes the effective tier for the provider; existing OpenAI/Anthropic provider code routes through it, so `service_tier` and Anthropic fast-mode emission both respect scope. `getPriorityPremiumRequests` now counts Anthropic+priority as one premium request (previously zero) and continues to ignore providers that drop the field on the wire.

### Fixed

- Fixed Anthropic fast mode (`serviceTier: "priority"`) looping on 429 `rate_limit_error: "Extra usage is required for fast mode."` for accounts without the extra-usage entitlement. `isAnthropicFastModeUnsupportedError` now matches the 429 phrasing in addition to the 400 `invalid_request_error` "does not support the `speed` parameter" case, so the provider drops `speed: "fast"` on the in-turn retry, sets `providerSessionState.fastModeDisabled` for the remainder of the session, and surfaces `disabledFeatures: ["priority"]` to the caller instead of retrying with the same payload until `PROVIDER_MAX_RETRIES` is exhausted.
- Fixed MiniMax Coding Plan CN streaming `<think>...</think>` reasoning as visible assistant text. The OpenAI-compatible stream parser now enables the existing MiniMax tag parser for both `minimax-code` and `minimax-code-cn`, so CN responses become structured `thinking` blocks instead of raw text. ([#1203](https://github.com/can1357/gajae-code/issues/1203))

## [15.1.6] - 2026-05-19

### Fixed

- Fixed `{}` (empty JSON Schema, the wire representation of `z.unknown()`) being passed verbatim to grammar-constrained samplers (llama.cpp, etc.) in `additionalProperties`, `items`, and other schema-valued positions across **every provider** (OpenAI, Anthropic, Google, Ollama, Bedrock, Cursor). Grammar builders treat `{}` as "generate an empty object" rather than "any JSON value", causing open-typed fields (e.g. `extra.title` from `z.record(z.string(), z.unknown())`) to always emit `{}` instead of the intended string/number/etc. `toolWireSchema` now applies a new `normalizeEmptySchemas` pass (exported) to both the Zod and TypeBox/raw-JSON-Schema branches, converting `{}` → `true` (semantically identical per JSON Schema draft 2020-12 §4.3.1) in all schema-valued positions. Strict-mode opt-out is preserved across all providers: OpenAI's `hasUnrepresentableStrictObjectMap` hits the `=== true` branch instead of the `isJsonObject({})` branch (same result); Anthropic's `normalizeAnthropicStrictSchemaNode` opts out via `additionalProperties !== false` (still true for `true`); Google's `normalizeSchemaForGoogle` strips `additionalProperties` regardless (pre-existing). ([#1179](https://github.com/can1357/gajae-code/issues/1179))
- Fixed `pi-ai login <provider>` crashing with `Unknown provider` for providers that only the `auth-storage` `login()` switch knew about (perplexity, alibaba-coding-plan, gitlab-duo, huggingface, opencode-zen/go, lm-studio, ollama, cerebras, fireworks, qianfan, synthetic, venice, litellm, moonshot, together, cloudflare/vercel ai gateways, vllm, qwen-portal, nvidia, xiaomi, and any custom OAuth provider). The CLI now delegates to `SqliteAuthCredentialStore.login()` instead of duplicating a smaller switch, so the auth-broker `gjc auth-broker login <provider>` flow works for every registered OAuth provider.

## [15.1.4] - 2026-05-19
### Changed

- Updated auth-gateway format and pi-native request handling to invalidate the failed API key and retry the provider request with a replacement key when authentication fails

### Fixed

- Fixed OpenCode-Go and OpenCode-Zen chat-completions replay to omit stored reasoning fields on Kimi assistant tool-call messages, avoiding provider 400s for rejected `messages[].reasoning` payloads. ([#1157](https://github.com/can1357/gajae-code/issues/1157))
- Fixed OpenAI Responses and OpenAI code tool schema normalization to emit `properties: {}` for no-argument object schemas without rewriting literal payloads. ([#1147](https://github.com/can1357/gajae-code/issues/1147))
- Fixed Anthropic 400 (`unexpected tool_use_id found in tool_result blocks ... Each tool_result block must have a corresponding tool_use block in the previous message`) when handoff/compaction folds an assistant `tool_use` into the handoff summary string but leaves the matching user-side `tool_result` message in the history. `transformMessages` now indexes every `tool_use` id surviving the first pass and drops orphan `tool_result` messages whose originator was compacted away, preserving the text payload as a user-level `<stale-tool-result>` note so the model still sees what the tool returned. The note is emitted with `role: "user"` rather than `role: "developer"` so providers that elevate developer-role messages (Ollama: `developer` → `system`; OpenAI chat-completions reasoning models: `developer` → `developer`) cannot lift stale tool output to an instruction-priority tier above the surrounding user/developer messages.
- Fixed streaming authentication retry to trigger when a provider emits a 401 `error` event after a `start` event but before any replay-unsafe content is emitted
- Added `credential_process` support to the Bedrock provider's AWS credential resolver so profiles delegating to external brokers (`aws-vault`, `granted`, in-house tools) resolve instead of falling through to `Unable to resolve AWS credentials`. Parses the AWS SDK `Version: 1` JSON envelope, honors `Expiration` in the per-profile cache, propagates `AbortSignal` to the spawned helper, routes Windows `.cmd`/`.bat` helpers through `cmd.exe /c`, and ships a POSIX-shell-style tokenizer that preserves backslashes inside double quotes so Windows paths survive ([#1142](https://github.com/can1357/gajae-code/issues/1142))

## [15.1.3] - 2026-05-17
### Breaking Changes

- Changed `AuthBrokerClient.fetchSnapshot()` to return status-based results (`200` or `304`) instead of always returning a raw snapshot body, so callers now need to branch on `status`
- Renamed public schema utilities in `@gajae-code/ai/utils/schema` by replacing `sanitizeSchemaForGoogle`, `sanitizeSchemaForCCA`, `prepareSchemaForCCA`, and `sanitizeSchemaForMCP` with `normalizeSchemaForGoogle`, `normalizeSchemaForCCA`, and `normalizeSchemaForMCP`
- Added MCP schema normalization via `normalizeSchemaForMCP` for compatibility checks
- Removed the `StringEnum` helper from `@gajae-code/ai/utils/schema`. Use `z.enum([...])` directly; Zod's emitted JSON Schema is already wire-compatible with Google and other providers.
- Renamed the concrete SQLite credential store class from `AuthCredentialStore` to `SqliteAuthCredentialStore`. `AuthCredentialStore` is now the persistence interface implemented by both the SQLite store and the new `RemoteAuthCredentialStore`. Update `new AuthCredentialStore(db)` / `AuthCredentialStore.open(...)` call-sites to `SqliteAuthCredentialStore`; type-position uses (`store: AuthCredentialStore`) continue to work unchanged.

### Added

- Added `onAuthError` to `StreamOptions` and wired `streamSimple()` to retry once with a replacement API key when the first provider response is a 401 before any assistant events are emitted
- Added generation-aware snapshot metadata (`generation`, `serverNowMs`, `refresher`, and `rotatesInMs`) to auth-broker snapshot responses to support client-side credential-rotation planning
- Added `transport: "pi-native"` on `Model` and the matching `streamPiNative` client. When `model.transport === "pi-native"`, `streamSimple` short-circuits the per-provider dispatch and POSTs the canonical `Context` to the auth-gateway's `POST /v1/pi/stream` endpoint. The response is SSE-framed `AssistantMessageEvent`s parsed by `readSseJson` and pushed verbatim into the local `AssistantMessageEventStream` — no wire-format translation, no partial-stripping reconstruction. Used by containerized GJC deployments and swarm extensions to route every LLM call through a credential-holding sidecar; the container never sees the real provider tokens. Server-controlled fields (`apiKey`, `signal`, `fetch`, lifecycle callbacks, the provider-session map) are stripped from the wire body — `apiKey` rides in the `Authorization` header as the gateway bearer.
- Added `POST /v1/pi/stream` to the auth-gateway. Same auth + abort + model-resolution + openai-code-compat + prefix-cache plumbing as the foreign-wire routes; only the wire-format translation is skipped. Request body is `{ modelId, context, options?, stream? }` where `context` is the canonical pi-ai `Context` and `options` is `SimpleStreamOptions` with non-serializable fields stripped. Response is SSE-framed `AssistantMessageEvent` (terminated by `data: [DONE]`) when streaming, or `{ message: AssistantMessage }` JSON when `stream: false`.
- Added Vertex AI authentication via Google Application Default Credentials from `GOOGLE_APPLICATION_CREDENTIALS`, `~/.config/gcloud/application_default_credentials.json`, or metadata server tokens, with token caching and refresh skew control via `GOOGLE_VERTEX_REFRESH_SKEW_MS`
- Added support for Anthropic image message parts with `type: "url"` and `type: "file"` sources
- Added `stopSequences` and `frequencyPenalty` to shared stream options and wired them through to OpenAI request translation
- Added optional request cancellation support to auth-broker interactions by propagating `AbortSignal` into health, snapshot, usage, and refresh calls
- Added `AuthStorage.setConfigApiKey` / `removeConfigApiKey` / `clearConfigApiKeys` for config-sourced per-provider bearers (e.g. `models.yml` `providers.<name>.apiKey`). The new tier sits between runtime `--api-key` and stored credentials in `getApiKey`/`peekApiKey` resolution, so a bearer pinned in config now beats the broker's OAuth access token. Also suppresses OAuth `account_uuid` attribution when active, since outbound auth is the explicit config bearer, not OAuth. `describeCredentialSource` reports `"config override (models.yml)"` for visibility.
- Added per-model `additional_rate_limits` parsing to `openaiOpenAI codeUsageProvider`. The OpenAI code `wham/usage` endpoint surfaces a separate `GPT-5.3-OpenAI code-Spark` rate limit (`metered_feature: openai-code_bengalfox`) on Pro accounts; these now emit dedicated `openai-code:spark:{primary,secondary}` `UsageLimit` entries with `scope.tier = "spark"`, mirroring how Anthropic exposes `anthropic:7d:sonnet` separately from the umbrella `anthropic:7d` bucket. The osx-widgets client already keyed spark detection off `limit.id.includes("spark")`; this populates that contract end-to-end.
- Added `GET /v1/usage` to the auth-broker API to expose aggregated usage reports from `AuthStorage.fetchUsageReports`
- Added auth-broker usage polling response handling that returns normalized usage reports plus generation timestamp for clients (5-min per-credential cache via `AuthStorage`)
- Added the auth-broker subsystem (`@gajae-code/ai/auth-broker`) for sharing OAuth credentials across machines without leaking refresh tokens.
- `startAuthBroker(...)` boots a `Bun.serve` HTTP server exposing `GET /v1/healthz`, `GET /v1/snapshot`, `POST /v1/credential` (upsert), `POST /v1/credential/:id/refresh`, and `POST /v1/credential/:id/disable`.
- `AuthBrokerClient` is the matching HTTP client used by remote clients.
- `RemoteAuthCredentialStore` is a client-side `AuthCredentialStore` that mirrors a broker snapshot in memory; mutating methods (`replace*`, `upsert*`, `delete*ForProvider`) throw because writes are server-side only.
- `AuthBrokerRefresher` is the background refresh loop that pre-refreshes credentials within `refreshSkewMs` and disables on definitive failure (`invalid_grant` / non-network 401-403).
- Added `AuthStorage.exportSnapshot()`, `AuthStorage.upsertCredential(provider, credential)`, `AuthStorage.forceRefreshCredentialById(id)`, and `AuthStorage.disableCredentialById(id, cause)` public methods consumed by the auth-broker server.
- Added `AuthStorageOptions.refreshOAuthCredential` override so a remote-store client can route every OAuth refresh through the broker instead of the local OAuth endpoint.
- Added `REMOTE_REFRESH_SENTINEL` (`"__remote__"`) — the wire placeholder substituted for OAuth refresh tokens in broker snapshots; clients never see the real refresh token.
- Exposed the OAuth provider catalog (`getOAuthProviders`, `OAuthProvider`, `OAuthProviderInfo`) and `refreshOAuthToken` through the package barrel so the coding-agent CLI can target them without reaching into `utils/oauth`.
- Added the auth-gateway subsystem (`@gajae-code/ai/auth-gateway`) — a forward-proxy that sits between unauthenticated clients (the macOS usage widget, llm-git, containerized GJC deployments, …) and the broker. Clients send standard provider-format requests; the gateway parses them into gjc's canonical `Context`, dispatches through pi-ai's `streamSimple()`, and translates the canonical event stream back to the matching wire format. `Authorization` is injected server-side so access tokens never leave the gateway host. Wire surface:
- `GET  /healthz` — unauth liveness.
- `GET  /v1/usage` — aggregated provider usage; 5-min per-credential cache via `AuthStorage.fetchUsageReports`.
- `GET  /v1/models` — model catalog (scoped to providers with credentials).
- `POST /v1/chat/completions` — OpenAI chat-completions in/out.
- `POST /v1/messages` — Anthropic messages in/out (text + thinking + tool_use blocks, SSE event taxonomy preserved).
- `POST /v1/responses` — OpenAI Responses in/out (reasoning items + function_call output items, SSE pass-through).
- Added exports from `@gajae-code/ai/auth-gateway`: `startAuthGateway`, `AuthGatewayServerOptions`, `AuthGatewayBootOptions`, `AuthGatewayServerHandle`, `ModelResolver`, `DEFAULT_AUTH_GATEWAY_BIND`. Per-format `parseRequest` / `encodeResponse` / `encodeStream` triples are reachable via the `./providers/*` subpath as `openai-chat-server`, `anthropic-messages-server`, and `openai-responses-server`.
- Added `listProvidersWithEnvKey()` to enumerate every provider with an env-var fallback (used by the new migrate command in coding-agent).

### Changed

- Changed `GET /v1/snapshot` to support generation-based polling with `If-None-Match` and `wait` for long-poll updates and to return `304` when no snapshot changes are available
- Changed Bedrock credential resolution for streaming calls to prefer environment keys, AWS profile/SSO credentials, and IMDSv2 fallback when available
- Changed auth-gateway parsing for OpenAI chat-completions and Responses to ignore unsupported SDK-only fields instead of rejecting requests
- Changed auth-gateway protocol handling to include CORS headers on responses and support browser-origin requests
- Changed prompt-cache handling to resolve cache keys from request metadata and headers and preserve them through protocol translation
- Changed Anthropic messages parsing to forward request `metadata` through to downstream execution
- Changed usage report caching to use a 5-minute per-credential TTL with jittered refresh timing to reduce usage endpoint rate-limit collisions
- Changed usage polling failure handling so transient errors continue serving the last known report instead of returning null and dropping the credential from usage aggregates after cache expiry
- Changed `sanitizeSchemaForGoogle` to normalize snake_case schema keys (such as `any_of` and `additional_properties`) to camelCase and auto-generate `propertyOrdering` for multi-property objects
- Changed strict-mode sanitization to resolve `$ref` nodes with sibling keys by inlining and merging referenced local definitions
- Changed strict-mode sanitization to flatten single-entry `allOf` nodes and remove the `allOf` wrapper
- Changed Anthropic tool schema normalization to preserve supported metadata keywords such as `$ref`, `$defs`, `$schema`, `enum`, `const`, `default`, `title`, and `nullable` instead of stripping them
- Changed string schema processing to retain only supported `format` values (`date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`) and demote unsupported `format` values to `description` hints

### Fixed

- Fixed OAuth credential refresh flow so concurrent manual and background refreshes now share one in-flight attempt per credential, and `RemoteAuthCredentialStore` now re-synchronizes before using near-expiring OAuth credentials
- Fixed stale-credential handling after auth failures by waiting for updated broker snapshots and refreshing suspect credentials through broker endpoints before continuing
- Fixed Google Generative AI startup behavior to throw a clear API-key-required error when no key is configured
- Fixed AWS Bedrock image message serialization to preserve base64 `source.bytes` payloads instead of decoding and rebuilding them
- Fixed Google provider error handling to extract the API-reported `error.message` from JSON response bodies when available
- Fixed `RemoteAuthCredentialStore.getUsageReport` to return the matching credential-specific usage report and coalesce parallel callers into one broker `/v1/usage` fetch
- Fixed auth-broker credential upload validation to reject the remote refresh-token sentinel and prevent storing a non-refresh value
- Fixed OpenAI Responses streaming output to emit `reasoning_summary_text` events and parse/send `summary_text` reasoning payloads
- Fixed Anthropic stop-sequence handling by trimming requests to the API limit of four entries before forwarding
- Fixed prompt caching behavior across protocol translations so cached-token usage is preserved when Anthropic and OpenAI requests are routed through each other
- Fixed Anthropic model usage fetching to retry transient `429` and `5xx` responses with exponential backoff, respecting `Retry-After` before returning failure
- Fixed auth-gateway request translation to preserve OpenAI Responses string/system message content, reasoning replay payloads, completed item text in stream item-done events, Anthropic tool-result ordering, and OpenAI Chat/Responses cached-token usage totals
- Fixed auth-gateway failure handling so unsupported request controls, upstream terminal errors, non-streaming aborts, and already-aborted client requests fail explicitly instead of being accepted, ignored, or encoded as successful HTTP 200 responses
- Fixed Gemini CLI / Antigravity tool schema normalization to run the full Cloud Code Assist pipeline, matching shared Google schema handling for union/object merging and nullable extraction
- Fixed stripped validation hints to be preserved as description spill text (`{key: value}` blocks) when `normalizeSchemaForGoogle` and `normalizeSchemaForCCA` drop unsupported schema keywords
- Fixed `sanitizeSchemaForGoogle` to collapse nullability forms (`type:'null'` and null-bearing `anyOf` variants) into `nullable` while preserving remaining variants
- Fixed `sanitizeSchemaForGoogle` to inline local `$defs` references instead of dropping `$ref`/`$defs` structure during Google schema sanitization
- Fixed `normalizeAnthropicToolSchema` to handle self-referential schemas without infinite recursion
- Fixed object schema normalization so explicit open-map declarations (`additionalProperties: true` and schema-valued `additionalProperties`) are preserved instead of being converted to closed objects
- Fixed unsupported schema constraints on arrays and strings (`maxItems`, `uniqueItems`, `pattern`, `minLength`, `maxLength`, and `minItems` when greater than 1) by demoting them into `description` rather than dropping them

### Security

- Hardened auth-gateway bearer-token checks with constant-time comparison to avoid timing-side-channel leaks

## [15.1.2] - 2026-05-15
### Breaking Changes

- Rejected draft-07 tuple and dependency keywords (`items` arrays, `dependencies`, `additionalItems`) in JSON Schema validation

### Added

- Added `responseHeaders`, `responseStatus`, and `responseRequestId` fields to `MockResponse` so mock providers can provide synthetic `ProviderResponseMetadata`
- Added `onResponse` metadata emission for mocks that sends lowercased headers and a default status of 200 before streaming when response headers are configured
- Added recursive strict-mode sanitization for array `prefixItems` entries so tuple schemas now enforce object constraints per item

### Changed

- Normalized legacy draft-07 JSON Schema constructs used in tool parameters (`items` arrays, `additionalItems`, `definitions`, `dependencies`) to draft 2020-12 before OpenAI/Google/CCA sanitization, wire conversion, and argument validation
- Reworked OpenAI response schema adaptation to rewrite `oneOf` into `anyOf` while preserving existing `anyOf` branches
- Changed tuple array validation to validate per-index schemas from `prefixItems` and apply `items` only to remaining elements

### Fixed

- Fixed validation of plain JSON Schema tool arguments that omitted a `$schema` URI so draft-07-shaped schemas now pass validation instead of being rejected
- Fixed tuple-array validation for legacy JSON Schema tool schemas to enforce `additionalItems: false` and per-position constraints after automatic draft upgrade
- Fixed Anthropic tool schema normalization to recurse into `prefixItems` so unsupported constraints inside tuple items are stripped in the generated input schema
- Fixed Anthropic tool-schema normalization stripping the body of explicit open `additionalProperties` (e.g. Zod's `z.record(z.string(), z.unknown())` compiling to `additionalProperties: {}`) by unconditionally overwriting it with `false`, which closed record-style fields and prevented models from supplying any key. The coding-agent's `resolve` tool exposes plan-approval titles via such a field, so Kimi K2 (and any other Anthropic-shaped provider) could not pass `extra: { title }`, blocking plan mode entirely ([#1104](https://github.com/can1357/gajae-code/issues/1104))
- Fixed Anthropic strict tool planning to leave tools with open `additionalProperties` maps non-strict instead of sending schemas Anthropic rejects.

## [15.1.0] - 2026-05-15

### Breaking Changes

- Removed TypeBox root exports (`Type`, `Static`, and `TSchema`) from the package entrypoint, so callers importing those symbols from `@gajae-code/ai` must migrate to `zod` or `@gajae-code/ai/types`

### Added

- Added support for defining tool schemas with Zod (`z.object`, `z.string`, etc.) by allowing `Tool.parameters` to be either Zod schemas or legacy JSON Schema objects and converting them to provider wire format automatically
- Added package-level schema helpers in the `zod/v4` style by exporting `z` and `ZodType` from the root entrypoint
- Added a `mock` API provider via `createMockModel` to build `Model<"mock">` instances for fully in-memory, deterministic assistant streams in tests
- Added `streamMock` and `registerMockApi` so mock responses can be consumed through `stream()` and the global custom API registry without an external model backend
- Added async/sync response scripting with optional context-based handlers, and new `push()`/`reset()` controls to drive multi-turn mock interactions and inspect per-call invocation state
- Added support in mock responses for simulating tool calls, usage metadata, custom stop reasons, delayed emissions, and terminal error/aborted outcomes

### Changed

- Changed Azure OpenAI Responses tool schema conversion to sanitize tool parameter schemas and rewrite `oneOf` branches as `anyOf` so tool calls remain compatible with Azure's schema expectations
- Changed `Static<S>` to extract a schema object’s `static` type when present, improving inferred tool argument types for non-Zod parameter definitions
- Changed `Static` typing behavior so it now infers argument types from Zod schemas and defaults to `unknown` for non-Zod JSON Schema parameter definitions
- Restored the default steady-state stream idle timeout to 120s (regressed in 15.0.0). 30s was too aggressive for reasoning models, slow proxies, and tool-call planning gaps, surfacing as repeated `Provider stream stalled while waiting for the next event` errors. Existing `PI_STREAM_IDLE_TIMEOUT_MS` / `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` overrides are unchanged.

### Fixed

- Preserved top-level unknown fields in validated tool-call arguments so extra root properties are retained after schema coercion
- Fixed coercion for Zod `record` fields by parsing JSON-stringified record arguments into objects
- Validated legacy draft-07 JSON Schema tool parameters directly instead of converting through Zod, improving support for features like `$ref`, `definitions`, `nullable`, and `uniqueItems`
- Fixed Cloud Code Assist schema preparation to strip unsupported `propertyNames` and fall back to a minimal tool schema when schema meta-validation detects malformed keywords
- Fixed OpenAI Completions streaming to avoid treating non-output chunks (including role-only preambles) as progress events so idle-timeout watchdog behavior no longer hangs on no-op streamed chunks
- Fixed Cloud Code Assist schema compatibility checks by replacing strict AJV meta-schema validation with structural JSON Schema validation to avoid rejecting structurally valid tool schemas
- Fixed lazy built-in provider streams (`anthropic-messages`, `bedrock-converse-stream`, `cursor-agent`, `google-*`, `ollama-chat`, `openai-*`) prematurely aborting slow first-token responses with `Provider stream stalled while waiting for the next event`. The lazy-stream watchdog wrapper was treating the synthetic `start` event (yielded immediately by every provider before the model emits any tokens) as the first real item, which caused the watchdog to drop from `firstItemTimeoutMs` (100s) to `idleTimeoutMs` (30s) before the upstream model had produced anything. The shared `iterateWithIdleTimeout` now keeps `awaitingFirstItem` true until a real progress item arrives, and the lazy-stream wrapper marks `start` as a non-progress keepalive ([#1073](https://github.com/can1357/gajae-code/pull/1073) regression).
- Heal leaked Kimi K2 chat-template tool-call tokens (`<|tool_calls_section_begin|>` … `<|tool_call_argument_begin|>` … `<|tool_calls_section_end|>`) that some hosts (native `kimi-code` API, OpenRouter, Fireworks, etc.) emit into `delta.content` instead of structured `tool_calls`. The OpenAI-completions stream consumer now strips the markers from visible text, reconstructs the embedded calls as proper `toolCall` content blocks (stream-aware, token-boundary-safe), and promotes `finish_reason: stop` to `toolUse` when calls were healed.
- Fixed OpenAI-completions Kimi K2 healed-call promotion clobbering non-stop terminal finish reasons (`error`, `length`, `aborted`); promotion now only fires when the prior stop reason is the natural-completion `stop`
- Fixed OpenAI-completions duplicate Kimi tool calls when a single chunk delivers both leaked markers and a structured `delta.tool_calls`; the healer now strips visible markers but discards its synthesized calls so structured payloads remain the single source of truth
- Fixed Kimi tool-call healer synthesizing a bogus empty call when assistant text mentions a literal `<|tool_call_end|>` (or `<|tool_call_begin|>` / `<|tool_call_argument_begin|>`) outside an active `<|tool_calls_section_begin|>…<|tool_calls_section_end|>` section; the tokens now survive as text
- Fixed OpenAI-completions ignoring per-request `StreamOptions.streamFirstEventTimeoutMs` when configuring the underlying OpenAI SDK HTTP timeout, causing slow-before-headers providers to be aborted at the env default before the wrapping watchdog armed
- Fixed JSON Schema validator silently accepting values that violate `propertyNames`, `patternProperties`, `dependentRequired`, `dependencies`, `if`/`then`/`else`, `contains`, and `prefixItems`; the in-tree validator now enforces these keywords instead of falling through. `unevaluatedProperties`/`unevaluatedItems` remain permissive but log a one-time warning so tool authors are not surprised.
- Fixed recursive `$ref` schemas being treated as universally valid: the validator previously short-circuited on the second occurrence of any ref it had already seen, so nested values violating the referenced sub-schema passed. Cycle detection now keys on (ref, value-identity) pairs with a depth cap for primitive values, so genuine sub-tree violations are still caught.
- Fixed JSON Schema meta-validator accepting malformed `if`/`then`/`else` and `dependencies` keywords; each conditional sub-schema is now structurally validated and draft-07 `dependencies` accepts either a schema or a string array of dependent keys.
- Fixed Zod-emitted wire schemas dropping null-valued unknown root fields before `preserveUnknownRootFields` could snapshot them, so callers like `task.simple` no longer lose a `schema: null` argument and downstream rejection paths fire as intended.
- Fixed mock provider partial `Usage` to recompute `totalTokens` (and `cost.total` when cost components are supplied) when omitted, instead of reporting 0
- Fixed mock provider auto-generated tool-call IDs to use a per-instance counter (now reset by `reset()`), so test order no longer affects IDs across `createMockModel()` instances

## [15.0.2] - 2026-05-15
### Fixed

- Fixed `StreamOptions.fetch` typing to accept fetch-compatible override functions that do not expose `preconnect`, allowing custom fetch implementations to be used without type errors across runtimes
- Fixed Moonshot Kimi K2.6 forced tool calls to send `thinking: { type: "disabled" }`, avoiding `tool_choice 'specified' is incompatible with thinking enabled` 400s while preserving the requested named tool ([#1077](https://github.com/can1357/gajae-code/issues/1077)).

## [15.0.1] - 2026-05-14
### Breaking Changes

- Increased the minimum Bun runtime version to `>=1.3.14` for the `@aws-?` package

### Added

- Added `installH2Fetch` to patch `globalThis.fetch` so HTTPS requests attempt HTTP/2 over ALPN with automatic HTTP/1.1 fallback when HTTP/2 is unsupported
- Added priority service-tier traffic to the `premiumRequests` accounting on OpenAI and OpenAI code provider providers. Sending `serviceTier: "priority"` now increments `usage.premiumRequests` by 1 per request, matching the existing GitHub Copilot premium-request budget semantics so downstream consumers (e.g. the `gjc stats` "Premium Reqs" card and `/usage`) reflect priority traffic alongside Copilot premium calls.

## [15.0.0] - 2026-05-13

### Added

- Added `AuthStorage.onCredentialDisabled(listener)` — a multi-subscriber `on/off` API for `credential_disabled` events. Returns an unsubscribe function; calling it more than once is a no-op. Multiple subscribers all receive every disable event, with synchronous and async exceptions isolated per-listener so a misbehaving subscriber cannot starve the rest of the chain. Buffer-and-replay semantics are preserved: events emitted while no listener is subscribed are buffered (FIFO, capped at 32) and replayed once to the listener that triggers the empty→non-empty transition. After every subscriber unsubscribes, subsequent disable events buffer again until the next subscribe.

### Fixed

- Fixed OAuth credentials being silently disabled when two gjc processes (or any two `AuthStorage` instances sharing a `agent.db`) race on token refresh. Anthropic rotates refresh tokens on every use, so the loser's `invalid_grant` response previously soft-deleted the row that the winner just rotated, forcing the user to `/login` again. `#tryOAuthCredential` now re-reads the row from disk before declaring a definitive failure: if the persisted `refresh` differs from the snapshot it tried, the peer-rotated credential is reloaded and the request retries against the fresh token instead of disabling the live row.
- Closed a remaining race window in OAuth refresh-failure handling: between re-reading the credential row to check for peer rotation and the subsequent soft-delete, another process could still complete a refresh and rotate the row, leaving us to disable the freshly-rotated credential by `id`. The disable now runs as a single CAS update conditioned on the row's `data` still matching the snapshot we tried to refresh, and on `disabled_cause IS NULL`. If the CAS reports 0 rows changed (peer rotation, or row already disabled by a concurrent failure on the same snapshot), we reload from disk and retry instead of mutating the wrong row or emitting a spurious `credential_disabled` event.
### Changed
- Lowered the default steady-state stream idle timeout from 120s to 30s while preserving the existing environment overrides.

### Fixed
- Lazy built-in provider streams now enforce the shared idle watchdog and abort stalled provider requests, so session auto-retry can continue after transient network drops instead of remaining stuck. Caller aborts still terminate as aborted.

## [14.9.3] - 2026-05-10

### Fixed
- Anthropic provider now retries generic transient connect failures (`unable to connect`, `fetch failed`, `connection error`, etc.) by falling back to the shared `isRetryableError` allowlist after the provider-specific patterns. Previously these errors bypassed the hand-curated regex in `isProviderRetryableError` and aborted the stream on the first attempt, while the OpenAI SDK and OpenAI code `fetchWithRetry` paths already handled them.

## [14.9.0] - 2026-05-10

### Added

### Fixed
- Fixed silent forwarding of image content (for example Python plot output rendered in the terminal) to models without vision support, which produced opaque 404 errors from upstream. Image blocks are now stripped and replaced with a `[image omitted: model does not support vision]` placeholder for non-vision models, including tool-result payloads ([#967](https://github.com/can1357/gajae-code/issues/967), [#968](https://github.com/can1357/gajae-code/issues/968)).

- Added `AuthStorage` `onCredentialDisabled` callback (sync or async) so embedders can react when a credential is automatically disabled (e.g. OAuth refresh fails with `invalid_grant`) — useful for surfacing a banner or auto-launching a re-login flow instead of letting the credential silently disappear. Sync throws and async rejections are both caught and logged so a misbehaving subscriber cannot break the disable path.
- Added Anthropic OAuth `account.uuid` and `account.email_address` extraction from the `/v1/oauth/token` exchange and refresh responses; both `AnthropicOAuthFlow.exchangeToken()` and `refreshAnthropicToken()` now populate `OAuthCredentials.{accountId, email}` so downstream consumers can attribute requests to the authenticated account without a separate `/api/oauth/profile` round-trip.
- Added `onSseEvent` stream diagnostics so HTTP SSE providers can expose raw SSE frames without changing parsed model output.
- Added `streamIdleTimeoutMs` option (and `PI_STREAM_IDLE_TIMEOUT_MS` env override; `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` remains a backward-compatible alias) for a steady-state inter-event watchdog. Set to `0` to disable.
- Added a semantic-progress predicate to OpenAI Responses and OpenAI code SSE/WebSocket transports so `response.in_progress`-style keepalives no longer reset the idle deadline on stalled tool calls.

### Changed

- Anthropic streams now enforce a steady-state idle timeout (defaults to 120s, same control as `PI_STREAM_IDLE_TIMEOUT_MS`) in addition to the first-event watchdog. Long-running responses that go fully silent between events will now surface as `Anthropic stream stalled while waiting for the next event` instead of hanging.
- Fixed `resolveAnthropicMetadataUserId()` to accept JSON-format `user_id` values that match real Anthropic Code's payload shape (`{ device_id, account_uuid, session_id, ... }` from `services/api/anthropic-model.ts:getAPIMetadata`). Previously only the synthetic `user_<hex>_account_<uuid>_session_<uuid>` cloaking format was accepted on OAuth, which caused stable session-keyed metadata supplied by callers to be discarded and replaced with fresh random entropy on every request — defeating session-count attribution on the Anthropic model OAuth path.

## [14.8.0] - 2026-05-09

### Fixed
- Fixed Gemini 3 Pro thinking metadata so `medium` effort is rejected with the expected error instead of being silently accepted: `ThinkingConfig` now carries an optional explicit `levels` list that survives `expandEffortRange`, letting non-contiguous supported sets (e.g. `[low, high]`) round-trip through enrichment.
- Fixed Kimi Code OAuth expiry handling to refresh access tokens 5 minutes before server expiry, avoiding daily 401s from using tokens right up to the cutoff.
- Fixed OpenAI Responses custom tool replay to preserve custom tool call item IDs with the `ctc_` prefix instead of rewriting them as `fc_` function-call IDs ([#977](https://github.com/can1357/gajae-code/issues/977)).

## [14.7.6] - 2026-05-07

### Added

- Added `hideThinkingSummary` option to `SimpleStreamOptions`. When true, `streamSimple` requests that the underlying provider omit reasoning/thinking summaries: Anthropic receives `thinking.display = "omitted"` (where supported), and OpenAI Responses / Azure / OpenAI code providers leave `reasoning.summary` unset so the server skips emitting the human-readable summary stream entirely.

### Changed

- Changed OpenAI Responses, Azure OpenAI Responses, and OpenAI code provider providers to omit `reasoning.summary` from requests when `reasoningSummary` is explicitly `null` (previously fell back to `"auto"`).
## [14.7.5] - 2026-05-07

### Added

- Added `OpenAICompat.supportsMultipleSystemMessages` so chat-completions hosts can opt out of separate leading system blocks. Auto-detected as `true` for OpenAI, Azure, OpenRouter, Cerebras, Together, Fireworks, Groq, DeepSeek, Mistral, xAI, Z.ai, GitHub Copilot, and Zenmux; `false` for MiniMax, Alibaba Dashscope, and Qwen Portal whose chat templates reject follow-up system messages. Unknown OpenAI-compatible hosts (custom vLLM/local) default to `false`; users can opt back in via `compat.supportsMultipleSystemMessages: true`.

### Fixed

- Fixed strict-template OpenAI-compatible hosts (e.g. Qwen 3.5+ via vLLM, MiniMax) rejecting follow-up `system`/`developer` messages by coalescing ordered system prompts into a single block joined by `\n\n` when `compat.supportsMultipleSystemMessages` is false. Canonical hosts continue to receive separate blocks so KV-cache reuse stays effective when only the trailing prompt changes ([#958](https://github.com/can1357/gajae-code/issues/958)).

## [14.7.2] - 2026-05-06

### Fixed

- Fixed VLLM model discovery to use `max_model_len` as the context window when the endpoint reports it.
- Fixed custom Ollama Cloud/local-proxy model aliases (for example `deepseek-v4-pro:cloud`) to inherit bundled cache-pricing metadata when the upstream model is known ([#937](https://github.com/can1357/gajae-code/issues/937)).
- Fixed local Ollama model discovery to apply `/api/show` thinking and vision capabilities in addition to native context windows ([#928](https://github.com/can1357/gajae-code/issues/928)).

## [14.7.0] - 2026-05-04
### Breaking Changes

- Changed `Context.systemPrompt` from a string to `string[]`, so callers must now pass an array of prompts instead of a single string
- Changed behavior will throw at runtime for non-array system prompts because request builders now normalize system prompts as an array

### Added

- Added support for multiple system prompts by changing `Context.systemPrompt` to an ordered string array and preserving provider-appropriate instruction precedence

### Changed

- Changed request builders for Anthropic, OpenAI, Bedrock, Azure, Cursor, Google, and Ollama to propagate every non-empty system prompt entry without demoting durable instructions into ordinary conversation turns

### Fixed

- Filtered out empty normalized system prompts so blank entries are no longer sent to providers
- Removed blank system prompt strings from provider payloads to avoid unnecessary empty instruction messages

## [14.6.6] - 2026-05-04

### Added

- Added always-on OpenRouter response caching (1h TTL) by sending `X-OpenRouter-Cache: true` and `X-OpenRouter-Cache-TTL: 3600` on every OpenRouter request — identical requests replay from OpenRouter's edge cache for free. https://openrouter.ai/docs/features/response-caching

## [14.6.4] - 2026-05-03

### Fixed

- Fixed OpenAI code provider websocket continuations to retry with full context when `previous_response_id` expires server-side instead of surfacing `previous_response_not_found`.

## [14.6.2] - 2026-05-03
### Added

- Added `EventStream.fail(err)` method to terminate the async iterator with an error, enabling consumers to catch stream-level failures via `for await` without hanging

### Fixed

- Fixed OpenAI Responses tool schema conversion to rewrite non-strict `oneOf` unions to `anyOf` before sending tools to the Responses API ([#920](https://github.com/can1357/gajae-code/issues/920))

## [14.6.0] - 2026-05-02

### Added

- Added `disableReasoning` to stream and OpenAI completion options to force reasoning off for models that support it, sending `reasoning: { enabled: false }` for OpenRouter-compatible requests
- Added `thinkingDisplay` option to Anthropic options to control whether adaptive and explicit reasoning is returned as `summarized` or `omitted`
- Added Anthropic model compatibility flags `supportsEagerToolInputStreaming` and `supportsLongCacheRetention` for API-capability-specific request behavior

### Changed

- Changed Anthropic request payloads to send `thinking: { type: "disabled" }` when `thinkingEnabled` is explicitly `false` on reasoning-enabled models
- Changed Anthropic cache retention handling so `cacheRetention: "long"` now uses `ttl: "1h"` only for canonical Anthropic endpoints with long-cache support
- Changed Anthropic tool schema generation to include `eager_input_streaming` only on models that advertise support
- Changed Anthropic OAuth login flow to include browser fallback guidance and richer error context when token exchange or refresh fails

### Fixed

- Fixed Anthropic non-thinking requests to include the caller-provided `temperature` value in request payloads
- Fixed Anthropic `anthropic-model-opus-4-7` non-thinking payloads to omit sampling fields (`temperature`, `top_p`, and `top_k`)
- Fixed OpenAI code provider base URL normalization so configured base URLs with or without `/openai-code` or `/openai-code/responses` now resolve to `/openai-code/responses`
- Fixed OpenAI code provider websocket handling to parse JSON from non-string message payloads including `ArrayBuffer`, typed arrays, and `Blob` values
- Fixed OpenAI code provider websocket handshakes to replace stale `openai-beta` values with the websocket beta and avoid sending request-body headers over websocket transport
- Fixed abort tracking so caller-initiated cancellations are treated as user aborts even after local watchdog timeouts, preventing unintended automatic retries
- Fixed Anthropic stream handling to parse raw SSE envelopes directly, ignore unrelated events, and repair malformed JSON in SSE payloads
- Fixed Anthropic streaming to emit an explicit error when the SSE stream ends without a `message_stop` event
- Fixed OpenAI code provider websocket continuations to send true `previous_response_id` deltas for `store: false` transcripts, expose request stats, and default text verbosity to `low` unless explicitly overridden.
- Fixed OpenAI code provider websocket append reuse after `response.completed` terminal events.

## [14.5.14] - 2026-05-01
### Added

- Added package-level `google-gemini-headers` exports (`getGeminiCliHeaders`, `getGeminiCliUserAgent`, `getAntigravityHeaders`, `extractRetryDelay`, and `ANTIGRAVITY_SYSTEM_INSTRUCTION`) for header and retry handling reuse without importing full Google providers

### Changed

- Changed package exports and streaming/provider wiring to load heavy Google/Kimi/GitLab/synthetic provider modules lazily through `register-builtins`, reducing startup import overhead from optional provider SDKs

### Fixed

- Fixed DeepSeek V4 tool-call follow-up 400 errors from three root causes:
  - Mapped `reasoning_effort` "xhigh" to "max" for DeepSeek-family models on any provider (NVIDIA, OpenCode-Go, etc.), not just `deepseek`
  - Recovered `reasoning_content` from thinking blocks with valid signatures that were filtered by the non-empty-text check
- Added empty-string fallback when `reasoning_content` is genuinely absent (e.g. proxy-stripped) but the provider requires the field

## [14.5.13] - 2026-05-01

### Breaking Changes

- Removed `utils/oauth` re-exports from the package entrypoint, so OAuth helper imports from the root module must be updated

## [14.5.10] - 2026-04-30

### Added

- Added provider response metadata callbacks for Anthropic and OpenAI streaming requests.

## [14.5.9] - 2026-04-30

### Added

- Added `usage.reasoningTokens` to OpenAI and Google usage output when providers report reasoning/thinking tokens
- Added `usage.cttl.ephemeral5m` and `usage.cttl.ephemeral1h` to report Anthropic cache-write TTL token buckets
- Added `usage.server.webSearch` and `usage.server.webFetch` to report Anthropic server tool-call request counts

### Fixed

- Fixed OpenAI usage attribution to avoid double-counting `reasoning_tokens` in output totals
- Fixed Anthropic streaming usage handling so a previously populated cache TTL breakdown is preserved when later events omit `cache_creation`

## [14.5.4] - 2026-04-28

### Changed

- Changed OpenAI custom Lark grammar payloads to strip comments and blank lines before sending provider requests.

### Fixed

- Fixed OpenAI code provider GPT model pricing by inheriting matching OpenAI catalog rates for zero-priced discovered OpenAI code entries.

## [14.5.3] - 2026-04-27

### Added

- Added `fireworks` as a supported provider with API key login flow and credential storage
- Added Fireworks model catalog support with `fireworks`-scoped openai-completions models `glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, and `minimax-m2.7`
- Added built-in discovery wiring so providers with base URL `api.fireworks.ai` are recognized as OpenAI-compatible and can use streaming token control

### Changed

- Updated the built-in model catalog to use corrected `contextWindow` and `maxTokens` values for many existing models instead of placeholder limits
- Updated several model cost entries, including cache-read pricing, to corrected values

### Fixed

- Fixed Fireworks request formatting by translating between public model IDs and API wire IDs when sending OpenAI-completions requests
- Fixed OpenAI-compatible model parameter handling for Fireworks by allowing `max_tokens` to be sent during requests

## [14.5.1] - 2026-04-26

### Fixed

- Fixed NVIDIA NIM DeepSeek-V4 models leaking chat-template tool-call markers (e.g. `<｜DSML｜tool_calls｜>`) into visible response text by stripping the special tokens from streamed `delta.content` ([#798](https://github.com/can1357/gajae-code/issues/798))

## [14.4.0] - 2026-04-26

### Added

- Added an `examples` option to `StringEnum` to include example values in the generated schema

### Changed

- Changed Anthropic tool schema generation to strip unsupported schema fields (including `patternProperties`), add `additionalProperties: false` for object types, and apply Anthropic strict-mode limits when marking tools as strict
- Changed Anthropic strict tool planning to cap strict `tools` at twenty entries and convert excess optional/union parameters to nullable schemas to stay within provider constraints

### Fixed

- Fixed Anthropic tool schema compilation failures by keeping the `write` tool out of the strict-tool allowlist when the full coding-agent tool set is active
- Fixed Anthropic 400 `tools.*.custom: For 'object' type, property 'minItems' is not supported` by stripping `minItems` from object-shaped JSON schema nodes (array nodes still keep supported `minItems` values)
- Fixed Anthropic tool schemas that used tuple-style arrays by stripping unsupported `maxItems` and only preserving provider-supported `minItems` values
- Fixed Anthropic and OpenRouter Anthropic tool calls that previously failed with `compiled grammar is too large` by retrying automatically without strict tool schemas and reusing non-strict mode for subsequent requests in the same provider session
- Fixed parsing of JSON tool arguments containing raw control characters inside string values (such as embedded newlines) by escaping them before JSON parsing
- Fixed `validateToolArguments` to accept stringified objects and arrays that include literal control characters inside string fields
- Fixed OpenAI code provider Spark OAuth selection to fall back to non-Pro accounts when no ChatGPT Pro account is connected, so users without a Pro account can still attempt Spark requests in case the server permits access.

## [14.3.0] - 2026-04-25

### Added

- Added support for Anthropic model Opus 4.7 (`anthropic-model-opus-4-7`) model ([#726](https://github.com/can1357/gajae-code/issues/726))
  - Suppresses sampling parameters (temperature/top_p/top_k) that Opus 4.7 rejects
  - Enables `display: "summarized"` for adaptive thinking to restore visible thinking content

### Fixed

- Fixed Cursor provider losing conversation history on follow-up turns (model responding "this appears to be the start of our session") by populating `ConversationStateStructure.rootPromptMessagesJson` with JSON blob IDs for the system prompt plus prior user/assistant/tool-result messages. Cursor's server builds the model prompt from `rootPromptMessagesJson`, not from the protobuf `turns[]` tree, so sending only the system prompt there caused prior turns to be dropped
- Fixed Cursor provider multi-turn conversations failing with `Connect error internal: Blob not found` on the second message by storing `ConversationStateStructure.turns`, `AgentConversationTurnStructure.user_message`, and `AgentConversationTurnStructure.steps` as content-addressed blob IDs in the KV store (matching the existing handling for `rootPromptMessagesJson`) rather than sending the raw serialized bytes inline ([#678](https://github.com/can1357/gajae-code/issues/678))

## [14.2.1] - 2026-04-24

### Fixed

- Fixed OpenAI code provider Spark OAuth selection to require a verified ChatGPT Pro account instead of falling back to Plus or unknown-plan accounts.

## [14.2.0] - 2026-04-23

### Added

- Added `gpt-5.5` to the built-in model catalog for both OpenAI Responses (`openai`) and local `litellm` (`openai-completions`) providers
- Added `gpt-image-2` to the `litellm` built-in model catalog
- Added `isCopilotTransientModelError()` and `callWithCopilotModelRetry()` helpers in `utils/retry` that detect GitHub Copilot's intermittent `HTTP 400 model_not_supported` responses for preview models (`gpt-5.3-openai-code`, `gpt-5.4`, `gpt-5.4-mini`, ...) and retry the request up to three times with backoff. OpenAI Responses, OpenAI Completions, and Anthropic provider paths now participate in this retry when the model is served through Copilot.
- Added OpenAI Responses custom-tool grammar support for patch-envelope `apply_patch` calls, including freeform streaming, history replay, and forced tool-choice mapping to the custom wire name.

### Changed

- Updated built-in model metadata with revised `contextWindow`, `maxTokens`, and pricing values for existing entries
- Changed generated model policies to assign `applyPatchToolType: "freeform"` for first-party GPT-5 OpenAI Responses and OpenAI code models, so regenerated `models.json` preserves the `apply_patch` custom-tool metadata.
- Renamed `rewriteCopilotAuthError` to `rewriteCopilotError` and extended it to rewrite `HTTP 400 model_not_supported` after retries are exhausted with guidance about Copilot's OAuth-client-specific rollout gap (see opencode#13313).

### Fixed

- Fixed Amazon Bedrock proxy handling to honor lowercase `http_proxy`, `https_proxy`, and `all_proxy` environment variables when using HTTP/1 fallback
- Fixed Amazon Bedrock streaming behind corporate HTTP proxies by using a proxy-aware HTTP/1 transport when `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` is configured, including AWS SSO credential calls.
- Fixed Amazon Bedrock requests to retry once with HTTP/1 when the AWS SDK's default HTTP/2 transport fails before streaming begins.
- Fixed OpenAI Responses streaming to display thinking tokens from local providers (llama.cpp, etc.) that send raw `reasoning_text.delta` events and empty `summary` arrays in `output_item.done`. Previously, thinking content was silently dropped during streaming while non-streaming mode worked correctly.
- Synced the bundled OpenCode Go catalog with the current docs so `kimi-k2.6`, `mimo-v2.5`, and `mimo-v2.5-pro` appear in offline/default model lists.

## [14.1.3] - 2026-04-17

### Fixed

- Preserved user-provided `session_id` and `x-client-request-id` headers in OpenAI Responses requests instead of overriding them with automatic session-derived values
- Stopped sending `session_id` and `x-client-request-id` headers for OpenAI Responses requests when `cacheRetention` is set to `none`
- Fixed direct OpenAI Responses requests to send `session_id` and `x-client-request-id` from the same session-derived value as `prompt_cache_key`, improving prompt cache affinity for append-only sessions

## [14.1.1] - 2026-04-14

### Added

- Added `toolStrictMode` compatibility option (`"all_strict"` or `"none"`) to OpenAI-compatible model config to force tool schemas to be sent uniformly strict, uniformly non-strict, or keep mixed per-tool behavior

### Changed

- Changed Cerebras OpenAI-compatible providers to default `toolStrictMode` to `"all_strict"` unless explicitly overridden

### Fixed

- Fixed OpenAI Completions handling for providers that reject mixed `strict` flags by automatically retrying with non-strict tool schemas when an initial all-strict tool request fails with strict-format 400/422 errors
- Fixed OpenAI-completions error reporting by including captured JSON error body details such as type, param, and code when a request fails without a body in the thrown SDK error
- Fixed shell execution failure responses to preserve all result fields when sanitizing, preventing truncated metadata in stream results
- Fixed context overflow detection to recognize `model_context_window_exceeded` from z.ai / GLM providers, preventing infinite retry loops when context window is exceeded ([#638](https://github.com/can1357/gajae-code/issues/638))
- Fixed strict tool schema enforcement to preserve `additionalProperties: false` and required keys for reused nested object schemas, preventing invalid `todo_write` function schemas in OpenAI code/OpenAI requests
- Fixed GitHub Copilot reasoning regressions by preserving GPT-5.x / Anthropic model 4.x reasoning controls instead of stripping them from requests ([#773](https://github.com/can1357/gajae-code/issues/773))

## [14.1.0] - 2026-04-11

### Added

- Added `accountId` to usage report metadata

### Changed

- Changed usage parsing to emit a usage report with available fields when parsing fails, rather than returning null

### Fixed

- Fixed `planType` resolution to fall back to the raw payload `plan_type` when parsed value is absent
- Fixed usage metadata `raw` fallback to preserve the original payload when parsed raw output is missing

## [14.0.5] - 2026-04-11

### Changed

- Replaced GitHub Copilot authentication from VSCode extension impersonation to the opencode OAuth flow, eliminating TOS concerns. Existing users will need to re-authenticate once with `/login github-copilot`.
- Simplified Copilot token handling: GitHub OAuth token is used directly for all API requests (no JWT exchange or refresh cycle).
- Changed GitHub Copilot API base URL from `api.individual.githubcopilot.com` to `api.githubcopilot.com`.
- Updated default OpenAI stream idle timeout to 120,000 milliseconds to keep stream generation alive longer

### Fixed

- Fixed duplicate synthetic tool results being generated when a real tool result appears later in message history
- Fixed GitHub Copilot `/models` discovery to unwrap structured OAuth credentials before sending the bearer token, preserving dynamic catalog refresh for OAuth-backed callers.

### Removed

- Removed Copilot JWT proxy-ep base URL resolution (no longer needed with opencode auth).

## [14.0.3] - 2026-04-09

### Fixed

- Fixed Ollama discovery cache normalization so cached models upgrade to the OpenAI Responses transport after the provider change

## [14.0.0] - 2026-04-08

### Breaking Changes

- Removed `coerceNullStrings` function and its automatic null-string coercion behavior from JSON parsing

### Added

- Added support for OpenRouter provider with strict mode detection
- Added automatic cleaning of literal escape sequences (`\n`, `\t`, `\r`) in JSON parsing to handle LLM encoding confusion
- Added support for healing JSON with trailing junk after balanced containers (e.g., `]\n</invoke>`)
- Added `OPENAI_CODE_STARTUP_EVENT_CHANNEL` constant and `OpenAI codeStartupEvent` type for monitoring OpenAI code provider initialization status
- Added automatic healing of malformed JSON with single-character bracket errors at the end of strings, improving LLM tool argument parsing robustness

## [13.19.0] - 2026-04-05

### Fixed

- Fixed GitHub Copilot model context window detection by correcting fallback priority for maxContextWindowTokens and maxPromptTokens
- Fixed Gemini 2.5 Pro context window detection in GitHub Copilot model limits test
- Fixed Anthropic model Opus 4.6 context window detection in GitHub Copilot model limits test
- Fixed Anthropic streaming to suppress transient SDK console errors for malformed SSE keep-alive frames so the TUI only shows surfaced provider errors

- Added environment-based credential fallback for the OpenAI code provider provider.

## [13.17.6] - 2026-04-01

### Fixed

- Fixed Anthropic first-event timeouts to exclude stream connection setup from the watchdog, preserve timeout-specific retry classification after local aborts, and reset retry state cleanly between attempts

## [13.17.5] - 2026-04-01

### Changed

- Increased default first-event timeout from 15s to 45s to better accommodate longer request setup times
- Modified first-event watchdog to inherit idle timeout when it exceeds the default, ensuring consistent timeout behavior across different configurations

### Fixed

- Fixed first-event watchdog initialization timing so it no longer starts before the actual stream request is created, preventing premature timeouts during request setup
- Fixed first-event watchdog timing so OpenAI-family providers no longer count slow request setup against the first streamed event timeout, and raised the default first-event timeout to avoid false aborts after long tool turns

## [13.17.2] - 2026-04-01

### Fixed

- Fixed OpenAI-family first-event timeouts to preserve provider-specific timeout errors for retry classification instead of flattening them to generic aborts ([#591](https://github.com/can1357/gajae-code/issues/591))

## [13.17.1] - 2026-04-01

### Added

- Added `thinkingSignature` field to thinking content blocks to preserve the original reasoning field name (e.g., `reasoning_text`, `reasoning_content`) for accurate follow-up requests
- Added first-event timeout detection for streaming responses to abort stuck requests before user-visible content arrives
- Added `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` environment variable to configure first-event timeout (defaults to 15 seconds or idle timeout, whichever is lower)

### Changed

- Changed thinking block handling to track and distinguish between different reasoning field types, enabling proper field name preservation across multiple turns

### Fixed

- Fixed Anthropic stream timeout errors to be properly retried by recognizing first-event timeout messages
- Fixed stream stall detection to distinguish between first-event timeouts and idle timeouts, enabling faster recovery for stuck connections

### Added

- Added Vercel AI Gateway to `/login` providers for interactive API key setup

### Fixed

- Fixed `gjc commit` failing with HTTP 400 errors when using reasoning-enabled models on OpenAI-compatible endpoints that don't support the `developer` role (e.g., GitHub Copilot, custom proxies). Now falls back to `system` role when `developer` is unsupported.

## [13.17.0] - 2026-03-30

### Changed

- Bumped zai provider default model from glm-4.6 to glm-5.1

## [13.16.5] - 2026-03-29

### Added

- Added Gemma 3 27B model support for Google Generative AI

### Changed

- Updated Kwaipilot KAT-Coder-Pro V2 model display name and pricing information
- Updated Kwaipilot KAT-Coder-Pro V2 context window from 222,222 to 256,000 tokens and max tokens from 8,888 to 80,000

### Fixed

- Fixed normalizeAnthropicBaseUrl returning empty string instead of undefined when baseUrl is empty

## [13.16.4] - 2026-03-28

### Added

- Added support for Groq Compound and Compound Mini models with extended context window (131K tokens) and configurable thinking levels
- Added support for OpenAI GPT-OSS-Safeguard-20B model with reasoning capabilities across multiple providers
- Added support for Kwaipilot KAT-Coder-Pro V2 model across Kilo, NanoGPT, and OpenRouter providers
- Added support for GLM-5.1 model with extended context window (200K tokens) and max output of 131K tokens
- Added support for Qwen3.5-27B-Musica-v1 model
- Added support for zai-org/glm-5.1 model with reasoning capabilities
- Added support for Sapiens AI Agnes-1.5-Lite model with multimodal input (text and image) and reasoning
- Added support for Venice openai-gpt-54-mini model

### Changed

- Updated Qwen QwQ 32B max tokens from 16,384 to 40,960 across multiple providers
- Updated OpenAI GPT-OSS-Safeguard-20B model name to 'Safety GPT OSS 20B' and enabled reasoning capabilities
- Updated OpenAI GPT-OSS-Safeguard-20B context window from 222,222 to 131,072 tokens and max tokens from 8,888 to 65,536
- Updated OpenRouter Qwen QwQ 32B pricing: input from 0.2 to 0.19, output from 1.17 to 1.15, cache read from 0.1 to 0.095
- Updated OpenRouter Anthropic model 3.5 Sonnet pricing: input from 0.45 to 0.42, cache read from 0.225 to 0.21

## [13.16.3] - 2026-03-28

### Changed

- Modified OAuth credential saving to preserve unrelated identities instead of replacing all credentials for a provider
- Updated credential identity resolution to use provider context for more accurate email deduplication

### Fixed

- Fixed OAuth credential updates to replace matching credentials in-place rather than creating disabled rows, preventing unbounded accumulation of soft-deleted credentials

## [13.15.0] - 2026-03-23

### Added

- Added `isUsageLimitError()` to `rate-limit-utils` as a single source of truth for detecting usage/quota limit errors across all providers

### Fixed

- Fixed lazy stream forwarding to properly handle final results from source streams with `result()` methods
- Fixed lazy stream error handling to convert iterator failures into terminal error results instead of silently failing
- Fixed `parseRateLimitReason` to recognize "usage limit" in error messages and correctly classify them as `QUOTA_EXHAUSTED`
- Fixed OpenAI code `fetchWithRetry` retrying 429 responses for `usage_limit_reached` errors for up to 5 minutes instead of returning immediately for credential switching
- Removed `usage.?limit` from `TRANSIENT_MESSAGE_PATTERN` in retry utils since usage limits are not transient and require credential rotation
- Fixed `parseRateLimitReason` not recognizing "usage limit" in OpenAI code error messages, causing incorrect fallback to `UNKNOWN` classification instead of `QUOTA_EXHAUSTED`

## [13.14.2] - 2026-03-21

### Changed

- Updated thinking configuration format from `levels` array to `minLevel` and `maxLevel` properties for improved clarity
- Corrected context window from 400000 to 272000 tokens for GPT-5.4 mini and nano variants on OpenAI code transport
- Normalized GPT-5.4 variant priority handling to use parsed variant instead of special-casing raw model IDs
- Added support for `mini` variant in OpenAI model parsing regex

### Fixed

- Fixed inconsistent thinking level configuration across multiple model definitions

## [13.14.0] - 2026-03-20

### Fixed

- Fixed resumed OpenAI Responses sessions to avoid replaying stale same-provider native history on the first follow-up after process restart ([#488](https://github.com/can1357/gajae-code/issues/488))

### Added

- Added bundled GPT-5.4 mini model metadata for OpenAI, OpenAI code provider, and GitHub Copilot, including low-to-xhigh thinking support and GitHub Copilot premium multiplier metadata
- Added bundled GPT-5.4 nano model metadata for OpenAI and OpenAI code provider, including low-to-xhigh thinking support

## [13.13.2] - 2026-03-18

### Changed

- Modified tool result handling for aborted assistant messages to preserve existing tool results when already recorded, instead of always replacing them with synthetic 'aborted' results

## [13.13.0] - 2026-03-18

### Changed

- Changed tool argument validation to always normalize optional null values before type coercion, ensuring consistent handling of LLM-generated 'null' strings

### Fixed

- Fixed tool argument validation to properly handle string 'null' values from LLMs on optional fields by stripping them during normalization
- Improved type safety of `validateToolCall` and `validateToolArguments` functions by returning properly typed `ToolCall["arguments"]` instead of `any`

## [13.12.9] - 2026-03-17

### Changed

- Extracted OpenAI compatibility detection and resolution logic into dedicated `openai-completions-compat` module for improved maintainability and reusability

### Fixed

- Fixed `openai-responses` manual history replay to strip replay-only item IDs and preserve normalized tool `call_id` values for GitHub Copilot follow-up turns ([#457](https://github.com/can1357/gajae-code/issues/457))

## [13.12.0] - 2026-03-14

### Added

- Added support for `qwen-chat-template` thinking format to enable reasoning via `chat_template_kwargs.enable_thinking`
- Added `reasoningEffortMap` option to `OpenAICompat` for mapping pi-ai reasoning levels to provider-specific `reasoning_effort` values
- Added `extraBody` to `OpenAICompat` to support provider-specific request body routing fields in OpenAI-completions requests
- Added support for reading token usage from choice-level `usage` field as fallback when root-level usage is unavailable
- Added new models: DeepSeek-V3.2 (Bedrock), Llama 3.1 405B Instruct, Magistral Small 1.2, Ministral 3 3B, Mistral Large 3, Pixtral Large (25.02), NVIDIA Nemotron Nano 3 30B, and Qwen3-5-9b
- Added `close()` method to `AuthStorage` for properly closing the underlying credential store
- Added `initiatorOverride` option in OpenAI and Anthropic providers to customize message attribution

### Changed

- Changed assistant message content serialization to always use plain string format instead of text block arrays to prevent recursive nesting in OpenAI-compatible backends
- Changed Bedrock Opus 4.6 context window from 1M to 1M and added max tokens limit of 128K
- Changed OpenCode Zen/Go Sonnet 4.0/4.5 context window from 1M to 200K
- Changed GitHub Copilot context windows from 200K to 128K for both gpt-4o and gpt-4o-mini
- Changed Anthropic model 3.5 Sonnet (Anthropic API) pricing: input from $0.5 to $0.25, output from $3 to $1.5, cache read from $0.05 to $0.025, cache write from $0 to $1
- Changed Devstral 2 model name from '135B' to '123B'
- Changed ByteDance Seed 2.0-Lite to support reasoning with effort-based thinking mode and image inputs
- Changed Qwen3-32b (Groq) reasoning effort mapping to normalize all levels to 'default'
- Changed finish_reason 'end' to map to 'stop' for improved compatibility with additional providers
- Changed Anthropic reference model merging to prioritize bundled metadata for known models while using models.dev for newly discovered IDs

### Fixed

- Fixed reasoning_effort parameter handling to use provider-specific mappings instead of raw effort values
- Fixed assistant content serialization for GitHub Copilot and other OpenAI-compatible backends that mirror array payloads
- Fixed token usage calculation to properly extract cached tokens from both root and nested `prompt_tokens_details` fields
- Fixed stop reason mapping to handle string values and unknown finish reasons gracefully
- Fixed resource cleanup in `AuthCredentialStore.close()` to properly finalize all prepared statements before closing the database

## [13.11.1] - 2026-03-13

### Fixed

- Added `llama.cpp` as local provider
- Fixed auth schema V0-to-V1 migration crash when the V0 table lacks a `disabled` column

## [13.11.0] - 2026-03-12

### Added

- Added support for Parallel AI provider with API key authentication
- Added `PARALLEL_API_KEY` environment variable support for Parallel provider configuration
- Added automatic websocket reconnection handling for connection limit errors, with fallback to SSE replay when content has already been emitted

### Changed

- Enhanced `OpenAI codeProviderStreamError` to include an optional error code field for better error categorization and handling

### Fixed

- Improved retry logic to handle HTTP/2 stream errors and internal_error responses from Anthropic API

## [13.9.16] - 2026-03-10

### Added

- Support for `onPayload` callback to replace provider request payloads before sending, enabling request interception and modification
- Support for structured text signature metadata with phase information (commentary/final_answer) in OpenAI and Azure OpenAI Responses providers
- Support for OpenAI code provider Spark model selection with plan-based account prioritization
- Added `modelId` option to `getApiKey()` to enable model-specific credential ranking

### Changed

- Enhanced `onPayload` callback signature to accept model parameter and support async payload replacement
- Improved error messages for `response.failed` events to include detailed error codes, messages, and incomplete reasons
- Refactored OpenAI code provider response streaming to improve code organization and maintainability with extracted helper functions and type definitions
- Enhanced websocket fallback logic to safely replay buffered output over SSE when websocket connections fail mid-stream
- Improved error recovery for websocket streams by distinguishing between fatal connection errors and retryable stream errors
- Updated credential ranking strategy to prioritize Pro plan accounts when requesting OpenAI code provider Spark models

### Fixed

- Fixed websocket stream recovery to properly reset output state and clear buffered items when falling back to SSE after partial output
- Fixed handling of malformed JSON messages in websocket streams to trigger immediate fallback to SSE without retry attempts

## [13.9.13] - 2026-03-10

### Added

- Added `isSpecialServiceTier` utility function to validate OpenAI service tier values

## [13.9.12] - 2026-03-09

### Added

- Added Tavily web search provider support with API key authentication

### Fixed

- Fixed OpenAI-family streaming transports to fail with an explicit idle-timeout error instead of hanging indefinitely when the provider stops sending events mid-response
- Fixed OpenAI code provider OAuth refresh and usage-limit lookups to respect request timeouts instead of waiting indefinitely during account selection or rotation
- Fixed OpenAI code provider prewarmed websocket requests to fall back quickly when the socket connects but never starts the response stream

## [13.9.10] - 2026-03-08

### Added

- Added `identity_key` column to auth credentials storage for improved credential deduplication
- Added schema versioning system to auth credentials database for safer migrations
- Added automatic backfilling of identity keys during database schema migrations

### Changed

- Changed credential deduplication logic to use single identity key instead of multiple identifiers for better performance
- Changed database schema to store normalized identity keys alongside credentials
- Changed auth schema migration to support upgrading from legacy database versions with automatic data backfill

### Fixed

- Fixed API key credential matching to correctly identify when the same key is re-stored, preventing unnecessary row duplication on re-login
- Fixed credential deduplication to correctly handle OAuth accounts with matching emails but different account IDs
- Fixed API key replacement to reuse existing stored rows instead of accumulating disabled duplicates
- Fixed auth storage to preserve newer recorded schema versions when opened by older binaries

## [13.9.8] - 2026-03-08

### Fixed

- Fixed WebSocket stream fallback logic to safely replay buffered output over SSE when WebSocket fails after partial content has been streamed

## [13.9.4] - 2026-03-07

### Changed

- Simplified API key credential storage to always replace existing credentials on re-login instead of accumulating multiple keys
- Updated Kagi API key placeholder from `kagi_...` to `KG_...` to match current API key format
- Updated Kagi login instructions to clarify Search API access is beta-only and provide support contact
- Disabled usage reporting in streaming responses for Cerebras models due to compatibility issues

### Fixed

- Fixed Cerebras model compatibility by preventing `stream_options` usage requests in chat completions

## [13.9.3] - 2026-03-07

### Breaking Changes

- Changed `reasoning` parameter from `ThinkingLevel | undefined` to `Effort | undefined` in `SimpleStreamOptions`; 'off' is no longer valid (omit the field instead)
- Removed `supportsXhigh()` function; check `model.thinking?.maxLevel` instead
- Removed `ThinkingLevel` and `ThinkingEffort` types; use `Effort` enum
- Removed `getAvailableThinkingLevels()` and `getAvailableThinkingEfforts()` functions
- Changed `transformRequestBody()` signature to require `Model` parameter as second argument for effort validation
- Removed `thinking.ts` module export; import from `model-thinking.ts` instead

### Added

- Added `incremental` flag to `OpenAIResponsesHistoryPayload` to support building conversation history from multiple assistant messages instead of replacing it
- Added `dt` flag to `OpenAIResponsesHistoryPayload` for transport-level metadata
- Added `ThinkingConfig` interface to models for canonical thinking transport metadata with min/max effort levels and provider-specific mode
- Added `thinking` field to `Model` type containing per-model thinking capabilities used to clamp and map user-facing effort levels
- Added `Effort` enum (minimal, low, medium, high, xhigh) as canonical user-facing thinking levels replacing `ThinkingLevel`
- Added `enrichModelThinking()` function to automatically populate thinking metadata on models based on their capabilities
- Added `mapEffortToAnthropicAdaptiveEffort()` function to map user effort levels to Anthropic adaptive thinking effort
- Added `mapEffortToGoogleThinkingLevel()` function to map user effort levels to Google thinking levels
- Added `requireSupportedEffort()` function to validate and clamp effort levels per model, throwing errors for unsupported combinations
- Added `clampThinkingLevelForModel()` function to clamp thinking levels to model-supported range
- Added `applyGeneratedModelPolicies()` and `linkSparkPromotionTargets()` exports from model-thinking module
- Added `serviceTier` option to control OpenAI processing priority and cost (auto, default, flex, scale, priority)
- Added `providerPayload` field to messages and responses for reconstructing transport-native history
- Added Gemini usage provider for tracking quota and tier information
- Added `getOpenAI codeAccountId()` utility to extract account ID from OpenAI code JWT tokens
- Added email extraction from OpenAI code provider OAuth tokens for credential deduplication

### Changed

- Changed credential disabling mechanism from boolean `disabled` flag to `disabled_cause` text field for tracking why credentials were disabled
- Changed `deleteAuthCredential()` and `deleteAuthCredentialsForProvider()` methods to require a `disabledCause` parameter explaining the reason for disabling
- Changed Gemini model parsing to strip `-preview` suffix for consistent model identification
- Changed OpenAI code provider websocket error handling to detect fatal connection errors and immediately fall back to SSE without retrying
- Changed OpenAI code provider to always use websockets v2 protocol (removed v1 support)
- Changed `reasoning` parameter type from `ThinkingLevel` to `Effort` in `SimpleStreamOptions`, removing 'off' value (callers should omit the field instead)
- Changed thinking configuration to use model-specific metadata instead of hardcoded provider logic for effort mapping
- Changed OpenAI code provider request transformer to accept `Model` parameter for effort validation instead of string model ID
- Changed Anthropic provider to use model thinking metadata for determining adaptive thinking support instead of model ID pattern matching
- Changed Google Vertex and Google providers to use shorter variable names for thinking config construction
- Moved thinking-related utilities from `thinking.ts` to new `model-thinking.ts` module with expanded functionality
- Moved model policy functions from `provider-models/model-policies.ts` to `model-thinking.ts`
- Moved `googleGeminiCliUsageProvider` from `providers/google-gemini-cli-usage.ts` to `usage/gemini.ts`
- Changed default OpenAI model from gpt-5.1-openai-code to gpt-5.4 across all providers
- Changed `UsageFetchContext` to remove cache and now() dependencies—usage fetchers now use Date.now() directly
- Removed `resetInMs` field from usage windows; consumers should calculate from `resetsAt` timestamp
- Changed OpenAI code provider credential ranking to deduplicate by email when accountId matches
- Improved OpenAI code provider error handling with retryable error detection

### Removed

- Removed `thinking.ts` module; use `model-thinking.ts` instead
- Removed `provider-models/model-policies.ts` module; functionality moved to `model-thinking.ts`
- Removed `supportsXhigh()` function from models.ts; use model.thinking metadata instead
- Removed `ThinkingLevel` and `ThinkingEffort` types; use `Effort` enum instead
- Removed `getAvailableThinkingLevels()` and `getAvailableThinkingEfforts()` functions
- Removed `model-policies` export from `provider-models/index.ts`
- Removed hardcoded thinking level clamping logic from OpenAI code provider request transformer; now uses model metadata
- Removed `UsageCache` and `UsageCacheEntry` interfaces—caching is now handled internally by AuthStorage
- Removed `google-gemini-cli-usage` export; use new `gemini` usage provider instead
- Removed `resetInMs` computation from all usage providers
- Removed cache TTL constants and cache management from usage fetchers (anthropic-model, github-copilot, google-antigravity, kimi, openai-code, zai)

### Fixed

- Fixed credential purging to respect disabled credentials when deduplicating by email, preventing re-enablement of intentionally disabled credentials
- Fixed OpenAI code provider websocket error reporting to include detailed error messages from error events
- Fixed conversation history reconstruction to support incremental updates from multiple assistant messages while maintaining backward compatibility with full-snapshot payloads
- Fixed OpenAI code provider to reject unsupported effort levels instead of silently clamping them, providing clear error messages about supported efforts
- Fixed model cache normalization to properly apply thinking enrichment when loading cached models
- Fixed dynamic model merging to apply thinking enrichment to merged model results
- Fixed OpenAI code provider streaming to properly include service_tier in SSE payloads
- Fixed type safety in OpenAI responses by removing unsafe type casts on image content blocks
- Fixed credential purging to respect disabled credentials when deduplicating by email
- Fixed API-key provider re-login to replace the active stored key instead of appending stale credentials that were still selected first
- Fixed Kagi login guidance to use the correct `KG_...` key format and mention Search API beta access requirements

## [13.9.2] - 2026-03-05

### Added

- Support for redacted thinking blocks in Anthropic messages, enabling secure handling of encrypted reasoning content
- Preservation of latest Anthropic thinking blocks and redacted thinking content during message transformation, even when switching between Anthropic models

### Changed

- Assistant message content now includes `RedactedThinkingContent` type alongside existing text, thinking, and tool call blocks
- Message transformation logic now preserves signed thinking blocks and redacted thinking for the latest assistant message in Anthropic conversations

### Fixed

- Fixed Unicode normalization to consistently apply `toWellFormed()` to all text content, including thinking blocks, ensuring proper handling of malformed UTF-16 sequences

## [13.9.1] - 2026-03-05

### Breaking Changes

- Removed `THINKING_LEVELS`, `ALL_THINKING_LEVELS`, `ALL_THINKING_MODES`, `THINKING_MODE_DESCRIPTIONS`, and `THINKING_MODE_LABELS` exports
- Renamed `formatThinking()` to `getThinkingMetadata()` with changed return type from string to `ThinkingMetadata` object
- Renamed `getAvailableThinkingLevel()` to `getAvailableThinkingLevels()` and added default parameter
- Renamed `getAvailableEffort()` to `getAvailableEfforts()` and added default parameter

### Added

- Added `ThinkingMetadata` type to provide structured access to thinking mode information (value, label, description)

## [13.9.0] - 2026-03-05

### Added

- Exported new thinking module with `Effort`, `ThinkingLevel`, and `ThinkingMode` types for managing reasoning effort levels
- Added `getAvailableEffort()` function to determine supported thinking effort levels based on model capabilities
- Added `parseEffort()`, `parseThinkingLevel()`, and `parseThinkingMode()` functions for parsing thinking configuration strings
- Added `THINKING_LEVELS`, `ALL_THINKING_LEVELS`, and `ALL_THINKING_MODES` constants for iterating over available thinking options
- Added `THINKING_MODE_DESCRIPTIONS` and `THINKING_MODE_LABELS` for displaying thinking modes in user interfaces
- Added `formatThinking()` function to format thinking modes as compact display labels

### Changed

- Refactored thinking level handling to distinguish between `Effort` (provider-level, no "off") and `ThinkingLevel` (user-facing, includes "off")
- Updated `ThinkingBudgets` type to use `Effort` instead of `ThinkingLevel` for more precise token budget configuration
- Improved reasoning option handling to explicitly support "off" value for disabling reasoning across all providers
- Simplified thinking effort mapping logic by centralizing provider-specific clamping behavior

## [13.7.8] - 2026-03-04

### Added

- Added ZenMux provider support with mixed API routing: Anthropic-owned models discovered from `https://zenmux.ai/api/v1/models` now use the Anthropic transport (`https://zenmux.ai/api/anthropic`), while other ZenMux models use the OpenAI-compatible transport.

## [13.7.7] - 2026-03-04

### Changed

- Modified response ID normalization to preserve existing item ID prefixes when truncating oversized IDs
- Updated tool call ID normalization to use `fc_` prefix for generated item IDs instead of `item_` prefix

### Fixed

- Fixed handling of reasoning item IDs to remain untouched during response normalization while function call IDs are properly normalized

## [13.7.2] - 2026-03-04

### Added

- Added support for Kagi API key authentication via `login kagi` command
- Added Kagi to the list of available OAuth providers

### Fixed

- MCP tool schemas with `$ref`/`$defs` are now dereferenced before being sent to LLM providers, fixing dangling references that left models without type definitions
- Ajv schema validation no longer emits `console.warn()` for non-standard format keywords (e.g. `"uint"`) from MCP servers, preventing TUI corruption
- Tool schema compilation is now cached per schema identity, eliminating redundant recompilation on every tool call

## [13.6.0] - 2026-03-03

### Added

- Added Anthropic Foundry gateway mode controlled by `ANTHROPIC_MODEL_CODE_USE_FOUNDRY`, with support for `FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, and optional mTLS material (`ANTHROPIC_MODEL_CODE_CLIENT_CERT`, `ANTHROPIC_MODEL_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS`)
- Added LM Studio provider support with OpenAI-compatible model discovery and OAuth login.
- Added support for `LM_STUDIO_API_KEY` and `LM_STUDIO_BASE_URL` environment variables for authentication and custom host configuration.

### Changed

- Anthropic key resolution now prefers `ANTHROPIC_FOUNDRY_API_KEY` over `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` when Foundry mode is enabled
- Anthropic auth base-URL fallback now prefers `FOUNDRY_BASE_URL` when `ANTHROPIC_MODEL_CODE_USE_FOUNDRY` is enabled

## [13.5.8] - 2026-03-02

### Fixed

- Fixed schema compatibility issue where patternProperties in tool parameters caused failures when converting to legacy Antigravity format

## [13.5.5] - 2026-03-01

### Changed

- Anthropic Anthropic model system-block cloaking now leaves the agent identity block uncached and applies `cache_control: { type: "ephemeral" }` to injected user system blocks without forcing `ttl: "1h"`

### Fixed

- Anthropic request payload construction now enforces a maximum of 4 `cache_control` breakpoints (tools/system/messages priority order) before dispatch
- Anthropic cache-control normalization now removes later `ttl: "1h"` entries when a default/5m block has already appeared earlier in evaluation order

## [13.5.3] - 2026-03-01

### Fixed

- Fixed tool argument coercion to handle malformed JSON with trailing wrapper braces by parsing leading JSON containers

## [13.4.0] - 2026-03-01

### Breaking Changes

- Removed `TInput` generic parameter from `ToolResultMessage` interface and removed `$normative` property

### Added

- `hasUnrepresentableStrictObjectMap()` pre-flight check in `tryEnforceStrictSchema`: schemas with `patternProperties` or schema-valued `additionalProperties` now degrade gracefully to non-strict mode instead of throwing during enforcement
- `generateAnthropic modelCloakingUserId()` generates structured user IDs for Anthropic OAuth metadata (`user_{hex64}_account_{uuid}_session_{uuid}`)
- `isAnthropic modelCloakingUserId()` validates whether a string matches the cloaking user-ID format
- `mapStainlessOs()` and `mapStainlessArch()` map `process.platform`/`process.arch` to Stainless header values; X-Stainless-Os and X-Stainless-Arch in `anthropic-modelCodeHeaders` are now runtime-computed
- `buildAnthropic modelCodeTlsFetchOptions()` attaches SNI and default TLS ciphers for direct `api.anthropic.com` connections
- `createAnthropic modelBillingHeader()` generates the `x-anthropic-billing-header` block (SHA-256 payload fingerprint + random build hash)
- `buildAnthropicSystemBlocks()` now injects a billing header block and the Anthropic model Agent SDK identity block with `ephemeral` 1h cache-control when `includeAnthropic modelCodeInstruction` is set
- `resolveAnthropicMetadataUserId()` auto-generates a cloaking user ID for OAuth requests when `metadata.user_id` is absent or invalid
- `AnthropicOAuthFlow` is now exported for direct use
- OAuth callback server timeout extended from 2 min to 5 min
- `parseGeminiCliCredentials()` parses Google Cloud credential JSON with support for legacy (`{token,projectId}`), alias (`project_id`/`refresh`/`expires`), and enriched formats
- `shouldRefreshGeminiCliCredentials()` and proactive token refresh before requests for both Gemini CLI and Antigravity providers (60s pre-expiry buffer)
- `normalizeAntigravityTools()` converts `parametersJsonSchema` → `parameters` in function declarations for Antigravity compatibility
- `ANTIGRAVITY_SYSTEM_INSTRUCTION` is now exported for use by search and other consumers
- `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA` constant exported from OAuth module with `ANTIGRAVITY` ideType
- Antigravity project onboarding: `onboardProjectWithRetries()` provisions a new project via `onboardUser` LRO when `loadCodeAssist` returns no existing project (up to 5 attempts, 2s interval)
- `getOAuthApiKey` now includes `refreshToken`, `expiresAt`, `email`, and `accountId` in the Gemini/Antigravity JSON credential payload to enable proactive refresh
- Antigravity model discovery now tries the production daily endpoint first, with sandbox as fallback
- `ANTIGRAVITY_DISCOVERY_DENYLIST` filters low-quality/internal models from discovery results

### Changed

- Replaced `sanitizeSurrogates()` utility with native `String.prototype.toWellFormed()` for handling unpaired Unicode surrogates across all providers
- Extended `ANTHROPIC_OAUTH_BETA` constant in the OpenAI-compat Anthropic route with `interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, and `prompt-caching-scope-2026-01-05` beta flags
- `anthropic-modelCodeVersion` bumped to `2.1.63`; `anthropic-modelCodeSystemInstruction` updated to identify as Anthropic model Agent SDK
- `anthropic-modelCodeHeaders`: removed `X-Stainless-Helper-Method`, updated package version to `0.74.0`, runtime version to `v24.3.0`
- `applyAnthropic modelToolPrefix` / `stripAnthropic modelToolPrefix` now accept an optional prefix override and skip Anthropic built-in tool names (`web_search`, `code_execution`, `text_editor`, `computer`)
- Accept-Encoding header updated to `gzip, deflate, br, zstd`
- Non-Anthropic base URLs now receive `Authorization: Bearer` regardless of OAuth status
- Prompt-caching logic now skips applying breakpoints when any block already carries `cache_control`, instead of stripping then re-applying
- `fine-grained-tool-streaming-2025-05-14` removed from default beta set
- Anthropic OAuth token URL changed from `platform.anthropic-model.com` to `api.anthropic.com`
- Anthropic OAuth scopes reduced to `org:create_api_key user:profile user:inference`
- OAuth code exchange now strips URL fragment from callback code, using the fragment as state override when present
- Anthropic model usage headers aligned: user-agent updated to `anthropic-model-cli/2.1.63 (external, cli)`, anthropic-beta extended with full beta set
- Antigravity session ID format changed to signed decimal (negative int63 derived from SHA-256 of first user message, or random bounded int63)
- Antigravity `requestId` now uses `agent-{uuid}` format; non-Antigravity requests no longer include requestId/userAgent/requestType in the payload
- `ANTIGRAVITY_DAILY_ENDPOINT` corrected to `daily-cloudcode-pa.googleapis.com`; sandbox endpoint kept as fallback only
- Antigravity discovery: removed `recommended`/`agentModelSorts` filter; now includes all non-internal, non-denylisted models
- Antigravity discovery no longer sends `project` in the request body
- Gemini/Antigravity OAuth flows no longer use PKCE (code_challenge removed)
- Antigravity `loadCodeAssist` metadata ideType changed from `IDE_UNSPECIFIED` to `ANTIGRAVITY`
- Antigravity `discoverProject` now uses a single canonical production endpoint; falls back to project onboarding instead of a hardcoded default project ID
- `VALIDATED` tool calling config applied to Antigravity requests with Anthropic model models
- `maxOutputTokens` removed from Antigravity generation config for non-Anthropic model models
- System instruction injection for Antigravity scoped to Anthropic model and `gemini-3-pro-high` models only

### Removed

- Removed `sanitizeSurrogates()` utility function; use native `String.prototype.toWellFormed()` instead

## [13.3.14] - 2026-02-28

### Added

- Exported schema utilities from new `./utils/schema` module, consolidating JSON Schema handling across providers
- Added `CredentialRankingStrategy` interface for providers to implement usage-based credential selection
- Added `anthropic-modelRankingStrategy` for Anthropic OAuth credentials to enable smart multi-account selection based on usage windows
- Added `openai-codeRankingStrategy` for OpenAI code provider OAuth credentials with priority boost for fresh 5-hour window starts
- Added `adaptSchemaForStrict()` helper for unified OpenAI strict schema enforcement across providers
- Added schema equality and merging utilities: `areJsonValuesEqual()`, `mergeCompatibleEnumSchemas()`, `mergePropertySchemas()`
- Added Cloud Code Assist schema normalization: `copySchemaWithout()`, `stripResidualCombiners()`, `prepareSchemaForCCA()`
- Added `sanitizeSchemaForGoogle()` and `sanitizeSchemaForCCA()` for provider-specific schema sanitization
- Added `StringEnum()` helper for creating string enum schemas compatible with Google and other providers
- Added `enforceStrictSchema()` and `sanitizeSchemaForStrictMode()` for OpenAI strict mode schema validation
- Added package exports for `./utils/schema` and `./utils/schema/*` subpaths
- Added `validateSchemaCompatibility()` to statically audit a JSON Schema against provider-specific rules (`openai-strict`, `google`, `cloud-code-assist-anthropic-model`) and return structured violations
- Added `validateStrictSchemaEnforcement()` to verify the strict-fail-open contract: enforced schemas pass strict validation, failed schemas return the original object identity
- Added `COMBINATOR_KEYS` (`anyOf`, `allOf`, `oneOf`) and `CCA_UNSUPPORTED_SCHEMA_FIELDS` as exported constants in `fields.ts` to eliminate duplication across modules
- Added `tryEnforceStrictSchema` result cache (`WeakMap`) to avoid redundant sanitize + enforce work for the same schema object
- Added comprehensive schema normalization test suite (`schema-normalization.test.ts`) covering strict mode, Google, and Cloud Code Assist normalization paths
- Added schema compatibility validation test suite (`schema-compatibility.test.ts`) covering all three provider targets

### Changed

- Moved schema utilities from `./utils/typebox-helpers` to new `./utils/schema` module with expanded functionality
- Refactored OpenAI provider tool conversion to use unified `adaptSchemaForStrict()` helper across openai-code, completions, and responses
- Updated `AuthStorage` to support generic credential ranking via `CredentialRankingStrategy` instead of OpenAI code-only logic
- Moved Google schema sanitization functions from `google-shared.ts` to `./utils/schema` module
- Changed export path: `./utils/typebox-helpers` → `./utils/schema` in main index
- `sanitizeSchemaForGoogle()` / `sanitizeSchemaForCCA()` now accept a parameterized `unsupportedFields` set internally, enabling code reuse between the two sanitizers
- `copySchemaWithout()` rewritten using object-rest destructuring for clarity

### Fixed

- Fixed cycle detection: `WeakSet` guards added to all recursive schema traversals (`sanitizeSchemaForStrictMode`, `enforceStrictSchema`, `normalizeSchemaForCCA`, `normalizeNullablePropertiesForCloudCodeAssist`, `stripResidualCombiners`, `sanitizeSchemaImpl`, `hasResidualCloudCodeAssistIncompatibilities`) — circular schemas no longer cause infinite loops or stack overflows
- Fixed `hasResidualCloudCodeAssistIncompatibilities`: cycle detection now returns `false` (not `true`) for already-visited nodes, eliminating false positives that forced the CCA fallback schema on valid recursive inputs
- Fixed `stripResidualCombiners` to iterate to a fixpoint rather than making a single pass, ensuring chained combiner reductions (where one reduction enables another) are fully resolved
- Fixed `mergeObjectCombinerVariants` required-field computation: the flattened object now takes the intersection of all variants' `required` arrays (unioned with own-level required properties that exist in the merged schema), preventing required fields from being silently dropped or over-included
- Fixed `mergeCompatibleEnumSchemas` to use deep structural equality (`areJsonValuesEqual`) instead of `Object.is` when deduplicating object-valued enum members
- Fixed `sanitizeSchemaForGoogle` const-to-enum deduplication to use deep equality instead of reference equality
- Fixed `sanitizeSchemaForGoogle` type inference for `anyOf`/`oneOf`-flattened const enums: type is now derived from all variants (must agree), falling back to inference from enum values; mixed null/non-null infers the non-null type and sets `nullable`
- Fixed `sanitizeSchemaForGoogle` recursion to spread options when descending (previously only `insideProperties`, `normalizeTypeArrayToNullable`, `stripNullableKeyword` were forwarded; new fields `unsupportedFields` and `seen` were silently dropped)
- Fixed `sanitizeSchemaForGoogle` array-valued `type` filtering to exclude non-string entries before processing
- Removed incorrect `additionalProperties: false` stripping from `sanitizeSchemaForGoogle` (the field is valid in Google schemas when `false`)
- Fixed `sanitizeSchemaForStrictMode` to strip the `nullable` keyword and expand it into `anyOf: [schema, {type: "null"}]` in the output, matching what OpenAI strict mode actually expects
- Fixed `sanitizeSchemaForStrictMode` to infer `type: "array"` when `items` is present but `type` is absent
- Fixed `sanitizeSchemaForStrictMode` to infer a scalar `type` from uniform `enum` values when `type` is not explicitly set
- Fixed `sanitizeSchemaForStrictMode` const-to-enum merge to use deep equality, preventing duplicate enum entries when `const` and `enum` both exist with the same value
- Fixed `enforceStrictSchema` to drop `additionalProperties` unconditionally (previously only object-valued `additionalProperties` was recursed into; non-object values were passed through, violating strict schema requirements)
- Fixed `enforceStrictSchema` to recurse into `$defs` and `definitions` blocks so referenced sub-schemas are also made strict-compliant
- Fixed `enforceStrictSchema` to handle tuple-style `items` arrays (previously only single-schema `items` objects were recursed)
- Fixed `enforceStrictSchema` double-wrapping: optional properties already expressed as `anyOf: [..., {type: "null"}]` are not wrapped again
- Fixed `enforceStrictSchema` `Array.isArray` type-narrowing for `type` field to filter non-string entries before checking for `"object"`

## [13.3.8] - 2026-02-28

### Fixed

- Fixed response body reuse error when handling 429 rate limit responses with retry logic

## [13.3.7] - 2026-02-27

### Added

- Added `tryEnforceStrictSchema` function that gracefully downgrades to non-strict mode when schema enforcement fails, enabling better compatibility with malformed or circular schemas
- Added `sanitizeSchemaForStrictMode` function to normalize JSON schemas by stripping non-structural keywords, converting `const` to `enum`, and expanding type arrays into `anyOf` variants
- Added Kilo Gateway provider support with OpenAI-compatible model discovery, OAuth `/login kilo`, and `KILO_API_KEY` environment variable support ([#193](https://github.com/can1357/gajae-code/issues/193))

### Changed

- Changed strict mode handling in OpenAI providers to use `tryEnforceStrictSchema` for safer schema enforcement with automatic fallback to non-strict mode
- Enhanced `enforceStrictSchema` to properly handle schemas with type arrays containing `object` (e.g., `type: ["object", "null"]`)

### Fixed

- Fixed `enforceStrictSchema` to properly handle malformed object schemas with required keys but missing properties
- Fixed `enforceStrictSchema` to correctly process nested object schemas within `anyOf`, `allOf`, and `oneOf` combinators

## [13.3.1] - 2026-02-26

### Added

- Added `topP`, `topK`, `minP`, `presencePenalty`, and `repetitionPenalty` options to `StreamOptions` for fine-grained control over model sampling behavior

## [13.3.0] - 2026-02-26

### Changed

- Allowed OAuth provider logins to supply a manual authorization code handler with a default prompt when none is provided

## [13.2.0] - 2026-02-23

### Added

- Added support for GitHub Copilot provider in strict mode for both openai-completions and openai-responses tool schemas

### Fixed

- Fixed tool descriptions being rejected when undefined by providing empty string fallback across all providers

## [12.19.1] - 2026-02-22

### Added

- Exported `isProviderRetryableError` function for detecting rate-limit and transient stream errors
- Support for retrying malformed JSON stream-envelope parse errors from Anthropic-compatible proxy endpoints

### Changed

- Expanded retry detection to include JSON parse errors (unterminated strings, unexpected end of input) in addition to rate-limit errors

## [12.19.0] - 2026-02-22

### Added

- Added GitLab Duo provider with support for Anthropic model, GPT-5, and other models via GitLab AI Gateway
- Added OAuth authentication for GitLab Duo with automatic token refresh and direct access caching
- Added 16 new GitLab Duo models including Anthropic model Opus/Sonnet/Haiku variants and GPT-5 series models
- Added `isOAuth` option to Anthropic provider to force OAuth bearer auth mode for proxy tokens
- Added `streamGitLabDuo` function to route requests through GitLab AI Gateway with direct access tokens
- Added `getGitLabDuoModels` function to retrieve available GitLab Duo model configurations
- Added `clearGitLabDuoDirectAccessCache` function to manually clear cached direct access tokens

### Changed

- Enhanced `getModelMapping()` to support both GitLab Duo alias IDs (e.g., `duo-chat-gpt-5-openai-code`) and canonical model IDs (e.g., `gpt-5-openai-code`) for improved model resolution flexibility
- Migrated `AuthCredentialStore` and `AuthStorage` into `@gajae-code/ai` as shared credential primitives for downstream packages
- Moved Anthropic auth helpers (`findAnthropicAuth`, `isOAuthToken`, `buildAnthropicSearchHeaders`, `buildAnthropicUrl`) into shared AI utilities for reuse across providers
- Replaced `CliAuthStorage` with `AuthCredentialStore` for improved credential management with multiple credentials per provider
- Updated models.json pricing for Anthropic model 3.5 Sonnet (input: 0.23→0.45, output: 3→2.2, added cache read: 0.225) and Anthropic model 3 Opus (input: 0.3→0.95)
- Moved `mapAnthropicToolChoice` function from gitlab-duo provider to stream module for broader reusability
- Enhanced HTTP status code extraction to handle string-formatted status codes in error objects

### Removed

- Removed `CliAuthStorage` class in favor of new `AuthCredentialStore` with enhanced functionality

## [12.17.2] - 2026-02-21

### Added

- Exported `getAntigravityUserAgent()` function for constructing Antigravity User-Agent headers

### Changed

- Updated default Antigravity version from 1.15.8 to 1.18.3
- Unified User-Agent header generation across Antigravity API calls to use centralized `getAntigravityUserAgent()` function

## [12.17.1] - 2026-02-21

### Added

- Added new export paths for provider models via `./provider-models` and `./provider-models/*`
- Added new export paths for Cursor and OpenAI code provider providers via `./providers/cursor/gen/*` and `./providers/openai-code/*`
- Added new export paths for usage utilities via `./usage/*`
- Added new export paths for discovery and OAuth utilities via `./utils/discovery` and `./utils/oauth` with subpath exports

### Changed

- Simplified main export path to use wildcard pattern `./src/*.ts` for broader module access
- Updated `models.json` export to include TypeScript declaration file at `./src/models.json.d.ts`
- Reorganized package.json field ordering for improved readability

## [12.17.0] - 2026-02-21

### Fixed

- Cursor provider: bind `execHandlers` when passing handler methods to the exec protocol so handlers receive correct `this` context (fixes "undefined is not an object (evaluating 'this.options')" when using exec tools such as web search with Cursor)

## [12.16.0] - 2026-02-21

### Added

- Exported `readModelCache` and `writeModelCache` functions for direct SQLite-backed model cache access
- Added `<turn_aborted>` guidance marker as synthetic user message when assistant messages are aborted or errored, informing the model that tools may have partially executed
- Added support for Sonnet 4.6 models in adaptive thinking detection

### Changed

- Updated model cache schema version to support improved global model fallback resolution
- Improved GitHub Copilot model resolution to prefer provider-specific model definitions over global references when context window is larger, ensuring optimal model capabilities
- Migrated model cache from per-provider JSON files to unified SQLite database (models.db) for atomic cross-process access
- Renamed `cachePath` option to `cacheDbPath` in ModelManagerOptions to reflect database-backed storage
- Improved non-authoritative cache handling with 5-minute retry backoff instead of retrying on every startup
- Modified handling of aborted/errored assistant messages to preserve tool call structure instead of converting to text summaries, with synthetic 'aborted' tool results injected
- Updated tool call tracking to use status map (Resolved/Aborted) instead of separate sets for better handling of duplicate and aborted tool results

## [12.15.0] - 2026-02-20

### Fixed

- Improved error messages for OAuth token refresh failures by including detailed error information from the provider
- Separated rate limit and usage limit error handling to provide distinct user-friendly messages for ChatGPT rate limits vs subscription usage limits

### Changed

- Increased SDK retry attempts to 5 for OpenAI, Azure OpenAI, and Anthropic clients (was SDK default of 2)
- Changed 429 retry strategy for OpenAI code provider and Google Gemini CLI to use a 5-minute time budget when the server provides a retry delay, instead of a fixed attempt cap

## [12.14.0] - 2026-02-19

### Added

- Added `gemini-3.1-pro` model to opencode provider with text and image input support
- Added `trinity-large-preview-free` model to opencode provider
- Added `google/gemini-3.1-pro-preview` model to nanogpt provider
- Added `google/gemini-3.1-pro-preview` model to openrouter provider with text and image input support
- Added `gemini-3.1-pro` model to cursor provider
- Added optional `intent` field to `ToolCall` interface for harness-level intent metadata

### Changed

- Changed `big-pickle` model API from `openai-completions` to `anthropic-messages`
- Changed `big-pickle` model baseUrl from `https://opencode.ai/zen/v1` to `https://opencode.ai/zen`
- Changed `minimax-m2.5-free` model API from `openai-completions` to `anthropic-messages`
- Changed `minimax-m2.5-free` model baseUrl from `https://opencode.ai/zen/v1` to `https://opencode.ai/zen`

### Fixed

- Fixed tool argument validation to iteratively coerce nested JSON strings across multiple passes, enabling proper handling of deeply nested JSON-serialized objects and arrays

## [12.13.0] - 2026-02-19

### Added

- Added NanoGPT provider support with API-key login, dynamic model discovery from `https://nano-gpt.com/api/v1/models`, and text-model filtering for catalog/runtime discovery ([#111](https://github.com/can1357/gajae-code/issues/111))

## [12.12.3] - 2026-02-19

### Fixed

- Fixed retry logic to recognize 'unable to connect' errors as transient failures

## [12.11.3] - 2026-02-19

### Fixed

- Fixed OpenAI code provider streaming to fail truncated responses that end without a terminal completion event, preventing partial outputs from being treated as successful completions.
- Fixed OpenAI code websocket append fallback by resetting stale turn-state/model-etag session metadata when request shape diverges from appendable history.

## [12.11.1] - 2026-02-19

### Added

- Added support for Anthropic model 4.6 Opus and Sonnet models via Cursor API
- Added support for Composer 1.5 model via Cursor API
- Added support for GPT-5.1 OpenAI code Mini and GPT-5.1 High models via Cursor API
- Added support for GPT-5.2 and GPT-5.3 OpenAI code variants (Fast, High, Low, Extra High) via Cursor API
- Added HTTP/2 transport support for Cursor API requests (required by Cursor API)

### Changed

- Updated pricing for Anthropic model 3.5 Sonnet model
- Updated Anthropic model 3.5 Sonnet context window from 262,144 to 131,072 tokens
- Simplified Cursor model display names by removing '(Cursor)' suffix
- Changed Cursor API timeout from 15 seconds to 5 seconds
- Switched Cursor API transport from HTTP/1.1 to HTTP/2

## [12.11.0] - 2026-02-19

### Added

- Added `priority` field to Model interface for provider-assigned model prioritization
- Added `CatalogDiscoveryConfig` interface to standardize catalog discovery configuration across providers
- Added type guards `isCatalogDescriptor()` and `allowsUnauthenticatedCatalogDiscovery()` for safer descriptor handling
- Added `DEFAULT_MODEL_PER_PROVIDER` export from descriptors module for centralized default model management
- Support for 11 new AI providers: Cloudflare AI Gateway, Hugging Face Inference, LiteLLM, Moonshot, NVIDIA, Ollama, Qianfan, Qwen Portal, Together, Venice, vLLM, and Xiaomi MiMo
- Login flows for new providers with API key validation and OAuth token support
- Extended `KnownProvider` type to include all newly supported providers
- API key environment variable mappings for all new providers in service provider map
- Model discovery and configuration for Cloudflare AI Gateway, Hugging Face, LiteLLM, Moonshot, NVIDIA, Ollama, Qianfan, Qwen Portal, Together, Venice, vLLM, and Xiaomi MiMo

### Changed

- Refactored OAuth credential retrieval to simplify storage lifecycle management in model generation script
- Parallelized special model discovery sources (Antigravity, OpenAI code) for improved generation performance
- Reorganized model JSON structure to place `contextWindow` and `maxTokens` before `compat` field for consistency
- Added `priority` field to OpenAI code provider models for provider-assigned model prioritization
- Refactored provider descriptors to use helper functions (`descriptor`, `catalog`, `catalogDescriptor`) for reduced code duplication
- Refactored models.dev provider descriptors to use helper functions (`simpleModelsDevDescriptor`, `openAiCompletionsDescriptor`, `anthropicMessagesDescriptor`) for improved maintainability
- Unified provider descriptors into single source of truth in `descriptors.ts` for both runtime model discovery and catalog generation, improving maintainability
- Refactored model generation script to use declarative `CatalogProviderDescriptor` interface instead of separate descriptor types, reducing code duplication
- Reorganized models.dev provider descriptors into logical groups (Bedrock, Core, Coding Plans, Specialized) for better code organization
- Simplified API resolution for OpenCode and GitHub Copilot providers using rule-based matching instead of inline conditionals
- Refactored model generation script to use declarative provider descriptors instead of inline provider-specific logic, improving maintainability and reducing code duplication
- Extracted model post-processing policies (cache pricing corrections, context window normalization) into dedicated `model-policies.ts` module for better testability and clarity
- Removed static bundled models for Ollama and vLLM from `models.json` to rely on dynamic discovery instead, reducing static catalog size
- Updated `OAuthProvider` type to include new provider identifiers
- Expanded model registry (models.json) with thousands of new model entries across all new providers
- Modified environment variable resolution to use `$pickenv` for providers with multiple possible env var names
- Updated README documentation to list all newly supported providers and their authentication requirements

## [12.10.1] - 2026-02-18

- Added Synthetic provider
- Added API-key login helpers for Synthetic and Cerebras providers

## [12.10.0] - 2026-02-18

### Breaking Changes

- Renamed public API functions: `getModel()` → `getBundledModel()`, `getModels()` → `getBundledModels()`, `getProviders()` → `getBundledProviders()`

### Added

- Exported `ModelManager` API for runtime-aware model resolution with dynamic endpoint discovery
- Exported provider-specific model manager configuration helpers for Google, OpenAI-compatible, OpenAI code, and Cursor providers
- Exported discovery utilities for fetching models from Antigravity, OpenAI code, Cursor, Gemini, and OpenAI-compatible endpoints
- Added `createModelManager()` function to manage bundled and dynamically discovered models with configurable refresh strategies
- Added support for on-disk model caching with TTL-based invalidation
- Added `resolveProviderModels()` function for runtime model resolution across multiple providers
- Added EU cross-region inference variants for Anthropic model Haiku 3.5 on Bedrock
- Added Anthropic model Sonnet 4.6 and Anthropic model Sonnet 4.6 Thinking models to Antigravity provider
- Added GLM-5 Free model via OpenCode provider
- Added GLM-4.7-FlashX model via ZAI provider
- Added MiniMax-M2.5-highspeed model across multiple providers (minimax-code, minimax-code-cn, minimax, minimax-cn)
- Added Anthropic model Sonnet 4.6 model to OpenRouter provider
- Added Qwen 3.5 Plus model to Vercel AI Gateway provider
- Added Anthropic model Sonnet 4.6 model to Vercel AI Gateway provider

### Changed

- Renamed `getModel()` to `getBundledModel()` to clarify it returns compile-time bundled models only
- Renamed `getModels()` to `getBundledModels()` for consistency
- Renamed `getProviders()` to `getBundledProviders()` for consistency
- Refactored model generation script to use modular discovery functions instead of monolithic provider-specific logic
- Updated models.json with new model entries and pricing updates across multiple providers
- Updated pricing for deepseek/deepseek-v3 model on OpenRouter
- Updated maxTokens from 65536 to 4096 for deepseek/deepseek-v3 on OpenRouter
- Updated pricing and maxTokens for mistralai/mistral-large-2411 on OpenRouter
- Updated pricing for qwen/qwen-max on Together AI
- Updated pricing for qwen/qwen-vl-plus on Together AI
- Updated pricing for qwen/qwen-plus on Together AI
- Updated pricing for qwen/qwen-turbo on Together AI
- Expanded EU cross-region inference variant support to all Anthropic model models on Bedrock (previously limited to Haiku, Sonnet, and Opus 4.5)

## [12.8.0] - 2026-02-16

### Added

- Added `contextPromotionTarget` model property to specify preferred fallback model when context promotion is triggered
- Added automatic context promotion target assignment for Spark models to their base model equivalents
- Added support for Brave search provider with BRAVE_API_KEY environment variable

### Changed

- Updated Qwen model context window and max token limits for improved accuracy

## [12.7.0] - 2026-02-16

### Added

- Added DeepSeek-V3.2 model support via Amazon Bedrock
- Added GLM-5 model support via OpenCode
- Added MiniMax M2.5 model support via OpenCode

### Changed

- Updated GLM-4.5, GLM-4.5-Air, GLM-4.5-Flash, GLM-4.5V, GLM-4.6, GLM-4.6V, GLM-4.7, GLM-4.7-Flash, and GLM-5 models to use anthropic-messages API instead of openai-completions
- Updated GLM models base URL from https://api.z.ai/api/coding/paas/v4 to https://api.z.ai/api/anthropic
- Updated pricing for multiple models including Mistral, Moonshot, and Qwen variants
- Updated context window and max tokens for several models to reflect accurate specifications

### Removed

- Removed compat field with supportsDeveloperRole and thinkingFormat properties from GLM models

## [12.6.0] - 2026-02-16

### Added

- Added source-scoped custom API and OAuth provider registration helpers for extension-defined providers.

### Changed

- Expanded `Api` typing to allow extension-defined API identifiers while preserving built-in API exhaustiveness checks.

### Fixed

- Fixed custom API registration to reject built-in API identifiers and prevent accidental provider overrides.

## [12.2.0] - 2026-02-13

### Added

- Added automatic retry logic for WebSocket stream closures before response completion, with configurable retry budget to improve reliability on flaky connections
- Added `providerSessionState` option to enable provider-scoped mutable state persistence across agent turns
- Added WebSocket retry logic with configurable retry budget and delay via `PI_OPENAI_CODE_WEBSOCKET_RETRY_BUDGET` and `PI_OPENAI_CODE_WEBSOCKET_RETRY_DELAY_MS` environment variables
- Added WebSocket idle timeout detection via `PI_OPENAI_CODE_WEBSOCKET_IDLE_TIMEOUT_MS` environment variable to fail stalled connections
- Added WebSocket v2 beta header support via `PI_OPENAI_CODE_WEBSOCKET_V2` environment variable for newer OpenAI API versions
- Added WebSocket handshake header capture to extract and replay session metadata (turn state, models etag, reasoning flags) across SSE fallback requests
- Added `preferWebsockets` option to enable WebSocket transport for OpenAI code provider responses when supported
- Added `prewarmOpenAIOpenAI codeResponses()` function to establish and reuse WebSocket connections across multiple requests
- Added `getOpenAIOpenAI codeTransportDetails()` function to inspect transport layer details including WebSocket status and fallback information
- Added `getProviderDetails()` function to retrieve formatted provider configuration and transport information
- Added automatic fallback from WebSocket to SSE when connection fails, with transparent retry logic
- Added session state management to reuse WebSocket connections and enable request appending across turns
- Added support for x-openai-code-turn-state header to maintain conversation state across SSE requests

### Changed

- Changed WebSocket session state storage from global maps to provider-scoped session state for multi-agent isolation
- Changed WebSocket connection initialization to accept idle timeout configuration and handshake header callbacks
- Changed WebSocket error handling to use standardized transport error messages with `OpenAI code websocket transport error` prefix
- Changed WebSocket retry behavior to retry transient failures before activating sticky fallback, improving reliability on flaky connections
- Changed OpenAI code provider model configuration to prefer WebSocket transport by default with `preferWebsockets: true`
- Changed header handling to use appropriate OpenAI-Beta header values for WebSocket vs SSE transports
- Perplexity OAuth token refresh now uses JWT expiry extraction instead of Socket.IO RPC, improving reliability when server is unreachable
- Removed Socket.IO client implementation for Perplexity token refresh; tokens are now validated using embedded JWT expiry claims

### Removed

- Removed `refreshPerplexityToken` export; token refresh is now handled internally via JWT expiry detection

### Fixed

- Fixed WebSocket stream retry logic to properly handle mid-stream connection closures and retry before falling back to SSE transport
- Fixed `preferWebsockets` option handling to correctly respect explicit `false` values when determining transport preference
- Fixed WebSocket append state not being reset after aborted requests, preventing stale state from affecting subsequent turns
- Fixed WebSocket append state not being reset after stream errors, preventing failed append attempts from blocking future requests
- Fixed OpenAI code model context window metadata to use 272000 input tokens (instead of 400000 total budget) for non-Spark OpenAI code variants

## [12.0.0] - 2026-02-12

### Added

- Added GPT-5.3 OpenAI code Spark model with 128K context window and extended reasoning capabilities
- Added MiniMax M2.5 and M2.5 Lightning models via OpenAI-compatible API (minimax-code provider)
- Added MiniMax M2.5 and M2.5 Lightning models via OpenAI-compatible API (minimax-code-cn provider for China region)
- Added MiniMax M2.5 and M2.5 Lightning models via Anthropic API (minimax and minimax-cn providers)
- Added Llama 3.1 8B model via Cerebras API
- Added MiniMax M2.5 model via OpenRouter
- Added MiniMax M2.5 model via Vercel AI Gateway
- Added MiniMax M2.5 Free model via OpenCode
- Added Qwen3 VL 32B Instruct multimodal model via OpenRouter

### Changed

- Updated Z.ai GLM-5 pricing and context window configuration on OpenRouter
- Updated Qwen3 Max Thinking max tokens from 32768 to 65536 on OpenRouter
- Updated OpenAI GPT-5 Image Mini pricing on OpenRouter
- Updated OpenAI GPT-5 Pro pricing and context window on OpenRouter
- Updated OpenAI o4-mini pricing and context window on OpenRouter
- Updated Anthropic model Opus 4.5 Thinking model name formatting (removed parentheses)
- Updated Anthropic model Opus 4.6 Thinking model name formatting (removed parentheses)
- Updated Anthropic model Sonnet 4.5 Thinking model name formatting (removed parentheses)
- Updated Gemini 2.5 Flash Thinking model name formatting (removed parentheses)
- Updated Gemini 3 Pro High and Low model name formatting (removed parentheses)
- Updated GPT-OSS 120B Medium model name formatting (removed parentheses) and context window to 131072

### Removed

- Removed GLM-5 model from Z.ai provider
- Removed Trinity Large Preview Free model from OpenCode provider
- Removed MiniMax M2.1 Free model from OpenCode provider
- Removed deprecated Anthropic model entries: `anthropic-model-3-5-haiku-latest`, `anthropic-model-3-5-haiku-20241022`, `anthropic-model-3-7-sonnet-20250219`, `anthropic-model-3-7-sonnet-latest`, `anthropic-model-3-opus-20240229`, `anthropic-model-3-sonnet-20240229` ([#33](https://github.com/can1357/gajae-code/issues/33))

### Fixed

- Added deprecation filter in model generation script to prevent re-adding deprecated Anthropic models ([#33](https://github.com/can1357/gajae-code/issues/33))

## [11.14.1] - 2026-02-12

### Added

- Added prompt-caching-scope-2026-01-05 beta feature support

### Changed

- Updated Anthropic Code version header to 2.1.39
- Updated runtime version header to v24.13.1 and package version to 0.73.0
- Increased request timeout from 60s to 600s
- Reordered Accept-Encoding header values for compression preference
- Updated OAuth authorization and token endpoints to use platform.anthropic-model.com
- Expanded OAuth scopes to include user:sessions:anthropic-model_code and user:mcp_servers

### Removed

- Removed anthropic-model-code-20250219 beta feature from default models
- Removed fine-grained-tool-streaming-2025-05-14 beta feature

## [11.13.1] - 2026-02-12

### Added

- Added Perplexity (Pro/Max) OAuth login support via native macOS app extraction or email OTP authentication
- Added `loginPerplexity` and `refreshPerplexityToken` functions for Perplexity account integration
- Added Socket.IO v4 client implementation for authenticated WebSocket communication with Perplexity API

## [11.12.0] - 2026-02-11

### Changed

- Increased maximum retry attempts for OpenAI code requests from 2 to 5 to improve reliability on transient failures

### Fixed

- Fixed tool result content handling in Anthropic provider to provide fallback error message when content is empty
- Improved retry delay calculation to parse delay values from error response bodies (e.g., 'Please try again in 225ms')

## [11.11.0] - 2026-02-10

### Breaking Changes

- Replaced `./models.generated` export with `./models.json` - update imports from `import { MODELS } from './models.generated'` to `import MODELS from './models.json' with { type: 'json' }`

### Added

- Added TypeScript type declarations for `models.json` to enable proper type inference when importing the JSON file

### Changed

- Updated available models in google-antigravity provider with new model variants and updated context window/token limits
- Simplified type signatures for `getModel()` and `getModels()` functions for improved usability
- Changed models export from TypeScript module to JSON format for improved performance and reduced bundle size
- Updated `@anthropic-ai/sdk` dependency from ^0.72.1 to ^0.74.0

## [11.10.0] - 2026-02-10

### Added

- Added support for Kimi K2, K2 Turbo Preview, and K2.5 models with reasoning capabilities

### Fixed

- Fixed Anthropic model Opus 4.6 context window to 200K across all providers (was incorrectly set to 1M)
- Fixed Anthropic model Sonnet 4 context window to 200K across multiple providers (was incorrectly set to 1M)

## [11.8.0] - 2026-02-10

### Added

- Added `auto` model alias for OpenRouter with automatic model routing
- Added `openrouter/aurora-alpha` model with reasoning capabilities
- Added `qwen/qwen3-max-thinking` model with extended context window support
- Added support for `parametersJsonSchema` in Google Gemini tool definitions for improved JSON Schema compatibility

### Changed

- Updated Anthropic model Sonnet 4 and 4.5 context window from 1M to 200K tokens to reflect actual limits
- Updated Anthropic model Opus 4.6 context window to 200K tokens across providers
- Changed default `reasoningSummary` for OpenAI code provider from `undefined` to `auto`
- Updated Qwen model pricing and context window specifications across multiple variants
- Modified Google Gemini CLI system instruction to use compact format
- Changed tool parameter handling for Anthropic model models on Google Cloud Code Assist to use legacy `parameters` field for API translation

### Removed

- Removed `glm-4.7-free` model from OpenCode provider
- Removed `qwen3-coder` model from OpenCode provider
- Removed `ai21/jamba-mini-1.7` model from OpenRouter
- Removed `stepfun-ai/step3` model from OpenRouter
- Removed duplicate test suite for Google Antigravity Provider with `gemini-3-pro-high`

### Fixed

- Fixed Amazon Bedrock HTTP/1.1 handler import to use direct import instead of dynamic import
- Fixed Qwen model context window and pricing inconsistencies across OpenRouter
- Fixed cache read pricing for multiple Qwen models
- Fixed OpenAI code provider reasoning effort clamping for `gpt-5.3-openai-code` model

## [11.7.1] - 2026-02-07

### Added

- Added Anthropic model Opus 4.6 Thinking model for Antigravity provider
- Added Gemini 2.5 Flash, Gemini 2.5 Flash Thinking, and Gemini 2.5 Pro models for Antigravity provider
- Added Pony Alpha model via OpenRouter

### Changed

- Updated Antigravity models to use free tier pricing (0 cost) across all models
- Changed Antigravity model fetching to dynamically load from API when credentials are available, with hardcoded fallback models
- Updated Anthropic model Opus 4.6 context window from 200,000 to 1,000,000 tokens across Bedrock regions
- Updated Anthropic model Opus 4.6 cache pricing from 1.5/18.75 to 0.5/6.25 for EU and US regions
- Updated Antigravity model pricing to free tier (0 cost) for Anthropic model Opus 4.5 Thinking, Anthropic model Sonnet 4.5 Thinking, Gemini 3 Flash, Gemini 3 Pro variants, and GPT-OSS 120B Medium
- Updated GPT-OSS 120B Medium reasoning capability from false to true
- Updated Gemini 3 Flash max tokens from 65,535 to 65,536
- Updated Anthropic model Opus 4.5 Thinking display name formatting to include parentheses
- Updated various model pricing and context window parameters across OpenRouter and other providers
- Removed Anthropic model Opus 4.6 20260205 model from Anthropic provider

### Fixed

- Fixed Anthropic model Opus 4.6 model ID format by removing version suffix (:0) in Bedrock configurations
- Fixed Llama 3.1 70B Instruct pricing and context window parameters
- Fixed Mistral model pricing and cache read costs
- Fixed DeepSeek and other model pricing inconsistencies
- Fixed Qwen model pricing and token limits
- Fixed GLM model pricing and context window specifications

## [11.6.0] - 2026-02-07

### Added

- Added Bedrock cache retention support with `PI_CACHE_RETENTION` env var and per-request `cacheRetention` option
- Added adaptive thinking support for Bedrock Opus 4.6+ models
- Added `AWS_BEDROCK_SKIP_AUTH` env var to support unauthenticated Bedrock proxies
- Added `AWS_BEDROCK_FORCE_HTTP1` env var to force HTTP/1.1 for custom Bedrock endpoints
- Re-exported `Static`, `TSchema`, and `Type` from `@sinclair/typebox`

### Fixed

- Fixed OpenAI Responses storage disabled by default (`store: false`)
- Fixed reasoning effort clamping for gpt-5.3 OpenAI code models (minimal -> low)
- Fixed Bedrock `supportsPromptCaching` to also check model cost fields

## [11.5.1] - 2026-02-07

### Fixed

- Fixed schema normalization to handle array-valued `type` fields by converting them to a single type with nullable flag for Google provider compatibility

## [11.3.0] - 2026-02-06

### Added

- Added `cacheRetention` option to control prompt cache retention preference ('none', 'short', 'long') across providers
- Added `maxRetryDelayMs` option to cap server-requested retry delays and fail fast when delays exceed the limit
- Added `effort` option for Anthropic Opus 4.6+ models to control adaptive thinking effort levels ('low', 'medium', 'high', 'max')
- Added support for Anthropic Opus 4.6+ adaptive thinking mode that lets Anthropic model decide when and how much to think
- Added `PI_AI_ANTIGRAVITY_VERSION` environment variable to customize Antigravity sandbox endpoint version
- Exported `convertAnthropicMessages` function for converting message formats to Anthropic API
- Automatic fallback for Anthropic assistant-prefill requests: appends synthetic user "Continue." message when conversation ends with assistant turn to maintain API compatibility

### Changed

- Changed `supportsXhigh()` to include GPT-5.1 OpenAI code Max and broaden Anthropic support to all Anthropic Messages API models with budget-based thinking capability
- Changed Anthropic thinking mode to use adaptive thinking for Opus 4.6+ models instead of budget-based thinking
- Changed `supportsXhigh()` to support GPT-5.2/5.3 and Anthropic Opus 4.6+ models with adaptive thinking
- Changed prompt caching to respect `cacheRetention` option and support TTL configuration for Anthropic
- Changed OpenAI tool definitions to conditionally include `strict` field only when provider supports it
- Changed Qwen model support to use `enable_thinking` boolean parameter instead of OpenAI-style reasoning_effort

### Fixed

- Fixed indentation and formatting in `convertAnthropicMessages` function
- Fixed handling of conversations ending with assistant messages on Anthropic-routed models that reject assistant prefill requests

## [11.2.3] - 2026-02-05

### Added

- Added Anthropic model Opus 4.6 model support across multiple providers (Anthropic, Amazon Bedrock, GitHub Copilot, OpenRouter, OpenCode, Vercel AI Gateway)
- Added GPT-5.3 OpenAI code model support for OpenAI
- Added `readSseJson` utility import for improved SSE stream handling in Google Gemini CLI provider

### Changed

- Updated Google Gemini CLI provider to use `readSseJson` utility for cleaner SSE stream parsing
- Updated pricing for Llama 3.1 405B model on Vercel AI Gateway (cache read rate adjusted)
- Updated Llama 3.1 405B context window and max tokens on Vercel AI Gateway (256000 for both)

### Removed

- Removed Kimi K2, Kimi K2 Turbo Preview, and Kimi K2.5 models
- Removed Deep Cogito Cogito V2 Preview models from OpenRouter

## [11.0.0] - 2026-02-05

### Changed

- Replaced direct `Bun.env` access with `getEnv()` utility from `@gajae-code/utils` for consistent environment variable handling across all providers
- Updated environment variable names from `GJC_*` prefix to `PI_*` prefix for consistency (e.g., `GJC_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR`)

### Removed

- Removed automatic environment variable migration from `PI_*` to `GJC_*` prefixes via `migrate-env.ts` module

## [10.5.0] - 2026-02-04

### Changed

- Updated @anthropic-ai/sdk to ^0.72.1
- Updated @aws-sdk/client-bedrock-runtime to ^3.982.0
- Updated @google/genai to ^1.39.0
- Updated @smithy/node-http-handler to ^4.4.9
- Updated openai to ^6.17.0
- Updated @types/node to ^25.2.0

### Removed

- Removed proxy-agent dependency
- Removed undici dependency

## [9.4.0] - 2026-01-31

### Added

- Added `getEnv()` function to retrieve environment variables from Bun.env, cwd/.env, or ~/.env
- Added support for reading .env files from home directory and current working directory
- Added support for `exa` and `perplexity` as known providers in `getEnvApiKey()`

### Changed

- Changed `getEnvApiKey()` to check Bun.env, cwd/.env, and ~/.env files in order of precedence
- Refactored provider API key resolution to use a declarative service provider map

## [9.2.2] - 2026-01-31

### Added

- Added OpenCode Zen provider with API key authentication for accessing multiple AI models
- Added 4 new free models via OpenCode: glm-4.7-free, kimi-k2.5-free, minimax-m2.1-free, trinity-large-preview-free
- Added glm-4.7-flash model via Zai provider
- Added Kimi Code provider with OpenAI and Anthropic API format support
- Added prompt cache retention support with PI_CACHE_RETENTION env var
- Added overflow patterns for Bedrock, MiniMax, Kimi; reclassified 429 as rate limiting
- Added profile endpoint integration to resolve user emails with 24-hour caching
- Added automatic token refresh for expired Kimi OAuth credentials
- Added Kimi Code OAuth handler with device authorization flow
- Added Kimi Code usage provider with quota caching
- Added 4 new Kimi Code models (kimi-for-coding, kimi-k2, kimi-k2-turbo-preview, kimi-k2.5)
- Added Kimi Code provider integration with OAuth and token management
- Added tool-choice utility for mapping unified ToolChoice to provider-specific formats
- Added ToolChoice type for controlling tool selection (auto, none, any, required, function)

### Changed

- Updated Kimi K2.5 cache read pricing from 0.1 to 0.08
- Updated MiniMax M2 pricing: input 0.6→0.6, output 3→3, cache read 0.1→0.09999999999999999
- Updated OpenRouter DeepSeek V3.1 pricing and max tokens: input 0.6→0.5, output 3→2.8, maxTokens 262144→4096
- Updated OpenRouter DeepSeek R1 pricing and max tokens: input 0.06→0.049999999999999996, output 0.24→0.19999999999999998, maxTokens 262144→4096
- Updated Anthropic Anthropic model 3.5 Sonnet max tokens from 256000 to 65536 on OpenRouter
- Updated Vercel AI Gateway Anthropic model 3.5 Sonnet cache read pricing from 0.125 to 0.13
- Updated Vercel AI Gateway Anthropic model 3.5 Sonnet New cache read pricing from 0.125 to 0.13
- Updated Vercel AI Gateway GPT-5.2 cache read pricing from 0.175 to 0.18 and display name to 'GPT 5.2'
- Updated Zai GLM-4.6 cache read pricing from 0.024999999999999998 to 0.03
- Updated Zai Qwen QwQ max tokens from 66000 to 16384
- Added delta event batching and throttling (50ms, 20 updates/sec max) to AssistantMessageEventStream
- Updated MiniMax-M2 pricing: input 1.2→0.6, output 1.2→3, cacheRead 0.6→0.1

### Removed

- Removed OpenRouter google/gemini-2.0-flash-exp:free model
- Removed Vercel AI Gateway stealth/sonoma-dusk-alpha and stealth/sonoma-sky-alpha models

### Fixed

- Fixed rate limit issues with Kimi models by always sending max_tokens
- Added handling for sensitive stop reason from Anthropic API safety filters
- Added optional chaining for safer JSON schema property access in Anthropic provider

## [8.6.0] - 2026-01-27

### Changed

- Replaced JSON5 dependency with Bun.JSON5 parsing

### Fixed

- Filtered empty user text blocks for OpenAI-compatible completions and normalized Kimi reasoning_content for OpenRouter tool-call messages

## [8.4.0] - 2026-01-25

### Added

- Added Azure OpenAI Responses provider with deployment mapping and resource-based base URL support

### Changed

- Added OpenRouter routing preferences for OpenAI-compatible completions

### Fixed

- Defaulted Google tool call arguments to empty objects when providers omit args
- Guarded Responses/OpenAI code streaming deltas against missing content parts and handled arguments.done events

## [8.2.1] - 2026-01-24

### Fixed

- Fixed handling of streaming function call arguments in OpenAI responses to properly parse arguments when sent via `response.function_call_arguments.done` events

## [8.2.0] - 2026-01-24

### Changed

- Migrated node module imports from named to namespace imports across all packages for consistency with project guidelines

## [8.0.0] - 2026-01-23

### Fixed

- Fixed OpenAI Responses API 400 error "function_call without required reasoning item" when switching between models (same provider, different model). The fix omits the `id` field for function_calls from different models to avoid triggering OpenAI's reasoning/function_call pairing validation
- Fixed 400 errors when reading multiple images via GitHub Copilot's Anthropic model models. Anthropic model requires tool_use -> tool_result adjacency with no user messages interleaved. Images from consecutive tool results are now batched into a single user message

## [7.0.0] - 2026-01-21

### Added

- Added usage tracking system with normalized schema for provider quota/limit endpoints
- Added Anthropic model usage provider for 5-hour and 7-day quota windows
- Added GitHub Copilot usage provider for chat, completions, and premium requests
- Added Google Antigravity usage provider for model quota tracking
- Added Google Gemini CLI usage provider for tier-based quota monitoring
- Added OpenAI code provider usage provider for primary and secondary rate limit windows
- Added ZAI usage provider for token and request quota tracking

### Changed

- Updated Anthropic model usage provider to extract account identifiers from response headers
- Updated GitHub Copilot usage provider to include account identifiers in usage reports
- Updated Google Gemini CLI usage provider to handle missing reset time gracefully

### Fixed

- Fixed GitHub Copilot usage provider to simplify token handling and improve reliability
- Fixed GitHub Copilot usage provider to properly resolve account identifiers for OAuth credentials
- Fixed API validation errors when sending empty user messages (resume with `.`) across all providers:
- Google Cloud Code Assist (google-shared.ts)
- OpenAI Responses API (openai-responses.ts)
- OpenAI code provider Responses API (openai-code-responses.ts)
- Cursor (cursor.ts)
- Amazon Bedrock (amazon-bedrock.ts)
- Clamped OpenAI code provider reasoning effort "minimal" to "low" for gpt-5.2 models to avoid API errors
- Fixed GitHub Copilot usage fallback to internal quota endpoints when billing usage is unavailable
- Fixed GitHub Copilot usage metadata to include account identifiers for report dedupe
- Fixed Anthropic usage metadata extraction to include account identifiers when provided by the usage endpoint
- Fixed Gemini CLI usage windows to consistently label quota windows for display suppression

## [6.9.69] - 2026-01-21

### Added

- Added duration and time-to-first-token (ttft) metrics to all AI provider responses
- Added performance tracking for streaming responses across all providers

## [6.9.0] - 2026-01-21

### Removed

- Removed openai-code provider exports from main package index
- Removed openai-code prompt utilities and moved them inline
- Removed vitest configuration file

## [6.8.4] - 2026-01-21

### Changed

- Updated prompt caching strategy to follow Anthropic's recommended hierarchy
- Fixed token usage tracking to properly handle cumulative output tokens from message_delta events
- Improved message validation to filter out empty or invalid content blocks
- Increased OAuth callback timeout from 120 seconds to 120,000 milliseconds

## [6.8.3] - 2026-01-21

### Added

- Added `headers` option to all providers for custom request headers
- Added `onPayload` hook to observe provider request payloads before sending
- Added `strictResponsesPairing` option for Azure OpenAI Responses API compatibility
- Added `originator` option to `loginOpenAIOpenAI code` for custom OAuth flow identification
- Added per-request `headers` and `onPayload` hooks to `StreamOptions`
- Added `originator` option to `loginOpenAIOpenAI code`

### Fixed

- Fixed tool call ID normalization for OpenAI Responses API cross-provider handoffs
- Skipped errored or aborted assistant messages during cross-provider transforms
- Detected AWS ECS/IRSA credentials for Bedrock authentication checks
- Detected AWS ECS/IRSA credentials for Bedrock authentication checks
- Normalized Responses API tool call IDs during handoffs and refreshed handoff tests
- Enforced strict tool call/result pairing for Azure OpenAI Responses API
- Skipped errored or aborted assistant messages during cross-provider transforms

### Security

- Enhanced AWS credential detection to support ECS task roles and IRSA web identity tokens

## [6.8.2] - 2026-01-21

### Fixed

- Improved error handling for aborted requests in Google Gemini CLI provider
- Enhanced OAuth callback flow to handle manual input errors gracefully
- Fixed login cancellation handling in GitHub Copilot OAuth flow
- Removed fallback manual input from OpenAI code provider OAuth flow

### Security

- Hardened database file permissions to prevent credential leakage
- Set secure directory permissions (0o700) for credential storage

## [6.8.0] - 2026-01-20

### Added

- Added `logout` command to CLI for OAuth provider logout
- Added `status` command to show logged-in providers and token expiry
- Added persistent credential storage using SQLite database
- Added OAuth callback server with automatic port fallback
- Added HTML callback page with success/error states
- Added support for Cursor OAuth provider

### Changed

- Updated Promise.withResolvers usage for better compatibility
- Replaced custom sleep implementations with Bun.sleep and abortableSleep
- Simplified SSE stream parsing using readLines utility
- Updated test framework from vitest to bun:test
- Replaced temp directory creation with TempDir API
- Changed credential storage from auth.json to ~/.gjc/agent/agent.db
- Changed CLI command examples from npx to bunx
- Refactored OAuth flows to use common callback server base class
- Updated OAuth provider interfaces to use controller pattern

### Fixed

- Fixed OAuth callback handling with improved error states
- Fixed token refresh for all OAuth providers

## [6.7.670] - 2026-01-19

### Changed

- Updated Anthropic Code compatibility headers and version
- Improved OAuth token handling with proper state generation
- Enhanced cache control for tool and user message blocks
- Simplified tool name prefixing for OAuth traffic
- Updated PKCE verifier generation for better security

## [5.7.67] - 2026-01-18

### Fixed

- Added error handling for unknown OAuth providers

## [5.6.77] - 2026-01-18

### Fixed

- Prevented duplicate tool results for errored or aborted messages when results already exist

## [5.6.7] - 2026-01-18

### Added

- Added automatic retry logic for OpenAI code provider responses with configurable delay and max retries
- Added tool call ID sanitization for Amazon Bedrock to ensure valid characters
- Added tool argument validation that coerces JSON-encoded strings for expected non-string types

### Changed

- Updated environment variable prefix from PI* to GJC* for better consistency
- Added automatic migration for legacy PI* environment variables to GJC* equivalents
- Adjusted Bedrock Anthropic model thinking budgets to reserve output tokens when maxTokens is too low

### Fixed

- Fixed orphaned tool call handling to ensure proper tool_use/tool_result pairing for all assistant messages
- Fixed message transformation to insert synthetic tool results for errored/aborted assistant messages with tool calls
- Fixed tool prefix handling in Anthropic model provider to use case-insensitive comparison
- Fixed Gemini 3 model handling to treat unsigned tool calls as context-only with anti-mimicry context
- Fixed message transformation to filter out empty error messages from conversation history
- Fixed OpenAI completions provider compatibility detection to use provider metadata
- Fixed OpenAI completions provider to avoid using developer role for opencode provider
- Fixed orphaned tool call handling to skip synthetic results for errored assistant messages

## [5.5.0] - 2026-01-18

### Changed

- Updated User-Agent header from 'opencode' to 'pi' for OpenAI code provider requests
- Simplified OpenAI code system prompt instructions
- Removed bridge text override from OpenAI code system prompt builder

## [5.3.0] - 2026-01-15

### Changed

- Replaced detailed OpenAI code system instructions with simplified pi assistant instructions
- Updated internal documentation references to use pi-internal:// protocol

## [5.1.0] - 2026-01-14

### Added

- Added Amazon Bedrock provider with `bedrock-converse-stream` API for Anthropic model models via AWS
- Added MiniMax provider with OpenAI-compatible API
- Added EU cross-region inference model variants for Anthropic model models on Bedrock

### Fixed

- Fixed Gemini CLI provider retries with proper error handling, retry delays from headers, and empty stream retry logic
- Fixed numbered list items showing "1." for all items when code blocks break list continuity (via `start` property)

## [5.0.0] - 2026-01-12

### Added

- Added support for `xhigh` thinking level in `thinkingBudgets` configuration

### Changed

- Changed Anthropic thinking token budgets: minimal (1024→3072), low (2048→6144), medium (8192→12288), high (16384→24576)
- Changed Google thinking token budgets: minimal (1024), low (2048→4096), medium (8192), high (16384), xhigh (24575)
- Changed `supportsXhigh()` to return true for all Anthropic models

## [4.6.0] - 2026-01-12

### Fixed

- Fixed incorrect classification of thought signatures in Google Gemini responses—thought signatures are now correctly treated as metadata rather than thinking content indicators
- Fixed thought signature handling in Google Gemini CLI and Vertex AI streaming to properly preserve signatures across text deltas
- Fixed Google schema sanitization stripping property names that match schema keywords (e.g., "pattern", "format") from tool definitions

## [4.4.9] - 2026-01-12

### Fixed

- Fixed Google provider schema sanitization to strip additional unsupported JSON Schema fields (patternProperties, additionalProperties, min/max constraints, pattern, format)

## [4.4.8] - 2026-01-12

### Fixed

- Fixed Google provider schema sanitization to properly collapse `anyOf`/`oneOf` with const values into enum arrays
- Fixed const-to-enum conversion to infer type from the const value when type is not specified

## [4.4.6] - 2026-01-11

### Fixed

- Fixed tool parameter schema sanitization to only apply Google-specific transformations for Gemini models, preserving original schemas for other model types

## [4.4.5] - 2026-01-11

### Changed

- Exported `sanitizeSchemaForGoogle` utility function for external use

### Fixed

- Fixed Google provider schema sanitization to strip additional unsupported JSON Schema fields ($schema, $ref, $defs, format, examples, and others)
- Fixed Google provider to ignore `additionalProperties: false` which is unsupported by the API

## [4.4.4] - 2026-01-11

### Fixed

- Fixed Cursor todo updates to bridge update_todos tool calls to the local todo_write tool

## [4.3.0] - 2026-01-11

### Added

- Added debug log filtering and display script for Cursor JSONL logs with follow mode and coalescing support
- Added protobuf definition extractor script to reconstruct .proto files from bundled JavaScript
- Added conversation state caching to persist context across multiple Cursor API requests in the same session
- Added shell streaming support for real-time stdout/stderr output during command execution
- Added JSON5 parsing for MCP tool arguments with Python-style boolean and None value normalization
- Added Cursor provider with support for Anthropic model, GPT, and Gemini models via Cursor's agent API
- Added OAuth authentication flow for Cursor including login, token refresh, and expiry detection
- Added `cursor-agent` API type with streaming support and tool execution handlers
- Added Cursor model definitions including Anthropic model 4.5, GPT-5.x, Gemini 3, and Grok variants
- Added model generation script to automatically fetch and update AI model definitions from models.dev and OpenRouter APIs

### Changed

- Changed Cursor debug logging to use structured JSONL format with automatic MCP argument decoding
- Changed MCP tool argument decoding to use protobuf Value schema for improved type handling
- Changed tool advertisement to filter Cursor native tools (bash, read, write, delete, ls, grep, lsp) instead of only exposing mcp\_ prefixed tools

### Fixed

- Fixed Cursor conversation history serialization so subagents retain task context and can call complete

## [4.2.1] - 2026-01-11

### Changed

- Updated `reasoningSummary` option to accept only `"auto"`, `"concise"`, `"detailed"`, or `null` (removed `"off"` and `"on"` values)
- Changed default `reasoningSummary` from `"auto"` to `"detailed"`
- OpenAI code provider: switched to bundled system prompt matching opencode, changed originator to "opencode", simplified prompt handling

### Fixed

- Fixed Cloud Code Assist tool schema conversion to avoid unsupported `const` fields

## [4.0.0] - 2026-01-10

### Added

- Added `betas` option in `AnthropicOptions` for passing custom Anthropic beta feature flags
- OpenCode Zen provider support with 26 models (Anthropic model, GPT, Gemini, Grok, Kimi, GLM, Qwen, etc.). Set `OPENCODE_API_KEY` env var to use.
- `thinkingBudgets` option in `SimpleStreamOptions` for customizing token budgets per thinking level on token-based providers
- `sessionId` option in `StreamOptions` for providers that support session-based caching. OpenAI code provider provider uses this to set `prompt_cache_key` and routing headers.
- `supportsUsageInStreaming` compatibility flag for OpenAI-compatible providers that reject `stream_options: { include_usage: true }`. Defaults to `true`. Set to `false` in model config for providers like gatewayz.ai.
- `GOOGLE_APPLICATION_CREDENTIALS` env var support for Vertex AI credential detection (standard for CI/production)
- Exported OpenAI code provider utilities: `CacheMetadata`, `getOpenAI codeInstructions`, `getModelFamily`, `ModelFamily`, `buildOpenAI codePiBridge`, `buildOpenAI codeSystemPrompt`, `OpenAI codeSystemPrompt`
- Headless OAuth support for all callback-server providers (Google Gemini CLI, Antigravity, OpenAI code provider): paste redirect URL when browser callback is unreachable
- Cancellable GitHub Copilot device code polling via AbortSignal
- Improved error messages for OpenRouter providers by including raw metadata from upstream errors

### Changed

- Changed Anthropic provider to include Anthropic Code system instruction for all API key types, not just OAuth tokens (except Haiku models)
- Changed Anthropic OAuth tool naming to use `proxy_` prefix instead of mapping to Anthropic Code tool names, avoiding potential name collisions
- Changed Anthropic provider to include Anthropic Code headers for all requests, not just OAuth tokens
- Anthropic provider now maps tool names to Anthropic Code's exact tool names (Read, Write, Edit, Bash, Grep, Glob) instead of using prefixed names
- OpenAI Completions provider now disables strict mode on tools to allow optional parameters without null unions

### Fixed

- Fixed Anthropic OAuth code parsing to accept full redirect URLs in addition to raw authorization codes
- Fixed Anthropic token refresh to preserve existing refresh token when server doesn't return a new one
- Fixed thinking mode being enabled when tool_choice forces a specific tool, which is unsupported
- Fixed max_tokens being too low when thinking budget is set, now auto-adjusts to model's maxTokens
- Google Cloud Code Assist OAuth for paid subscriptions: properly handles long-running operations for project provisioning, supports `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env vars for paid tiers
- `os.homedir()` calls at module load time; now resolved lazily when needed
- OpenAI Responses tool strict flag to use a boolean for LM Studio compatibility
- Gemini CLI abort handling: detect native `AbortError` in retry catch block, cancel SSE reader when abort signal fires
- Antigravity provider 429 errors by aligning request payload with CLIProxyAPI v6.6.89
- Thinking block handling for cross-model conversations: thinking blocks are now converted to plain text when switching models
- OpenAI code provider context window from 400,000 to 272,000 tokens to match OpenAI code CLI defaults
- OpenAI code SSE error events to surface message, code, and status
- Context overflow detection for `context_length_exceeded` error codes
- OpenAI code provider now always includes `reasoning.encrypted_content` even when custom `include` options are passed
- OpenAI code requests now omit the `reasoning` field entirely when thinking is off
- Crash when pasting text with trailing whitespace exceeding terminal width

## [3.37.1] - 2026-01-10

### Added

- Added automatic type coercion for tool arguments when LLMs return JSON-encoded strings instead of native types (numbers, booleans, arrays, objects)

### Changed

- Changed tool argument validation to attempt JSON parsing and type coercion before rejecting mismatched types
- Changed validation error messages to include both original and normalized arguments when coercion was attempted

## [3.37.0] - 2026-01-10

### Changed

- Enabled type coercion in JSON schema validation to automatically convert compatible types

## [3.35.0] - 2026-01-09

### Added

- Enhanced error messages to include retry-after timing information from API rate limit headers

## [0.42.0] - 2026-01-09

### Added

- Added OpenCode Zen provider support with 26 models (Anthropic model, GPT, Gemini, Grok, Kimi, GLM, Qwen, etc.). Set `OPENCODE_API_KEY` env var to use.

## [0.39.0] - 2026-01-08

### Fixed

- Fixed Gemini CLI abort handling: detect native `AbortError` in retry catch block, cancel SSE reader when abort signal fires ([#568](https://github.com/badlogic/pi-mono/pull/568) by [@tmustier](https://github.com/tmustier))
- Fixed Antigravity provider 429 errors by aligning request payload with CLIProxyAPI v6.6.89: inject Antigravity system instruction with `role: "user"`, set `requestType: "agent"`, and use `antigravity` userAgent. Added bridge prompt to override Antigravity behavior (identity, paths, web dev guidelines) with Pi defaults. ([#571](https://github.com/badlogic/pi-mono/pull/571) by [@ben-vargas](https://github.com/ben-vargas))
- Fixed thinking block handling for cross-model conversations: thinking blocks are now converted to plain text (no `<thinking>` tags) when switching models. Previously, `<thinking>` tags caused models to mimic the pattern and output literal tags. Also fixed empty thinking blocks causing API errors. ([#561](https://github.com/badlogic/pi-mono/issues/561))

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option in `SimpleStreamOptions` for customizing token budgets per thinking level on token-based providers ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

### Breaking Changes

- Removed OpenAI code provider model aliases (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `openai-code-mini-latest`, `gpt-5-openai-code`, `gpt-5.1-openai-code`, `gpt-5.1-chat-latest`). Use canonical model IDs: `gpt-5.1`, `gpt-5.1-openai-code-max`, `gpt-5.1-openai-code-mini`, `gpt-5.2`, `gpt-5.2-openai-code`. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))

### Fixed

- Fixed OpenAI code provider context window from 400,000 to 272,000 tokens to match OpenAI code CLI defaults and prevent 400 errors. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))
- Fixed OpenAI code SSE error events to surface message, code, and status. ([#551](https://github.com/badlogic/pi-mono/pull/551) by [@tmustier](https://github.com/tmustier))
- Fixed context overflow detection for `context_length_exceeded` error codes.

## [0.37.6] - 2026-01-06

### Added

- Exported OpenAI code provider utilities: `CacheMetadata`, `getOpenAI codeInstructions`, `getModelFamily`, `ModelFamily`, `buildOpenAI codePiBridge`, `buildOpenAI codeSystemPrompt`, `OpenAI codeSystemPrompt` ([#510](https://github.com/badlogic/pi-mono/pull/510) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option in `StreamOptions` for providers that support session-based caching. OpenAI code provider provider uses this to set `prompt_cache_key` and routing headers.

## [0.37.2] - 2026-01-05

### Fixed

- OpenAI code provider now always includes `reasoning.encrypted_content` even when custom `include` options are passed ([#484](https://github.com/badlogic/pi-mono/pull/484) by [@kim0](https://github.com/kim0))

## [0.37.0] - 2026-01-05

### Breaking Changes

- OpenAI code provider models no longer have per-thinking-level variants (e.g., `gpt-5.2-openai-code-high`). Use the base model ID and set thinking level separately. The OpenAI code provider clamps reasoning effort to what each model supports internally. (initial implementation by [@ben-vargas](https://github.com/ben-vargas) in [#472](https://github.com/badlogic/pi-mono/pull/472))

### Added

- Headless OAuth support for all callback-server providers (Google Gemini CLI, Antigravity, OpenAI code provider): paste redirect URL when browser callback is unreachable ([#428](https://github.com/badlogic/pi-mono/pull/428) by [@ben-vargas](https://github.com/ben-vargas), [#468](https://github.com/badlogic/pi-mono/pull/468) by [@crcatala](https://github.com/crcatala))
- Cancellable GitHub Copilot device code polling via AbortSignal

### Fixed

- OpenAI code requests now omit the `reasoning` field entirely when thinking is off, letting the backend use its default instead of forcing a value. ([#472](https://github.com/badlogic/pi-mono/pull/472))

## [0.36.0] - 2026-01-05

### Added

- OpenAI code provider OAuth provider with Responses API streaming support: `openai-code-responses` streaming provider with SSE parsing, tool-call handling, usage/cost tracking, and PKCE OAuth flow ([#451](https://github.com/badlogic/pi-mono/pull/451) by [@kim0](https://github.com/kim0))

### Fixed

- Vertex AI dummy value for `getEnvApiKey()`: Returns `"<authenticated>"` when Application Default Credentials are configured (`~/.config/gcloud/application_default_credentials.json` exists) and both `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION` are set. This allows `streamSimple()` to work with Vertex AI without explicit `apiKey` option. The ADC credentials file existence check is cached per-process to avoid repeated filesystem access.

## [0.32.3] - 2026-01-03

### Fixed

- Google Vertex AI models no longer appear in available models list without explicit authentication. Previously, `getEnvApiKey()` returned a dummy value for `google-vertex`, causing models to show up even when Google Cloud ADC was not configured.

## [0.32.0] - 2026-01-03

### Added

- Vertex AI provider with ADC (Application Default Credentials) support. Authenticate with `gcloud auth application-default login`, set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and access Gemini models via Vertex AI. ([#300](https://github.com/badlogic/pi-mono/pull/300) by [@default-anton](https://github.com/default-anton))

### Fixed

- **Gemini CLI rate limit handling**: Added automatic retry with server-provided delay for 429 errors. Parses delay from error messages like "Your quota will reset after 39s" and waits accordingly. Falls back to exponential backoff for other transient errors. ([#370](https://github.com/badlogic/pi-mono/issues/370))

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent API moved**: All agent functionality (`agentLoop`, `agentLoopContinue`, `AgentContext`, `AgentEvent`, `AgentTool`, `AgentToolResult`, etc.) has moved to `@mariozechner/pi-agent-core`. Import from that package instead of `@gajae-code/ai`.

### Added

- **`GoogleThinkingLevel` type**: Exported type that mirrors Google's `ThinkingLevel` enum values (`"THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`). Allows configuring Gemini thinking levels without importing from `@google/genai`.
- **`ANTHROPIC_OAUTH_TOKEN` env var**: Now checked before `ANTHROPIC_API_KEY` in `getEnvApiKey()`, allowing OAuth tokens to take precedence.
- **`event-stream.js` export**: `AssistantMessageEventStream` utility now exported from package index.

### Changed

- **OAuth uses Web Crypto API**: PKCE generation and OAuth flows now use Web Crypto API (`crypto.subtle`) instead of Node.js `crypto` module. This improves browser compatibility while still working in Node.js 20+.
- **Deterministic model generation**: `generate-models.ts` now sorts providers and models alphabetically for consistent output across runs. ([#332](https://github.com/badlogic/pi-mono/pull/332) by [@mrexodia](https://github.com/mrexodia))

### Fixed

- **OpenAI completions empty content blocks**: Empty text or thinking blocks in assistant messages are now filtered out before sending to the OpenAI completions API, preventing validation errors. ([#344](https://github.com/badlogic/pi-mono/pull/344) by [@default-anton](https://github.com/default-anton))
- **Thinking token duplication**: Fixed thinking content duplication with chutes.ai provider. The provider was returning thinking content in both `reasoning_content` and `reasoning` fields, causing each chunk to be processed twice. Now only the first non-empty reasoning field is used.
- **zAi provider API mapping**: Fixed zAi models to use `openai-completions` API with correct base URL (`https://api.z.ai/api/coding/paas/v4`) instead of incorrect Anthropic API mapping. ([#344](https://github.com/badlogic/pi-mono/pull/344), [#358](https://github.com/badlogic/pi-mono/pull/358) by [@default-anton](https://github.com/default-anton))

## [0.28.0] - 2025-12-25

### Breaking Changes

- **OAuth storage removed** ([#296](https://github.com/badlogic/pi-mono/issues/296)): All storage functions (`loadOAuthCredentials`, `saveOAuthCredentials`, `setOAuthStorage`, etc.) removed. Callers are responsible for storing credentials.
- **OAuth login functions**: `loginAnthropic`, `loginGitHubCopilot`, `loginGeminiCli`, `loginAntigravity` now return `OAuthCredentials` instead of saving to disk.
- **refreshOAuthToken**: Now takes `(provider, credentials)` and returns new `OAuthCredentials` instead of saving.
- **getOAuthApiKey**: Now takes `(provider, credentials)` and returns `{ newCredentials, apiKey }` or null.
- **OAuthCredentials type**: No longer includes `type: "oauth"` discriminator. Callers add discriminator when storing.
- **setApiKey, resolveApiKey**: Removed. Callers must manage their own API key storage/resolution.
- **getApiKey**: Renamed to `getEnvApiKey`. Only checks environment variables for known providers.

## [0.27.7] - 2025-12-24

### Fixed

- **Thinking tag leakage**: Fixed Anthropic model mimicking literal `</thinking>` tags in responses. Unsigned thinking blocks (from aborted streams) are now converted to plain text without `<thinking>` tags. The TUI still displays them as thinking blocks. ([#302](https://github.com/badlogic/pi-mono/pull/302) by [@nicobailon](https://github.com/nicobailon))

## [0.25.1] - 2025-12-21

### Added

- **xhigh thinking level support**: Added `supportsXhigh()` function to check if a model supports xhigh reasoning level. Also clamps xhigh to high for OpenAI models that don't support it. ([#236](https://github.com/badlogic/pi-mono/pull/236) by [@theBucky](https://github.com/theBucky))

### Fixed

- **Gemini multimodal tool results**: Fixed images in tool results causing flaky/broken responses with Gemini models. For Gemini 3, images are now nested inside `functionResponse.parts` per the [docs](https://ai.google.dev/gemini-api/docs/function-calling#multimodal). For older models (which don't support multimodal function responses), images are sent in a separate user message.

- **Queued message steering**: When `getQueuedMessages` is provided, the agent loop now checks for queued user messages after each tool call and skips remaining tool calls in the current assistant message when a queued message arrives (emitting error tool results).

- **Double API version path in Google provider URL**: Fixed Gemini API calls returning 404 after baseUrl support was added. The SDK was appending its default apiVersion to baseUrl which already included the version path. ([#251](https://github.com/badlogic/pi-mono/pull/251) by [@shellfyred](https://github.com/shellfyred))

- **Anthropic SDK retries disabled**: Re-enabled SDK-level retries (default 2) for transient HTTP failures. ([#252](https://github.com/badlogic/pi-mono/issues/252))

## [0.23.5] - 2025-12-19

### Added

- **Gemini 3 Flash thinking support**: Extended thinking level support for Gemini 3 Flash models (MINIMAL, LOW, MEDIUM, HIGH) to match Pro models' capabilities. ([#212](https://github.com/badlogic/pi-mono/pull/212) by [@markusylisiurunen](https://github.com/markusylisiurunen))

- **GitHub Copilot thinking models**: Added thinking support for additional Copilot models (o3-mini, o1-mini, o1-preview). ([#234](https://github.com/badlogic/pi-mono/pull/234) by [@aadishv](https://github.com/aadishv))

### Fixed

- **Gemini tool result format**: Fixed tool result format for Gemini 3 Flash Preview which strictly requires `{ output: value }` for success and `{ error: value }` for errors. Previous format using `{ result, isError }` was rejected by newer Gemini models. Also improved type safety by removing `as any` casts. ([#213](https://github.com/badlogic/pi-mono/issues/213), [#220](https://github.com/badlogic/pi-mono/pull/220))

- **Google baseUrl configuration**: Google provider now respects `baseUrl` configuration for custom endpoints or API proxies. ([#216](https://github.com/badlogic/pi-mono/issues/216), [#221](https://github.com/badlogic/pi-mono/pull/221) by [@theBucky](https://github.com/theBucky))

- **GitHub Copilot vision requests**: Added `Copilot-Vision-Request` header when sending images to GitHub Copilot models. ([#222](https://github.com/badlogic/pi-mono/issues/222))

- **GitHub Copilot X-Initiator header**: Fixed X-Initiator logic to check last message role instead of any message in history. This ensures proper billing when users send follow-up messages. ([#209](https://github.com/badlogic/pi-mono/issues/209))

## [0.22.3] - 2025-12-16

### Added

- **Image limits test suite**: Added comprehensive tests for provider-specific image limitations (max images, max size, max dimensions). Discovered actual limits: Anthropic (100 images, 5MB, 8000px), OpenAI (500 images, ≥25MB), Gemini (~2500 images, ≥40MB), Mistral (8 images, ~15MB), OpenRouter (~40 images context-limited, ~15MB). ([#120](https://github.com/badlogic/pi-mono/pull/120))

- **Tool result streaming**: Added `tool_execution_update` event and optional `onUpdate` callback to `AgentTool.execute()` for streaming tool output during execution. Tools can now emit partial results (e.g., bash stdout) that are forwarded to subscribers. ([#44](https://github.com/badlogic/pi-mono/issues/44))

- **X-Initiator header for GitHub Copilot**: Added X-Initiator header handling for GitHub Copilot provider to ensure correct call accounting (agent calls are not deducted from quota). Sets initiator based on last message role. ([#200](https://github.com/badlogic/pi-mono/pull/200) by [@kim0](https://github.com/kim0))

### Changed

- **Normalized tool_execution_end result**: `tool_execution_end` event now always contains `AgentToolResult` (no longer `AgentToolResult | string`). Errors are wrapped in the standard result format.

### Fixed

- **Reasoning disabled by default**: When `reasoning` option is not specified, thinking is now explicitly disabled for all providers. Previously, some providers like Gemini with "dynamic thinking" would use their default (thinking ON), causing unexpected token usage. This was the original intended behavior. ([#180](https://github.com/badlogic/pi-mono/pull/180) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.22.2] - 2025-12-15

### Added

- **Interleaved thinking for Anthropic**: Added `interleavedThinking` option to `AnthropicOptions`. When enabled, Anthropic model 4 models can think between tool calls and reason after receiving tool results. Enabled by default (no extra token cost, just unlocks the capability). Set `interleavedThinking: false` to disable.

## [0.22.1] - 2025-12-15

_Dedicated to Peter's shoulder ([@steipete](https://twitter.com/steipete))_

### Added

- **Interleaved thinking for Anthropic**: Enabled interleaved thinking in the Anthropic provider, allowing Anthropic model models to output thinking blocks interspersed with text responses.

## [0.22.0] - 2025-12-15

### Added

- **GitHub Copilot provider**: Added `github-copilot` as a known provider with models sourced from models.dev. Includes Anthropic model, GPT, Gemini, Grok, and other models available through GitHub Copilot. ([#191](https://github.com/badlogic/pi-mono/pull/191) by [@cau1k](https://github.com/cau1k))

### Fixed

- **GitHub Copilot gpt-5 models**: Fixed API selection for gpt-5 models to use `openai-responses` instead of `openai-completions` (gpt-5 models are not accessible via completions endpoint)

- **GitHub Copilot cross-model context handoff**: Fixed context handoff failing when switching between GitHub Copilot models using different APIs (e.g., gpt-5 to anthropic-model-sonnet-4). Tool call IDs from OpenAI Responses API were incompatible with other models. ([#198](https://github.com/badlogic/pi-mono/issues/198))

- **Gemini 3 Pro thinking levels**: Thinking level configuration now works correctly for Gemini 3 Pro models. Previously all levels mapped to -1 (minimal thinking). Now LOW/MEDIUM/HIGH properly control test-time computation. ([#176](https://github.com/badlogic/pi-mono/pull/176) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.18.2] - 2025-12-11

### Changed

- **Anthropic SDK retries disabled**: Set `maxRetries: 0` on Anthropic client to allow application-level retry handling. The SDK's built-in retries were interfering with coding-agent's retry logic. ([#157](https://github.com/badlogic/pi-mono/issues/157))

## [0.18.1] - 2025-12-10

### Added

- **Mistral provider**: Added support for Mistral AI models via the OpenAI-compatible API. Includes automatic handling of Mistral-specific requirements (tool call ID format). Set `MISTRAL_API_KEY` environment variable to use.

### Fixed

- Fixed Mistral 400 errors after aborted assistant messages by skipping empty assistant messages (no content, no tool calls) ([#165](https://github.com/badlogic/pi-mono/issues/165))

- Removed synthetic assistant bridge message after tool results for Mistral (no longer required as of Dec 2025) ([#165](https://github.com/badlogic/pi-mono/issues/165))

- Fixed bug where `ANTHROPIC_API_KEY` environment variable was deleted globally after first OAuth token usage, causing subsequent prompts to fail ([#164](https://github.com/badlogic/pi-mono/pull/164))

## [0.17.0] - 2025-12-09

### Added

- **`agentLoopContinue` function**: Continue an agent loop from existing context without adding a new user message. Validates that the last message is `user` or `toolResult`. Useful for retry after context overflow or resuming from manually-added tool results.

### Breaking Changes

- Removed provider-level tool argument validation. Validation now happens in `agentLoop` via `executeToolCalls`, allowing models to retry on validation errors. For manual tool execution, use `validateToolCall(tools, toolCall)` or `validateToolArguments(tool, toolCall)`.

### Added

- Added `validateToolCall(tools, toolCall)` helper that finds the tool by name and validates arguments.

- **OpenAI compatibility overrides**: Added `compat` field to `Model` for `openai-completions` API, allowing explicit configuration of provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`). Falls back to URL-based detection if not set. Useful for LiteLLM, custom proxies, and other non-standard endpoints. ([#133](https://github.com/badlogic/pi-mono/issues/133), thanks @fink-andreas for the initial idea and PR)

- **xhigh reasoning level**: Added `xhigh` to `ReasoningEffort` type for OpenAI openai-code-max models. For non-OpenAI providers (Anthropic, Google), `xhigh` is automatically mapped to `high`. ([#143](https://github.com/badlogic/pi-mono/issues/143))

### Changed

- **Updated SDK versions**: OpenAI SDK 5.21.0 → 6.10.0, Anthropic SDK 0.61.0 → 0.71.2, Google GenAI SDK 1.30.0 → 1.31.0

## [0.13.0] - 2025-12-06

### Breaking Changes

- **Added `totalTokens` field to `Usage` type**: All code that constructs `Usage` objects must now include the `totalTokens` field. This field represents the total tokens processed by the LLM (input + output + cache). For OpenAI and Google, this uses native API values (`total_tokens`, `totalTokenCount`). For Anthropic, it's computed as `input + output + cacheRead + cacheWrite`.

## [0.12.10] - 2025-12-04

### Added

- Added `gpt-5.1-openai-code-max` model support

### Fixed

- **OpenAI Token Counting**: Fixed `usage.input` to exclude cached tokens for OpenAI providers. Previously, `input` included cached tokens, causing double-counting when calculating total context size via `input + cacheRead`. Now `input` represents non-cached input tokens across all providers, making `input + output + cacheRead + cacheWrite` the correct formula for total context size.

- **Fixed Anthropic model Opus 4.5 cache pricing** (was 3x too expensive)
  - Corrected cache_read: $1.50 → $0.50 per MTok
  - Corrected cache_write: $18.75 → $6.25 per MTok
  - Added manual override in `scripts/generate-models.ts` until upstream fix is merged
  - Submitted PR to models.dev: https://github.com/sst/models.dev/pull/439

## [0.9.4] - 2025-11-26

Initial release with multi-provider LLM support.
