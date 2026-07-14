export interface SessionStateSnapshot {
	isStreaming: boolean;
	steeringQueueDepth: number;
	followupQueueDepth: number;
}

export interface HarnessSessionTransportCloseContext {
	/**
	 * One-shot object capability for the transport's exact direct close implementation.
	 * It may be consumed only synchronously, before close() returns its promise.
	 */
	completeDirectOwnerStopReentry(): Promise<void>;
}

/** SDK-backed transport contract for a live harness session. */
export interface HarnessSessionTransport {
	getState(): Promise<SessionStateSnapshot>;
	sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }>;
	eventCursor(): number;
	waitForAgentStart(afterCursor: number, timeoutMs: number): Promise<{ cursor: number } | null>;
	/**
	 * Await every transport-owned cleanup step. A transport that must break a direct
	 * close/owner-stop cycle consumes the invocation-scoped context capability rather
	 * than calling public RuntimeOwner.stop(), whose result always represents full cleanup.
	 */
	close(context?: HarnessSessionTransportCloseContext): Promise<void>;
	/** Return a synchronous disposer that fully severs this event subscription. */
	onEventFrame?(listener: (frame: Record<string, unknown>) => void): () => void;
	isLive?(): boolean;
	lastFrameAt?(): string | null;
	getLastAssistantText?(): Promise<string | null>;
}

export interface AcceptanceResult {
	accepted: boolean;
	reason: string;
	commandId: string | null;
	preSubmitCursor: number;
	agentStartCursor: number | null;
	preSubmitState: SessionStateSnapshot;
}

export async function singleFlightAccept(
	transport: HarnessSessionTransport,
	prompt: string,
	timeoutMs: number,
): Promise<AcceptanceResult> {
	const pre = await transport.getState();
	const preSubmitCursor = transport.eventCursor();
	if (pre.isStreaming || pre.steeringQueueDepth > 0 || pre.followupQueueDepth > 0) {
		return {
			accepted: false,
			reason: "pre-state-not-idle",
			commandId: null,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	const { commandId, ack } = await transport.sendPrompt(prompt);
	if (!ack) {
		return {
			accepted: false,
			reason: "no-ack",
			commandId,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	const started = await transport.waitForAgentStart(preSubmitCursor, timeoutMs);
	if (!started) {
		return {
			accepted: false,
			reason: "no-agent-start-within-timeout",
			commandId,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	return {
		accepted: true,
		reason: "protocol-ack-single-flight",
		commandId,
		preSubmitCursor,
		agentStartCursor: started.cursor,
		preSubmitState: pre,
	};
}
