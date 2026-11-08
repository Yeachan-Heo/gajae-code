import instruction from "../prompts/system/btw-user.md" with { type: "text" };

export type { BtwConversationScope, BtwTurnCapture } from "../session/agent-session";
export * from "../session/btw-contract";
/** Shared instruction for text-only side conversations, never a main-turn prompt. */
export { instruction };
