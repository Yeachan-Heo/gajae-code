import { boundedDedupe, type ConversationRecord } from "./conversation-store";

export interface SlackInboundDispatchReceipt {
	key: string;
	eventId: string;
	interactionId: string;
	retryKey: string;
	eventContext?: string;
	kind: "action" | "command";
	actionId?: string;
	/** The endpoint generation and SDK effect captured before Socket Mode ACK. */
	endpointGeneration: number;
	/** Identifier of the protected journal payload; mappings never retain message bodies. */
	effectId: string;
	idempotencyKey: string;
}

export type SlackConversationState = "absent" | "posting_root" | "active" | "closed_marker" | "resumed_root" | "error";

/** Durable Slack mapping. It contains identifiers and receipt metadata only; protected journal effects own message bodies. */
export interface SlackConversation extends ConversationRecord {
	state: SlackConversationState;
	teamId: string;
	channelId: string;
	rootTs?: string;
	sessionId?: string;
	endpointGeneration?: number;
	clientMsgId?: string;
	/** Exclusive, expiring authority for provider reconciliation/publication of the root intent. */
	rootPublicationOwner?: string;
	rootPublicationLeaseExpiresAt?: number;
	/** Monotonic fencing token; stale root publishers may not commit after takeover. */
	rootPublicationFence?: number;

	/** Exclusive, expiring authority for provider reconciliation/publication of the outbound action intent. */
	outboundActionOwner?: string;
	outboundActionLeaseExpiresAt?: number;
	/** Monotonic fencing token; stale action publishers may not commit after takeover. */
	outboundActionFence?: number;
	/** Action authority only; action bodies and endpoint credentials are never persisted. */
	pendingActionId?: string;
	/** Durable, unpublished action intent. The action body is supplied only by the caller. */
	outboundActionId?: string;
	outboundActionClientMsgId?: string;
	lastError?: string;
	updatedAt: number;
	seenEventIds: string[];
	seenContextIds: string[];
	seenRetryKeys: string[];
	seenInteractionIds: string[];
	/** Durable inbound effect identifiers. The protected journal owns replay payloads. */
	inboundDispatches?: SlackInboundDispatchReceipt[];
}

export function slackConversationKey(input: { teamId: string; channelId: string; rootTs: string }): string {
	return `${input.teamId}:${input.channelId}:${input.rootTs}`;
}

export function normalizeSlackConversation(record: SlackConversation): SlackConversation {
	const inboundDispatches = record.inboundDispatches ?? [];
	return {
		...record,
		seenEventIds: boundedDedupe(record.seenEventIds),
		seenContextIds: boundedDedupe(record.seenContextIds),
		seenRetryKeys: boundedDedupe(record.seenRetryKeys),
		seenInteractionIds: boundedDedupe(record.seenInteractionIds),
		// Replay lifecycle and terminal retention are journal-owned; mappings retain identifiers.
		inboundDispatches,
	};
}

export function acceptsSlackInbound(record: SlackConversation, rootTs: string, endpointGeneration: number): boolean {
	return record.state === "active" && record.rootTs === rootTs && record.endpointGeneration === endpointGeneration;
}
