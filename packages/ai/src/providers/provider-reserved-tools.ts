import type { KnownProvider, Provider, Tool } from "../types";

/**
 * Tool names a provider's endpoint reserves for its own built-in tools.
 *
 * A collision is a *request-level* rejection, not a per-tool one: the endpoint
 * refuses the whole turn before any work starts (OpenCode Console Go answers
 * `400 invalid request: invalid tools in request: custom function name
 * "web_search" is reserved`), so every tool in the request dies with it.
 *
 * A reservation belongs to the endpoint, not to the wire API: OpenCode Go
 * fronts `openai-completions`, `openai-responses`, and `anthropic-messages`
 * behind one gateway that validates tool names the same way on all three. So
 * the list is keyed by provider and consulted by every api that provider is
 * routed to.
 *
 * Each entry is owned by the provider that declares it. There is no shared
 * default: a provider absent from this map reserves nothing, and keeps every
 * declared tool exactly as the caller offered it.
 */
const PROVIDER_RESERVED_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
	// https://opencode.ai/zen/go — serves `web_search` itself.
	"opencode-go": ["web_search"],
} satisfies Partial<Record<KnownProvider, readonly string[]>>;

/** @internal Exported for tests. */
export function getProviderReservedToolNames(provider: Provider): readonly string[] {
	return PROVIDER_RESERVED_TOOL_NAMES[provider] ?? [];
}

/**
 * Drop the declarations `provider` reserves, keeping every other tool in its
 * original order. Returns the caller's array untouched when the provider
 * reserves nothing or declares none of the reserved names.
 *
 * Matches the name that actually reaches the wire: custom-format tools are
 * emitted under `customWireName` when present, so both are checked.
 */
export function filterProviderReservedTools(tools: Tool[], provider: Provider): Tool[] {
	const reserved = PROVIDER_RESERVED_TOOL_NAMES[provider];
	if (!reserved || reserved.length === 0) return tools;
	const kept = tools.filter(tool => !reserved.includes(tool.customWireName ?? tool.name));
	return kept.length === tools.length ? tools : kept;
}
