import type {
	SlackConfigurationProbeResult,
	SlackDiagnosticProvider,
	SlackMessageSearchResult,
	SlackOneShotTestResult,
	SlackPostedMessage,
	SlackProviderClient,
	SlackSocketEnvelope,
} from "./slack-provider";

const SLACK_API = "https://slack.com/api";
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 1;

export type SlackProviderErrorCode = "connection" | "protocol" | "web_api" | "rate_limited";

/** A Slack transport failure whose fields are safe to surface without credentials. */
export class SlackProviderError extends Error {
	readonly retryable: boolean;

	constructor(
		readonly code: SlackProviderErrorCode,
		readonly operation: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
		/** The server may have accepted the request before its response became unusable. */
		readonly mayHaveBeenAccepted = false,
	) {
		super(`${operation} failed (${code})`);
		this.name = "SlackProviderError";
		this.retryable = code === "connection" || code === "rate_limited";
	}
}

export interface SlackWebSocket {
	readonly readyState: number;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	send(data: string): void;
	close(): void;
}

export interface SlackLiveProviderOptions {
	appToken: string;
	botToken: string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	webSocket?: (url: string) => SlackWebSocket;
	now?: () => number;
	sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	reconnectDelayMs?: number;
	maxRateLimitRetries?: number;
	maxRetryAfterMs?: number;
	activityTimeoutMs?: number;
}

type SlackApiMessage = {
	channel?: unknown;
	ts?: unknown;
	client_msg_id?: unknown;
};

type SlackApiResponse = {
	ok?: unknown;
	url?: unknown;
	channel?: unknown;
	ts?: unknown;
	client_msg_id?: unknown;
	message?: unknown;
	messages?: unknown;
	retry_after?: unknown;
	team_id?: unknown;
	user_id?: unknown;
};

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messages(value: unknown): SlackApiMessage[] {
	return Array.isArray(value)
		? value.filter((item): item is SlackApiMessage => !!item && typeof item === "object")
		: [];
}

function retryAfterMilliseconds(response: Response, body: SlackApiResponse, maximum: number): number {
	const header = Number(response.headers.get("retry-after"));
	const bodyValue = typeof body.retry_after === "number" ? body.retry_after : Number(body.retry_after);
	const seconds = Number.isFinite(header) && header >= 0 ? header : bodyValue;
	return Math.min(Math.max(0, Number.isFinite(seconds) ? seconds * 1_000 : 1_000), maximum);
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(milliseconds);
		return;
	}
	signal.throwIfAborted();
	const settled = Promise.withResolvers<void>();
	const timer = setTimeout(settled.resolve, milliseconds);
	const abort = (): void => {
		clearTimeout(timer);
		settled.reject(signal.reason);
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		await settled.promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

function socketFromGlobal(url: string): SlackWebSocket {
	return new WebSocket(url);
}

/**
 * Slack's Web API rejects JSON bodies for read methods such as conversations.replies
 * with `invalid_arguments`, so every call is encoded as a form body with undefined
 * parameters omitted rather than serialized.
 */
function formBody(body: Record<string, string | undefined>): string {
	const parameters = new URLSearchParams();
	for (const [key, value] of Object.entries(body)) if (value !== undefined) parameters.set(key, value);
	return parameters.toString();
}

/**
 * Production Socket Mode and Web API client. It keeps all connection state in
 * memory and deliberately never maintains a Slack cursor.
 */
export class SlackLiveProvider implements SlackProviderClient, SlackDiagnosticProvider {
	readonly #appToken: string;
	readonly #botToken: string;
	readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;
	readonly #webSocket: (url: string) => SlackWebSocket;
	readonly #now: () => number;
	readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	readonly #reconnectDelayMs: number;
	readonly #maxRateLimitRetries: number;
	readonly #maxRetryAfterMs: number;
	readonly #activityTimeoutMs: number;
	#socket: SlackWebSocket | undefined;
	readonly #envelopeSockets = new Map<string, SlackWebSocket>();
	#onEnvelope: ((envelope: SlackSocketEnvelope) => void | Promise<void>) | undefined;
	#lastActivityAt: number | undefined;
	#callbackHealthy = true;
	#deliverySequence = 0;
	#lastCallbackFailure = 0;
	#stopped = true;
	get transportHealthy(): boolean {
		const socket = this.#socket;
		if (this.#stopped || !socket || socket.readyState !== 1 || !this.#callbackHealthy) return false;
		if (this.#lastActivityAt === undefined || this.#now() - this.#lastActivityAt <= this.#activityTimeoutMs)
			return true;
		socket.close();
		return false;
	}
	#reconnectPending = false;
	#lifecycleGeneration = 0;

	constructor(options: SlackLiveProviderOptions) {
		this.#appToken = options.appToken;
		this.#botToken = options.botToken;
		this.#fetch = options.fetch ?? fetch;
		this.#webSocket = options.webSocket ?? socketFromGlobal;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? sleep;
		this.#reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
		this.#maxRateLimitRetries = Math.max(0, options.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES);
		this.#maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS);
		this.#activityTimeoutMs = Math.max(1, options.activityTimeoutMs ?? 60_000);
	}

	async probeConfiguration(signal?: AbortSignal): Promise<SlackConfigurationProbeResult> {
		if (signal?.aborted) return { ok: false, detail: "Slack configuration probe cancelled." };
		try {
			const bot = await this.#request("auth.test", this.#botToken, {}, false, signal);
			if (bot.ok !== true) return { ok: false, detail: "Slack bot token authorization failed." };
			const app = await this.#request("apps.connections.open", this.#appToken, {}, false, signal);
			if (app.ok !== true || !string(app.url)) {
				return { ok: false, detail: "Slack app token Socket Mode authorization failed." };
			}
			return {
				ok: true,
				detail: "Slack bot and app credentials are valid.",
				teamId: string(bot.team_id),
				userId: string(bot.user_id),
			};
		} catch (error) {
			if (signal?.aborted) return { ok: false, detail: "Slack configuration probe cancelled." };
			return { ok: false, detail: error instanceof Error ? error.message : "Slack configuration probe failed." };
		}
	}

	async sendOneShotTest(input: {
		channel: string;
		message: string;
		idempotencyKey: string;
		signal?: AbortSignal;
	}): Promise<SlackOneShotTestResult> {
		if (input.signal?.aborted) return { ok: false, detail: "Slack notification test cancelled." };
		try {
			const response = await this.#request(
				"chat.postMessage",
				this.#botToken,
				{ channel: input.channel, text: input.message, client_msg_id: input.idempotencyKey },
				true,
				input.signal,
			);
			if (response.ok !== true) throw new SlackProviderError("web_api", "chat.postMessage");
			const posted = this.#message(response);
			if (!posted) {
				return {
					ok: false,
					detail: "Slack may have accepted the message but returned no message receipt.",
					uncertain: true,
				};
			}
			return {
				ok: true,
				detail: "Slack notification test delivered.",
				channel: posted.channel,
				timestamp: posted.ts,
			};
		} catch (error) {
			if (input.signal?.aborted) return { ok: false, detail: "Slack notification test cancelled." };
			const uncertain = error instanceof SlackProviderError && error.mayHaveBeenAccepted;
			return {
				ok: false,
				detail: error instanceof Error ? error.message : "Slack notification test failed.",
				...(uncertain ? { uncertain: true } : {}),
			};
		}
	}

	async start(onEnvelope: (envelope: SlackSocketEnvelope) => void | Promise<void>): Promise<void> {
		this.#lifecycleGeneration++;
		this.#onEnvelope = onEnvelope;
		this.#stopped = false;
		this.#callbackHealthy = true;
		this.#lastActivityAt = undefined;
		this.#deliverySequence = 0;
		this.#lastCallbackFailure = 0;
		await this.#connect();
	}

	async stop(): Promise<void> {
		this.#lifecycleGeneration++;
		this.#stopped = true;
		this.#onEnvelope = undefined;
		this.#socket?.close();
		this.#envelopeSockets.clear();
		this.#socket = undefined;
		this.#lastActivityAt = undefined;
		this.#callbackHealthy = false;
		this.#lastCallbackFailure = 0;
	}

	async ack(envelopeId: string): Promise<void> {
		const socket = this.#envelopeSockets.get(envelopeId) ?? this.#socket;
		if (!envelopeId || !socket || socket.readyState !== 1) {
			throw new SlackProviderError("connection", "socket_ack");
		}
		socket.send(JSON.stringify({ envelope_id: envelopeId }));
		this.#envelopeSockets.delete(envelopeId);
	}

	async postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
		signal?: AbortSignal;
	}): Promise<SlackPostedMessage> {
		const response = await this.#api(
			"chat.postMessage",
			{
				channel: input.channel,
				text: input.text,
				thread_ts: input.threadTs,
				client_msg_id: input.clientMsgId,
			},
			input.signal,
		);
		const message = this.#message(response);
		// A successful HTTP response without a usable receipt can still represent a
		// remote acceptance. The daemon must reconcile by client_msg_id before retrying.
		if (!message) throw new SlackProviderError("protocol", "chat.postMessage", undefined, undefined, true);
		return message;
	}

	async addReaction(input: { channel: string; timestamp: string; name: string; signal?: AbortSignal }): Promise<void> {
		await this.#api(
			"reactions.add",
			{
				channel: input.channel,
				timestamp: input.timestamp,
				name: input.name,
			},
			input.signal,
		);
	}

	async findMessageByClientMsgId(input: {
		channel: string;
		clientMsgId: string;
		threadTs?: string;
		signal?: AbortSignal;
	}): Promise<SlackMessageSearchResult | null> {
		const response = await this.#api("conversations.history", { channel: input.channel }, input.signal);
		const fromHistory = this.#findMessage(response, input.clientMsgId, input.channel);
		if (fromHistory || !input.threadTs) return fromHistory;
		const replies = await this.#api(
			"conversations.replies",
			{ channel: input.channel, ts: input.threadTs },
			input.signal,
		);
		return this.#findMessage(replies, input.clientMsgId, input.channel);
	}

	/**
	 * Confirm that `ts` addresses a real message in `channel`. Slack answers
	 * `conversations.replies` with the addressed message first; a timestamp that
	 * is unknown, deleted, or lives in another channel produces a Web API error
	 * instead, which surfaces as a `SlackProviderError` the caller treats as an
	 * unverified root.
	 */
	async findMessageByTimestamp(input: { channel: string; ts: string }): Promise<SlackMessageSearchResult | null> {
		const response = await this.#api("conversations.replies", { channel: input.channel, ts: input.ts, limit: "1" });
		for (const candidate of messages(response.messages)) {
			if (string(candidate.ts) !== input.ts) continue;
			return { channel: string(candidate.channel) ?? input.channel, ts: input.ts, client_msg_id: undefined };
		}
		return null;
	}

	async #connect(generation = this.#lifecycleGeneration): Promise<void> {
		const opened = await this.#openSocketUrl();
		if (this.#stopped || generation !== this.#lifecycleGeneration) return;
		await new Promise<void>((resolve, reject) => {
			const socket = this.#webSocket(opened);
			let openedConnection = false;
			this.#socket = socket;
			socket.onopen = () => {
				openedConnection = true;
				this.#lastActivityAt = this.#now();
				this.#callbackHealthy = true;
				this.#lastCallbackFailure = 0;
				resolve();
			};
			socket.onmessage = event => this.#receive(socket, event.data);
			socket.onerror = () => {
				if (!openedConnection) {
					reject(new SlackProviderError("connection", "socket_connect"));
					return;
				}
				this.#callbackHealthy = false;
				socket.close();
			};
			socket.onclose = () => {
				if (this.#socket === socket) this.#socket = undefined;
				if (!openedConnection) {
					reject(new SlackProviderError("connection", "socket_connect"));
					return;
				}
				if (!this.#stopped) void this.#reconnect();
			};
		});
	}

	async #reconnect(): Promise<void> {
		if (this.#reconnectPending || this.#stopped) return;
		this.#reconnectPending = true;
		const generation = this.#lifecycleGeneration;
		let failures = 0;
		try {
			while (!this.#stopped && generation === this.#lifecycleGeneration) {
				const delay = Math.min(MAX_RECONNECT_DELAY_MS, this.#reconnectDelay(failures));
				await this.#sleep(delay);
				if (this.#stopped || generation !== this.#lifecycleGeneration) return;
				try {
					await this.#connect(generation);
					return;
				} catch {
					// A dropped replacement connection may have accepted the open request.
					// Keep retrying for this worker's lifetime with a bounded delay.
					failures++;
				}
			}
		} finally {
			this.#reconnectPending = false;
		}
	}
	#reconnectDelay(failures: number): number {
		return Math.max(1, this.#reconnectDelayMs * 2 ** Math.min(failures, 30));
	}

	#receive(socket: SlackWebSocket, data: unknown): void {
		if (typeof data !== "string") return;
		try {
			const decoded: unknown = JSON.parse(data);
			if (!decoded || typeof decoded !== "object") return;
			this.#lastActivityAt = this.#now();
			const candidate = decoded as { envelope_id?: unknown; payload?: unknown };
			const envelopeId = string(candidate.envelope_id);
			if (!envelopeId) return;
			this.#envelopeSockets.set(envelopeId, socket);
			const sequence = ++this.#deliverySequence;
			void this.#deliverEnvelope(socket, sequence, { envelope_id: envelopeId, payload: candidate.payload });
		} catch {
			// Socket Mode can safely ignore malformed frames; Slack redelivers unacknowledged envelopes.
		}
	}
	async #deliverEnvelope(socket: SlackWebSocket, sequence: number, envelope: SlackSocketEnvelope): Promise<void> {
		try {
			await this.#onEnvelope?.(envelope);
			if (this.#socket === socket && sequence > this.#lastCallbackFailure) this.#callbackHealthy = true;
		} catch {
			if (this.#socket !== socket) return;
			// Callback failures are transport failures: retain the unhealthy state until a newer valid delivery or reconnect.
			this.#lastCallbackFailure = sequence;
			this.#callbackHealthy = false;
		}
	}

	async #openSocketUrl(): Promise<string> {
		const response = await this.#request("apps.connections.open", this.#appToken, {});
		const url = string(response.url);
		if (!url) throw new SlackProviderError("protocol", "apps.connections.open");
		return url;
	}

	async #api(
		operation: string,
		body: Record<string, string | undefined>,
		signal?: AbortSignal,
	): Promise<SlackApiResponse> {
		const result = await this.#request(operation, this.#botToken, body, true, signal);
		if (result.ok === true) return result;
		throw new SlackProviderError("web_api", operation);
	}

	async #sleepUntilAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			await this.#sleep(milliseconds);
			return;
		}
		signal.throwIfAborted();
		const aborted = Promise.withResolvers<void>();
		const abort = (): void => aborted.reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		try {
			await Promise.race([this.#sleep(milliseconds, signal), aborted.promise]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	async #request(
		operation: string,
		token: string,
		body: Record<string, string | undefined>,
		retryRateLimit = false,
		signal?: AbortSignal,
	): Promise<SlackApiResponse> {
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			let response: Response;
			try {
				response = await this.#fetch(`${SLACK_API}/${operation}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
					},
					body: formBody(body),
					signal,
				});
			} catch {
				throw new SlackProviderError(
					"connection",
					operation,
					undefined,
					undefined,
					operation === "chat.postMessage",
				);
			}
			let parsed: unknown;
			try {
				parsed = await response.json();
			} catch {
				throw new SlackProviderError(
					"protocol",
					operation,
					response.status,
					undefined,
					operation === "chat.postMessage" && response.ok,
				);
			}
			const result = parsed && typeof parsed === "object" ? (parsed as SlackApiResponse) : {};
			if (response.status !== 429) {
				if (!response.ok) throw new SlackProviderError("web_api", operation, response.status);
				return result;
			}
			const retryAfterMs = retryAfterMilliseconds(response, result, this.#maxRetryAfterMs);
			if (!retryRateLimit || attempt >= this.#maxRateLimitRetries) {
				throw new SlackProviderError("rate_limited", operation, response.status, retryAfterMs);
			}
			const startedAt = this.#now();
			await this.#sleepUntilAbort(retryAfterMs, signal);
			if (this.#now() - startedAt > this.#maxRetryAfterMs) {
				throw new SlackProviderError("rate_limited", operation, response.status, retryAfterMs);
			}
		}
	}

	#message(response: SlackApiResponse): SlackPostedMessage | undefined {
		const direct: SlackApiMessage = {
			channel: response.channel,
			ts: response.ts,
			client_msg_id: response.client_msg_id,
		};
		const nested = messages(response.message ? [response.message] : response.messages)[0];
		const candidate = string(direct.channel) && string(direct.ts) ? direct : nested;
		const channel = string(candidate?.channel);
		const ts = string(candidate?.ts);
		return channel && ts ? { channel, ts, client_msg_id: string(candidate.client_msg_id) } : undefined;
	}

	#findMessage(
		response: SlackApiResponse,
		clientMsgId: string,
		requestedChannel: string,
	): SlackMessageSearchResult | null {
		for (const candidate of messages(response.messages)) {
			const ts = string(candidate.ts);
			if (ts && string(candidate.client_msg_id) === clientMsgId) {
				return { channel: string(candidate.channel) ?? requestedChannel, ts, client_msg_id: clientMsgId };
			}
		}
		return null;
	}
}
