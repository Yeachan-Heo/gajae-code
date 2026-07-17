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
	}): Promise<SlackPostedMessage>;
	findMessageByClientMsgId?(input: {
		channel: string;
		clientMsgId: string;
		threadTs?: string;
	}): Promise<SlackMessageSearchResult | null>;
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
	}): Promise<SlackPostedMessage> {
		return await this.client.postMessage(input);
	}

	async findMessageByClientMsgId(input: {
		channel: string;
		clientMsgId: string;
		threadTs?: string;
	}): Promise<SlackMessageSearchResult | null> {
		return (await this.client.findMessageByClientMsgId?.(input)) ?? null;
	}
}
