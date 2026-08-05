# 17 — web-search resolveProviderChain provider-id mapping can bypass the local OpenAI-compatible safety gate

- **Severity:** Medium (privacy/safety: hosted search appended for a local model context)
- **Scope:** `packages/coding-agent/src/web/search/provider.ts:115,224-231,281-284` (`MODEL_PROVIDER_TO_SEARCH` applied before guarded inference)
- **Surface:** native web-search provider selection (PR #591 / commit 638d2f11)
- **Found by:** post-0.5.1 dogfood (G003), architect `2-ArchG003-SetupModelTheme`

## Summary

`inferNativeProviderFromModel` is deliberately conservative: for an
OpenAI-compatible wire it only returns `codex` when `webSearch === "on"` **or**
the baseUrl is not local (`!isLocalBaseUrl`). The dogfood confirmed this pure
function (local model → `undefined`).

However `resolveProviderChain` also applies a direct `MODEL_PROVIDER_TO_SEARCH`
provider-id mapping path *before/around* the guarded inference. A context with
provider id `openai`, a local/private `baseUrl`, and Codex OAuth available can
still get `codex` appended to the chain via the id mapping — bypassing the
local-baseUrl auto guard the inference path enforces.

## Impact

A user on a local/private OpenAI-compatible endpoint (who reasonably expects no
queries leave their machine) can have web-search queries routed to the hosted
Codex/OpenAI search provider when Codex credentials happen to be present. This
is a privacy/data-egress surprise, not a crash.

## Suggested fix

Make the provider-id mapping path honor the same local-baseUrl / `webSearch`
auto gate as `inferNativeProviderFromModel`, or route all native selection
through the guarded inference. Add a test: provider `openai` + local baseUrl +
Codex OAuth + `webSearch:"auto"` → no hosted provider in the chain.

## Resolution

**Resolved on current `dev`.** The direct provider mapping now passes through `canUseDirectProviderMapping()`, which applies the local-baseUrl and `webSearch` guard before appending Codex.
