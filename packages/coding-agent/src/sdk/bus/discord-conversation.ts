import { boundedDedupe, type ConversationRecord } from "./conversation-store";

/** Identifier-only reference to an inbound effect whose payload and lifecycle live in ChatEffectJournal. */
export interface DiscordInboundDispatchReceipt {
	key: string;
	eventId: string;
	interactionId?: string;
	kind: "action" | "command";
	actionId?: string;
	actionNonce?: string;
	endpointGeneration: number;
	effectId: string;
	idempotencyKey: string;
}

export type DiscordConversationState = "absent" | "creating" | "active" | "archived" | "resuming" | "closed" | "error";

/** Durable Discord mapping. It deliberately contains identifiers only: never endpoint tokens or message bodies. */
export interface DiscordConversation extends ConversationRecord {
	state: DiscordConversationState;
	appId: string;
	guildId: string;
	parentChannelId: string;
	threadId?: string;
	sessionId?: string;
	createNonce?: string;
	/** A lease makes thread creation exclusive across daemon processes. */
	createOwner?: string;
	createLeaseExpiresAt?: number;
	endpointGeneration?: number;
	/** Immutable lineage for archive and resume provider effects. */
	effectIncarnationId?: string;
	/** Current archive operation authority. */
	archiveOccurrenceId?: string;
	archiveEffectId?: string;
	/** Current resume operation authority. */
	resumeOccurrenceId?: string;
	resumeEffectId?: string;
	/** Action authority only; action bodies and endpoint credentials are never persisted. */
	pendingActionId?: string;
	/** Immutable per-publication action authority, bound to component routes and inbound effects. */
	pendingActionNonce?: string;
	/** Durable journal identity for the immutable outbound action publication intent. */
	pendingActionEffectId?: string;
	/** Replayable durable receipts for acknowledged inbound effects. */
	inboundDispatches?: DiscordInboundDispatchReceipt[];
	updatedAt: number;
	archivedAt?: number;
	closedAt?: number;
	supersededByThreadId?: string;
	seenEventIds: string[];
	seenInteractionIds: string[];
}

export function discordConversationKey(input: {
	appId: string;
	guildId: string;
	parentChannelId: string;
	threadId: string;
}): string {
	return `${input.appId}:${input.guildId}:${input.parentChannelId}:${input.threadId}`;
}

export function normalizeDiscordConversation(record: DiscordConversation): DiscordConversation {
	const dispatches = record.inboundDispatches ?? [];
	return {
		...record,
		seenEventIds: boundedDedupe(record.seenEventIds),
		seenInteractionIds: boundedDedupe(record.seenInteractionIds),
		...(dispatches.length === 0 ? {} : { inboundDispatches: dispatches }),
	};
}

export function acceptsDiscordInbound(
	record: DiscordConversation,
	threadId: string,
	endpointGeneration: number,
): boolean {
	return (
		record.state === "active" &&
		record.threadId === threadId &&
		record.supersededByThreadId === undefined &&
		record.endpointGeneration === endpointGeneration
	);
}
