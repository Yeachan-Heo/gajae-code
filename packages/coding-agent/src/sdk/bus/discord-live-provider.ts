import type { DiscordInboundEvent, DiscordMessageComponent, DiscordProvider, DiscordThread } from "./discord-provider";

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_INTENTS = 1 + 512 + 32_768;
const MAX_RATE_LIMIT_RETRIES = 2;
const NONCE_PREFIX = "<!-- gjc-thread-nonce:";
const INVALID_SESSION_RECONNECT_DELAY_MS = 1_000;

const NONCE_SUFFIX = " -->";

export interface DiscordGatewaySocket {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event) => void): void;
}

export interface DiscordTimer {
	cancel(): void;
}

type DiscordFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface DiscordLiveProviderOptions {
	applicationId: string;
	botToken: string;
	fetchImpl?: DiscordFetch;
	WebSocketImpl?: (url: string) => DiscordGatewaySocket;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	setIntervalImpl?: (callback: () => void, milliseconds: number) => DiscordTimer;
	setTimeoutImpl?: (callback: () => void, milliseconds: number) => DiscordTimer;
	apiBaseUrl?: string;
}

type JsonRecord = Record<string, unknown>;

/** Discord REST/Gateway implementation. The only credential is held privately and is never emitted. */
export class DiscordLiveProvider implements DiscordProvider {
	readonly applicationId: string;
	readonly #token: string;
	readonly #fetch: DiscordFetch;
	readonly #webSocket: (url: string) => DiscordGatewaySocket;
	readonly #now: () => number;
	readonly #sleep: (milliseconds: number) => Promise<void>;
	readonly #setInterval: (callback: () => void, milliseconds: number) => DiscordTimer;
	readonly #setTimeout: (callback: () => void, milliseconds: number) => DiscordTimer;
	readonly #apiBaseUrl: string;
	#botUserId = "";
	#stopped = true;
	#socket: DiscordGatewaySocket | undefined;
	#heartbeat: DiscordTimer | undefined;
	#reconnect: DiscordTimer | undefined;
	#sequence: number | null = null;
	#sessionId: string | undefined;
	#resumeGatewayUrl: string | undefined;
	#gatewayUrl: string | undefined;
	#onEvent: ((event: DiscordInboundEvent) => Promise<void>) | undefined;
	#gatewayError: Error | undefined;
	#gatewayReady = false;
	#awaitingHeartbeatAck = false;

	constructor(options: DiscordLiveProviderOptions) {
		this.applicationId = options.applicationId;
		this.#token = options.botToken;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#webSocket = options.WebSocketImpl ?? (url => new WebSocket(url));
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
		this.#setInterval =
			options.setIntervalImpl ??
			((callback, milliseconds) => {
				const timer = setInterval(callback, milliseconds);
				return { cancel: () => clearInterval(timer) };
			});
		this.#setTimeout =
			options.setTimeoutImpl ??
			((callback, milliseconds) => {
				const timer = setTimeout(callback, milliseconds);
				return { cancel: () => clearTimeout(timer) };
			});
		this.#apiBaseUrl = options.apiBaseUrl ?? API_BASE;
	}

	get botUserId(): string {
		return this.#botUserId;
	}
	get transportHealthy(): boolean {
		return (
			!this.#stopped &&
			!this.#gatewayError &&
			this.#gatewayReady &&
			!this.#awaitingHeartbeatAck &&
			this.#socket?.readyState === 1
		);
	}
	get gatewayError(): Error | undefined {
		return this.#gatewayError;
	}

	async createThread(input: {
		guildId: string;
		parentId: string;
		name: string;
		nonce: string;
	}): Promise<DiscordThread> {
		const marker = `${NONCE_PREFIX}${input.nonce}${NONCE_SUFFIX}`;
		const starter = await this.#findStarterMessage(input.parentId, marker);
		if (starter?.thread) {
			const existing = this.#starterThread(starter.thread, input.guildId, input.parentId);
			if (!existing) throw new Error("Discord returned an invalid starter-message thread");
			return existing;
		}
		const messageId = starter?.id ?? (await this.#createStarterMessage(input.parentId, marker));
		const body = await this.#request(`/channels/${input.parentId}/messages/${messageId}/threads`, {
			method: "POST",
			body: JSON.stringify({ name: input.name, auto_archive_duration: 1_440 }),
		});
		return this.#thread(body, input.guildId, input.parentId);
	}

	async #createStarterMessage(parentId: string, marker: string): Promise<string> {
		const message = await this.#request(`/channels/${parentId}/messages`, {
			method: "POST",
			body: JSON.stringify({ content: marker }),
		});
		const id = this.#string(message, "id");
		if (!id) throw new Error("Discord returned an invalid starter-message response");
		return id;
	}

	async #findStarterMessage(parentId: string, marker: string): Promise<{ id: string; thread?: unknown } | undefined> {
		const messages = await this.#request(`/channels/${parentId}/messages?limit=100`);
		if (!Array.isArray(messages)) return undefined;
		for (const message of messages) {
			if (!this.#messageContent(message).includes(marker)) continue;
			const id = this.#string(message, "id");
			if (id)
				return {
					id,
					...(this.#record(message).thread === undefined ? {} : { thread: this.#record(message).thread }),
				};
		}
		return undefined;
	}

	async findThreadByNonce(input: { guildId: string; parentId: string; nonce: string }): Promise<DiscordThread | null> {
		const marker = `${NONCE_PREFIX}${input.nonce}${NONCE_SUFFIX}`;
		const parentMessages = await this.#request(`/channels/${input.parentId}/messages?limit=100`);
		if (Array.isArray(parentMessages))
			for (const message of parentMessages) {
				if (!this.#messageContent(message).includes(marker)) continue;
				const thread = this.#starterThread(this.#record(message).thread, input.guildId, input.parentId);
				if (thread) return thread;
			}
		const candidates = await this.#listThreads(input.guildId, input.parentId);
		for (const candidate of candidates) {
			const messages = await this.#request(`/channels/${candidate.id}/messages?limit=25`);
			if (Array.isArray(messages) && messages.some(message => this.#messageContent(message).includes(marker)))
				return candidate;
		}
		return null;
	}

	async postMessage(input: {
		threadId: string;
		content: string;
		nonce?: string;
		components?: DiscordMessageComponent[];
	}): Promise<{ id: string }> {
		const body = await this.#request(`/channels/${input.threadId}/messages`, {
			method: "POST",
			body: JSON.stringify({
				content: input.content,
				...(input.nonce === undefined ? {} : { nonce: input.nonce, enforce_nonce: true }),
				...(input.components === undefined
					? {}
					: {
							components: input.components.map(component => ({
								type: component.type,
								components: component.components.map(select => ({
									type: select.type,
									custom_id: select.customId,
									...(select.placeholder === undefined ? {} : { placeholder: select.placeholder }),
									...(select.minValues === undefined ? {} : { min_values: select.minValues }),
									...(select.maxValues === undefined ? {} : { max_values: select.maxValues }),
									options: select.options,
								})),
							})),
						}),
			}),
		});
		const id = this.#string(body, "id");
		if (!id) throw new Error("Discord returned an invalid message response");
		return { id };
	}

	async deferInteraction(input: { id: string; token: string }): Promise<void> {
		await this.#interactionRequest(
			`/interactions/${encodeURIComponent(input.id)}/${encodeURIComponent(input.token)}/callback`,
			{
				method: "POST",
				body: JSON.stringify({ type: 6 }),
			},
		);
	}

	async archiveThread(input: { threadId: string; locked?: boolean }): Promise<void> {
		await this.#request(`/channels/${input.threadId}`, {
			method: "PATCH",
			body: JSON.stringify({ archived: true, ...(input.locked === undefined ? {} : { locked: input.locked }) }),
		});
	}

	async unarchiveThread(input: { threadId: string }): Promise<void> {
		await this.#request(`/channels/${input.threadId}`, {
			method: "PATCH",
			body: JSON.stringify({ archived: false, locked: false }),
		});
	}

	async findMessageByNonce(input: { threadId: string; nonce: string }): Promise<{ id: string } | null> {
		const messages = await this.#request(`/channels/${input.threadId}/messages?limit=100`);
		if (!Array.isArray(messages)) return null;
		for (const message of messages) {
			const record = this.#record(message);
			if (record.nonce !== input.nonce) continue;
			const id = this.#string(record, "id");
			if (id) return { id };
		}
		return null;
	}

	async start(onEvent: (event: DiscordInboundEvent) => Promise<void>): Promise<void> {
		if (!this.#stopped) return;
		this.#onEvent = onEvent;
		this.#stopped = false;
		try {
			const me = await this.#request("/users/@me");
			const id = this.#string(me, "id");
			if (!id) throw new Error("Discord returned an invalid current-user response");
			this.#botUserId = id;
			const gateway = await this.#request("/gateway/bot");
			const url = this.#string(gateway, "url");
			if (!url) throw new Error("Discord returned an invalid gateway response");
			this.#gatewayUrl = url;
			this.#connect(url);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#heartbeat?.cancel();
		this.#reconnect?.cancel();
		this.#heartbeat = undefined;
		this.#reconnect = undefined;
		this.#gatewayReady = false;
		this.#awaitingHeartbeatAck = false;
		const socket = this.#socket;
		this.#socket = undefined;
		if (socket && socket.readyState !== 3) socket.close(1_000, "stopped");
	}

	#connect(baseUrl: string): void {
		if (this.#stopped) return;
		const url = `${baseUrl.replace(/\/$/, "")}/?v=10&encoding=json`;
		const socket = this.#webSocket(url);
		this.#socket = socket;
		this.#gatewayError = undefined;
		this.#gatewayReady = false;
		this.#awaitingHeartbeatAck = false;
		socket.addEventListener("message", event => {
			void this.#handleGateway(socket, event).catch(error => this.#handleGatewayFailure(socket, error));
		});
		socket.addEventListener("close", () => this.#scheduleReconnect(socket));
		socket.addEventListener("error", () => {
			if (socket.readyState !== 3) socket.close();
		});
	}

	async #handleGateway(socket: DiscordGatewaySocket, event: Event): Promise<void> {
		const data = (event as MessageEvent).data;
		if (typeof data !== "string") return;
		let frame: JsonRecord;
		try {
			frame = JSON.parse(data) as JsonRecord;
		} catch {
			return;
		}
		if (typeof frame.s === "number") this.#sequence = frame.s;
		if (frame.op === 10) {
			const interval = this.#number(this.#record(frame.d), "heartbeat_interval");
			if (!interval) return;
			this.#sendHeartbeat(socket);
			this.#heartbeat?.cancel();
			this.#heartbeat = this.#setInterval(() => this.#sendHeartbeat(socket), interval);
			this.#identifyOrResume(socket);
			return;
		}
		if (frame.op === 1) {
			this.#sendHeartbeat(socket);
			return;
		}
		if (frame.op === 11) {
			if (socket === this.#socket) this.#awaitingHeartbeatAck = false;
			return;
		}
		if (frame.op === 9) {
			// Discord permits a RESUME only when d is exactly true. An invalid
			// non-resumable session must discard all resume identity before IDENTIFY.
			if (frame.d !== true) {
				this.#sequence = null;
				this.#sessionId = undefined;
				this.#resumeGatewayUrl = undefined;
			}
			this.#gatewayReady = false;
			this.#awaitingHeartbeatAck = false;
			this.#scheduleReconnect(socket, INVALID_SESSION_RECONNECT_DELAY_MS);
			if (socket.readyState !== 3) socket.close();
			return;
		}
		if (frame.op === 7) {
			socket.close();
			return;
		}
		if (frame.op !== 0) return;
		const payload = this.#record(frame.d);
		if (frame.t === "READY") {
			this.#sessionId = this.#string(payload, "session_id");
			this.#resumeGatewayUrl = this.#string(payload, "resume_gateway_url");
		}
		if (frame.t === "READY" || frame.t === "RESUMED") this.#gatewayReady = true;
		const inbound = this.#inbound(frame.t, payload);
		if (inbound && !inbound.bot && inbound.authorId !== this.#botUserId) await this.#onEvent?.(inbound);
	}
	#handleGatewayFailure(socket: DiscordGatewaySocket, error: unknown): void {
		this.#gatewayError = error instanceof Error ? error : new Error("Discord gateway event handler failed");
		if (socket.readyState !== 3) socket.close(1_011, "gateway handler failed");
	}

	#identifyOrResume(socket: DiscordGatewaySocket): void {
		if (this.#sessionId && this.#sequence !== null) {
			socket.send(
				JSON.stringify({ op: 6, d: { token: this.#token, session_id: this.#sessionId, seq: this.#sequence } }),
			);
			return;
		}
		socket.send(
			JSON.stringify({
				op: 2,
				d: {
					token: this.#token,
					intents: GATEWAY_INTENTS,
					properties: { os: "bun", browser: "gjc", device: "gjc" },
				},
			}),
		);
	}

	#sendHeartbeat(socket: DiscordGatewaySocket): void {
		if (socket !== this.#socket || socket.readyState !== 1) return;
		if (this.#awaitingHeartbeatAck) {
			this.#gatewayReady = false;
			this.#gatewayError = new Error("Discord gateway heartbeat ACK timed out");
			socket.close(4_000, "missed heartbeat ACK");
			return;
		}
		this.#awaitingHeartbeatAck = true;
		socket.send(JSON.stringify({ op: 1, d: this.#sequence }));
	}

	#scheduleReconnect(socket: DiscordGatewaySocket, minimumDelayMs = 250): void {
		if (socket !== this.#socket) return;
		this.#heartbeat?.cancel();
		this.#heartbeat = undefined;
		if (this.#stopped || this.#reconnect) return;
		const reconnectAt = this.#now() + minimumDelayMs;
		this.#reconnect = this.#setTimeout(
			() => {
				this.#reconnect = undefined;
				this.#connect(this.#resumeGatewayUrl ?? this.#gatewayUrl ?? "wss://gateway.discord.gg");
			},
			Math.max(0, reconnectAt - this.#now()),
		);
	}

	async #listThreads(guildId: string, parentId: string): Promise<DiscordThread[]> {
		const result: DiscordThread[] = [];
		const active = this.#record(await this.#request(`/guilds/${guildId}/threads/active`));
		const activeThreads = active.threads;
		if (Array.isArray(activeThreads))
			for (const thread of activeThreads) {
				const parsed = this.#threadOrUndefined(thread, guildId, parentId);
				if (parsed) result.push(parsed);
			}
		const archived = this.#record(await this.#request(`/channels/${parentId}/threads/archived/public?limit=100`));
		const archivedThreads = archived.threads;
		if (Array.isArray(archivedThreads))
			for (const thread of archivedThreads) {
				const parsed = this.#threadOrUndefined(thread, guildId, parentId);
				if (parsed) result.push(parsed);
			}
		return result;
	}

	async #request(path: string, init: RequestInit = {}): Promise<unknown> {
		return await this.#requestWithHeaders(
			path,
			{ Authorization: `Bot ${this.#token}`, "Content-Type": "application/json" },
			init,
		);
	}
	async #interactionRequest(path: string, init: RequestInit = {}): Promise<unknown> {
		return await this.#requestWithHeaders(path, { "Content-Type": "application/json" }, init);
	}
	async #requestWithHeaders(path: string, headers: Record<string, string>, init: RequestInit): Promise<unknown> {
		for (let attempt = 0; ; attempt++) {
			const mergedHeaders = new Headers(headers);
			for (const [key, value] of new Headers(init.headers)) mergedHeaders.set(key, value);
			const response = await this.#fetch(`${this.#apiBaseUrl}${path}`, { ...init, headers: mergedHeaders });
			if (response.status !== 429) {
				if (!response.ok) throw new Error(`Discord API request failed (${response.status})`);
				return response.status === 204 ? undefined : await response.json();
			}
			if (attempt >= MAX_RATE_LIMIT_RETRIES) throw new Error("Discord API rate limit retry exhausted");
			const limited = this.#record(await response.json());
			const seconds = this.#number(limited, "retry_after") ?? 1;
			await this.#sleep(Math.max(0, seconds * 1_000));
		}
	}

	#thread(value: unknown, guildId: string, parentId: string): DiscordThread {
		const thread = this.#threadOrUndefined(value, guildId, parentId);
		if (!thread) throw new Error("Discord returned an invalid thread response");
		return thread;
	}
	#threadOrUndefined(value: unknown, guildId: string, parentId: string): DiscordThread | undefined {
		const record = this.#record(value);
		const id = this.#string(record, "id");
		if (!id || this.#string(record, "parent_id") !== parentId) return undefined;
		const metadata = this.#record(record.thread_metadata);
		return { id, guildId, parentId, archived: metadata.archived === true, locked: metadata.locked === true };
	}

	#starterThread(value: unknown, guildId: string, parentId: string): DiscordThread | undefined {
		const thread = this.#record(value);
		const id = this.#string(thread, "id");
		if (!id) return undefined;
		const metadata = this.#record(thread.thread_metadata);
		return { id, guildId, parentId, archived: metadata.archived === true, locked: metadata.locked === true };
	}
	#messageContent(value: unknown): string {
		return this.#string(this.#record(value), "content") ?? "";
	}
	#record(value: unknown): JsonRecord {
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
	}
	#string(value: unknown, key: string): string | undefined {
		const record = this.#record(value);
		return typeof record[key] === "string" ? record[key] : undefined;
	}
	#number(record: JsonRecord, key: string): number | undefined {
		return typeof record[key] === "number" ? record[key] : undefined;
	}
	#parentId(data: JsonRecord): string | undefined {
		return (
			this.#string(data, "parent_id") ??
			this.#string(this.#record(data.thread), "parent_id") ??
			this.#string(this.#record(data.channel), "parent_id")
		);
	}
	#inbound(type: unknown, data: JsonRecord): DiscordInboundEvent | undefined {
		if (type === "MESSAGE_CREATE") {
			const id = this.#string(data, "id");
			const guildId = this.#string(data, "guild_id");
			const threadId = this.#string(data, "channel_id");
			const author = this.#record(data.author);
			const authorId = this.#string(author, "id");
			const parentId = this.#parentId(data);
			if (!id || !guildId || !threadId || !parentId || !authorId) return undefined;
			return {
				id,
				guildId,
				parentId,
				threadId,
				authorId,
				bot: author.bot === true,
				content: this.#string(data, "content"),
			};
		}
		if (type === "INTERACTION_CREATE") {
			const id = this.#string(data, "id");
			const token = this.#string(data, "token");
			const guildId = this.#string(data, "guild_id");
			const threadId = this.#string(data, "channel_id");
			const member = this.#record(data.member);
			const user = this.#record(member.user);
			const authorId = this.#string(user, "id");
			const parentId = this.#parentId(data);
			const interaction = this.#record(data.data);
			const customId = this.#string(interaction, "custom_id");
			if (!id || !token || !guildId || !threadId || !parentId || !authorId || !customId) return undefined;
			const values = interaction.values;
			const value =
				Array.isArray(values) && (typeof values[0] === "string" || typeof values[0] === "number")
					? values[0]
					: (this.#string(interaction, "value") ?? this.#number(interaction, "value"));
			return {
				id,
				guildId,
				parentId,
				threadId,
				authorId,
				interaction: { id, token, customId, ...(value === undefined ? {} : { value }) },
			};
		}
		return undefined;
	}
}
