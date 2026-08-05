/**
 * Core-safe Codex tool-name mapping.
 *
 * The mapping is shared by prompt metadata and the Codex transport, but it has
 * no provider SDK or network dependencies. Keeping it here lets startup code
 * use the canonical wire names without importing the Codex implementation.
 */
const CODEX_RESERVED_TOOL_WIRE_NAMES: ReadonlyMap<string, string> = new Map([
	["browser", "browser_tool"],
	["computer", "computer_tool"],
]);
const CODEX_CANONICAL_TOOL_NAMES: ReadonlyMap<string, string> = new Map(
	Array.from(CODEX_RESERVED_TOOL_WIRE_NAMES, ([canonical, wire]) => [wire, canonical]),
);

/** Maps a canonical tool name to the name Codex accepts on the wire. */
export function codexToolWireName(name: string): string {
	return CODEX_RESERVED_TOOL_WIRE_NAMES.get(name) ?? name;
}

/** Maps a Codex wire tool name back to the canonical harness tool name. */
export function codexToolCanonicalName(wireName: string): string {
	return CODEX_CANONICAL_TOOL_NAMES.get(wireName) ?? wireName;
}
