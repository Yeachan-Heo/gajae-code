/**
 * Provider-resolved tool-call markers.
 *
 * A provider that executes a tool call itself (Cursor exec-owned calls, or an
 * agent-level ACP provider such as Devin, whose agent runs its own tools) marks
 * the emitted `toolCall` block with this symbol. The agent loop then treats the
 * call as display-only and never dispatches it to a GJC tool. Symbols are used
 * instead of a wire field so the marker exists only in-process and can never
 * round-trip through a transcript or a provider payload.
 */
export const kProviderResolvedToolCall = Symbol("provider.block.providerResolvedToolCall");

export type ProviderResolvedCarrier = object & { [kProviderResolvedToolCall]?: true };

export function isProviderResolvedToolCall(block: ProviderResolvedCarrier | null | undefined): boolean {
	return block?.[kProviderResolvedToolCall] === true;
}

export function copyProviderResolvedToolCall(target: ProviderResolvedCarrier, source: ProviderResolvedCarrier): void {
	if (source[kProviderResolvedToolCall] === true) target[kProviderResolvedToolCall] = true;
}
