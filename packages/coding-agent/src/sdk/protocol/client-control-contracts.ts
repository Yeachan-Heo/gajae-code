export const SIDE_CONVERSATION_MUTATIONS = ["btw.open", "btw.submit", "btw.cancel", "btw.close"] as const;
export const SIDE_CONVERSATION_QUERIES = ["btw.read"] as const;
export type SideConversationOperation = (typeof SIDE_CONVERSATION_MUTATIONS)[number] | "btw.read";
export function isSideConversationOperation(value: string): value is SideConversationOperation {
	return [...SIDE_CONVERSATION_MUTATIONS, ...SIDE_CONVERSATION_QUERIES].some(operation => operation === value);
}

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */
