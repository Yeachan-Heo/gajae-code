export interface SlackSocketEnvelope {
	envelope_id: string;
	payload: unknown;
}

export interface SlackPostedMessage {
	channel: string;
	ts: string;
	client_msg_id?: string;
}

export interface SlackMessageSearchResult {
	channel: string;
	ts: string;
	client_msg_id?: string;
}

export interface SlackConfigurationProbeResult {
	ok: boolean;
	detail: string;
	teamId?: string;
	userId?: string;
}

export interface SlackOneShotTestResult {
	ok: boolean;
	detail: string;
	channel?: string;
	timestamp?: string;
	uncertain?: boolean;
}

export interface SlackDiagnosticProvider {
	probeConfiguration(signal?: AbortSignal): Promise<SlackConfigurationProbeResult>;
	sendOneShotTest(input: {
		channel: string;
		message: string;
		idempotencyKey: string;
		signal?: AbortSignal;
	}): Promise<SlackOneShotTestResult>;
}
/** Minimal Socket Mode + Web API seam. Implementations may wrap the official Slack SDK. */
export interface SlackProviderClient {
	start(onEnvelope: (envelope: SlackSocketEnvelope) => void | Promise<void>): Promise<void>;
	stop?(): Promise<void>;
	ack(envelopeId: string): Promise<void>;
	postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
		signal?: AbortSignal;
	}): Promise<SlackPostedMessage>;
	findMessageByClientMsgId?(input: {
		channel: string;
		clientMsgId: string;
		threadTs?: string;
		signal?: AbortSignal;
	}): Promise<SlackMessageSearchResult | null>;
	addReaction?(input: { channel: string; timestamp: string; name: string; signal?: AbortSignal }): Promise<void>;
	/**
	 * Prove that an operator-supplied timestamp addresses a real message in the
	 * requested channel. Adoption of an existing root is refused when a client
	 * cannot answer this, so verification is never silently skipped.
	 */
	findMessageByTimestamp?(input: { channel: string; ts: string }): Promise<SlackMessageSearchResult | null>;
	readonly transportHealthy?: boolean;
}

/**
 * Transport wrapper deliberately limited to Slack SDK operations. Keeping it injectable
 * makes Socket Mode acknowledgement and Web API failure cases deterministic in tests.
 */
export class SlackProvider {
	constructor(private readonly client: SlackProviderClient) {}

	async start(onEnvelope: (envelope: SlackSocketEnvelope) => void | Promise<void>): Promise<void> {
		await this.client.start(onEnvelope);
	}

	get transportHealthy(): boolean {
		return this.client.transportHealthy ?? true;
	}

	async stop(): Promise<void> {
		await this.client.stop?.();
	}

	async ack(envelopeId: string): Promise<void> {
		await this.client.ack(envelopeId);
	}

	async postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
		signal?: AbortSignal;
	}): Promise<SlackPostedMessage> {
		return await this.client.postMessage(input);
	}

	async findMessageByClientMsgId(input: {
		channel: string;
		clientMsgId: string;
		threadTs?: string;
		signal?: AbortSignal;
	}): Promise<SlackMessageSearchResult | null> {
		return (await this.client.findMessageByClientMsgId?.(input)) ?? null;
	}

	async addReaction(input: { channel: string; timestamp: string; name: string; signal?: AbortSignal }): Promise<void> {
		await this.client.addReaction?.(input);
	}

	/** Fail-closed root verification: a client without this capability can never confirm a root. */
	async findMessageByTimestamp(input: { channel: string; ts: string }): Promise<SlackMessageSearchResult | null> {
		return (await this.client.findMessageByTimestamp?.(input)) ?? null;
	}
}
