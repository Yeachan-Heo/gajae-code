import { randomUUID } from "node:crypto";
import {
	type MasterClientFrame,
	type MasterServerFrame,
	type ProviderEffectResultAck,
	type ProviderEffectResultFrame,
	type ProviderWorkerHelloAck,
	providerEffectResultValidator,
} from "../../master/sdk-contract";
import {
	type MasterSdkDiscovery,
	type MasterSdkDiscoveryOptions,
	readMasterSdkDiscovery,
} from "../../master/sdk-discovery";
import { MasterSdkClient, type MasterSdkClientOptions } from "../../master/sdk-transport";

export type MasterDaemonFrameListener = (frame: MasterServerFrame) => void;

/** Shared client seam consumed by provider workers and SDK-backed test doubles. */
export interface MasterDaemonWorkerClientLike {
	connect?: () => unknown | Promise<unknown>;
	onFrame(listener: MasterDaemonFrameListener): () => void;
	registerProviderWorker?: (provider: "telegram" | "discord", workerId: string) => unknown | Promise<unknown>;
	submitEffectResult?: (frame: ProviderEffectResultFrame) => unknown | Promise<unknown>;
	request?: (frame: MasterClientFrame) => unknown | Promise<unknown>;
	send?: (frame: MasterClientFrame) => unknown | Promise<unknown>;
	resolveRemoteChannelId?: (input: {
		provider: "telegram" | "discord";
		masterName: string;
		bindingId: string;
	}) => string | undefined | Promise<string | undefined>;
}

/** The narrow transport seam used by provider workers and deterministic tests. */
export interface MasterDaemonSdkClientLike {
	ready?: () => Promise<unknown>;
	onFrame?: (listener: MasterDaemonFrameListener) => () => void;
	request: (frame: MasterClientFrame) => Promise<MasterServerFrame>;
	send?: (frame: MasterClientFrame) => Promise<void>;
	close: () => Promise<void>;
}

export interface MasterDaemonClientOptions {
	/** An already connected SDK transport, useful for embedding/tests. */
	client?: MasterDaemonSdkClientLike;
	/** Discovery can be injected without reading the filesystem. */
	discovery?: Pick<MasterSdkDiscovery, "url" | "token">;
	/** Explicit discovery file path. */
	discoveryPath?: string;
	/** Alias accepted by callers that use the discovery helper's option name. */
	path?: string;
	/** Discovery path options for the default `$GJC_HOME/master` location. */
	discoveryOptions?: MasterSdkDiscoveryOptions;
	/** WebSocket constructor forwarded to the strict SDK client. */
	WebSocket?: MasterSdkClientOptions["WebSocket"];
	/** Request-id seam for deterministic tests. */
	requestId?: () => string;
	/** Bound the SDK handshake, subscription, and every request. */
	connectTimeoutMs?: number;
	requestTimeoutMs?: number;
	subscribeTimeoutMs?: number;
	/** Delay bounds used when a discovery-backed transport has to reconnect. */
	reconnectDelayMs?: number;
	reconnectMaxDelayMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;

export class MasterDaemonClientError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "MasterDaemonClientError";
		this.code = code;
	}
}

function randomRequestId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

function isErrorFrame(frame: MasterServerFrame): frame is Extract<MasterServerFrame, { type: "error" }> {
	return frame.type === "error";
}

function finiteTimeout(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && (value ?? 0) > 0 ? Math.max(1, Math.floor(value!)) : fallback;
}

function remoteKey(provider: "telegram" | "discord", masterName: string, bindingId: string): string {
	return `${provider}\u0000${masterName}\u0000${bindingId}`;
}

/**
 * Typed master endpoint client. It discovers and authenticates one loopback
 * endpoint, keeps a bounded subscription alive, forwards asynchronous frames,
 * and exposes only the provider-worker mutations needed by the chat workers.
 */
export class MasterDaemonClient implements MasterDaemonWorkerClientLike {
	readonly #options: MasterDaemonClientOptions;
	readonly #listeners = new Set<MasterDaemonFrameListener>();
	readonly #remoteChannels = new Map<string, string>();
	readonly #ambiguousRemoteChannels = new Set<string>();
	readonly #registrations = new Map<"telegram" | "discord", string>();
	#client: MasterDaemonSdkClientLike | undefined;
	#transportDisposer: (() => void) | undefined;
	#connectTask: Promise<this> | undefined;
	#reconnectTask: Promise<void> | undefined;
	#reconnectTimer: NodeJS.Timeout | undefined;
	#reconnectAttempt = 0;
	#registrationTimer: NodeJS.Timeout | undefined;
	#lastSeq = 0;
	#subscribed = false;
	#closed = false;

	constructor(options: MasterDaemonClientOptions = {}) {
		this.#options = options;
		this.#client = options.client;
	}

	static async connect(options: MasterDaemonClientOptions = {}): Promise<MasterDaemonClient> {
		const client = new MasterDaemonClient(options);
		await client.connect();
		return client;
	}

	get connected(): boolean {
		return this.#client !== undefined && !this.#closed;
	}

	/** The authenticated SDK transport, exposed for integration seams only. */
	get transport(): MasterDaemonSdkClientLike | undefined {
		return this.#client;
	}

	async connect(): Promise<this> {
		if (this.#closed) throw new MasterDaemonClientError("master daemon client is closed", "closed");
		if (this.#client !== undefined) {
			this.#attachTransportListener();
			await this.#withTimeout(
				this.#client.ready?.() ?? Promise.resolve(),
				this.#connectTimeout(),
				"master SDK handshake",
			);
			if (!this.#subscribed) await this.#subscribe();
			return this;
		}
		if (this.#connectTask) return await this.#connectTask;

		const task = (async (): Promise<this> => {
			try {
				const discovery =
					this.#options.discovery ??
					(await readMasterSdkDiscovery({
						...(this.#options.discoveryOptions ?? {}),
						...(this.#options.discoveryPath === undefined && this.#options.path === undefined
							? {}
							: { path: this.#options.discoveryPath ?? this.#options.path }),
					}));
				if (!discovery)
					throw new MasterDaemonClientError("master SDK discovery record is unavailable", "discovery_unavailable");

				const sdk = await this.#openTransport(discovery);
				this.#client = sdk;
				this.#subscribed = false;
				this.#attachTransportListener();
				await this.#subscribe();
				this.#reconnectAttempt = 0;
				return this;
			} catch (error) {
				const client = this.#client;
				this.#detachTransport(client);
				this.#scheduleReconnect();
				throw error;
			}
		})();
		this.#connectTask = task;
		try {
			return await task;
		} finally {
			if (this.#connectTask === task) this.#connectTask = undefined;
		}
	}

	onFrame(listener: MasterDaemonFrameListener): () => void {
		this.#listeners.add(listener);
		if (this.#client !== undefined) this.#attachTransportListener();
		return () => this.#listeners.delete(listener);
	}

	async registerProviderWorker(provider: "telegram" | "discord", workerId: string): Promise<ProviderWorkerHelloAck> {
		const frame = {
			type: "provider_worker_hello" as const,
			requestId: this.#requestId("provider-worker-hello"),
			provider,
			workerId,
		};
		const response = await this.request(frame);
		if (isErrorFrame(response)) throw new MasterDaemonClientError(response.message, response.code);
		if (response.type !== "ack" || response.operation !== "provider_worker_hello")
			throw new MasterDaemonClientError(
				"master daemon returned an invalid provider-worker hello response",
				"invalid_response",
			);
		this.#registrations.set(provider, workerId);
		this.#ensureRegistrationRenewal();
		return response.result;
	}

	async submitEffectResult(frame: ProviderEffectResultFrame): Promise<ProviderEffectResultAck> {
		if (!providerEffectResultValidator.safeParse(frame).success)
			throw new MasterDaemonClientError("invalid provider-effect result frame", "invalid_frame");
		const response = await this.request(frame);
		if (isErrorFrame(response)) throw new MasterDaemonClientError(response.message, response.code);
		if (response.type !== "ack" || response.operation !== "provider_effect_result")
			throw new MasterDaemonClientError(
				"master daemon returned an invalid provider-effect result response",
				"invalid_response",
			);
		return response.result;
	}

	async request(frame: MasterClientFrame): Promise<MasterServerFrame> {
		await this.connect();
		const client = this.#client;
		if (!client) throw new MasterDaemonClientError("master daemon client is not connected", "not_connected");
		try {
			return await this.#withTimeout(client.request(frame), this.#requestTimeout(), "master SDK request");
		} catch (error) {
			this.#detachTransport(client);
			this.#scheduleReconnect();
			throw this.#asClientError(error, "master SDK request failed");
		}
	}

	async send(frame: MasterClientFrame): Promise<void> {
		await this.connect();
		const client = this.#client;
		if (!client) throw new MasterDaemonClientError("master daemon client is not connected", "not_connected");
		try {
			if (client.send) {
				await this.#withTimeout(client.send(frame), this.#requestTimeout(), "master SDK send");
				return;
			}
			await this.#withTimeout(client.request(frame), this.#requestTimeout(), "master SDK send");
		} catch (error) {
			this.#detachTransport(client);
			this.#scheduleReconnect();
			throw this.#asClientError(error, "master SDK send failed");
		}
	}

	async resolveRemoteChannelId(input: {
		provider: "telegram" | "discord";
		masterName: string;
		bindingId: string;
	}): Promise<string | undefined> {
		const key = remoteKey(input.provider, input.masterName, input.bindingId);
		if (this.#ambiguousRemoteChannels.has(key)) return undefined;
		const existing = this.#remoteChannels.get(key);
		if (existing) return existing;
		try {
			const response = await this.request({
				type: "get_snapshot",
				requestId: this.#requestId("master-snapshot"),
			});
			if (response.type !== "master_snapshot") return undefined;
			this.#recordSnapshot(response.masters);
		} catch {
			return undefined;
		}
		return this.#ambiguousRemoteChannels.has(key) ? undefined : this.#remoteChannels.get(key);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		if (this.#registrationTimer !== undefined) clearInterval(this.#registrationTimer);
		this.#registrationTimer = undefined;
		this.#transportDisposer?.();
		this.#transportDisposer = undefined;
		this.#listeners.clear();
		const client = this.#client;
		this.#client = undefined;
		this.#subscribed = false;
		if (client)
			await this.#withTimeout(client.close(), this.#requestTimeout(), "master SDK close").catch(() => undefined);
	}

	#ensureRegistrationRenewal(): void {
		if (this.#registrationTimer !== undefined) return;
		this.#registrationTimer = setInterval(() => {
			void this.#renewRegistrations();
		}, 10_000);
		this.#registrationTimer.unref();
	}

	async #renewRegistrations(): Promise<void> {
		for (const [provider, workerId] of this.#registrations) {
			try {
				const response = await this.request({
					type: "provider_worker_hello",
					requestId: this.#requestId("provider-worker-renew"),
					provider,
					workerId,
				});
				if (isErrorFrame(response) || response.type !== "ack" || response.operation !== "provider_worker_hello")
					throw new MasterDaemonClientError("provider worker lease renewal was rejected", "invalid_response");
			} catch {
				return;
			}
		}
	}
	#requestId(prefix: string): string {
		return this.#options.requestId?.() ?? randomRequestId(prefix);
	}

	#connectTimeout(): number {
		return finiteTimeout(this.#options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
	}

	#requestTimeout(): number {
		return finiteTimeout(this.#options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
	}

	#subscribeTimeout(): number {
		return finiteTimeout(this.#options.subscribeTimeoutMs, DEFAULT_SUBSCRIBE_TIMEOUT_MS);
	}

	async #openTransport(discovery: Pick<MasterSdkDiscovery, "url" | "token">): Promise<MasterDaemonSdkClientLike> {
		let sdk: MasterSdkClient | undefined;
		try {
			sdk = new MasterSdkClient({
				url: discovery.url,
				token: discovery.token,
				...(this.#options.WebSocket === undefined ? {} : { WebSocket: this.#options.WebSocket }),
			});
			await this.#withTimeout(sdk.ready(), this.#connectTimeout(), "master SDK handshake");
			return sdk;
		} catch (error) {
			await sdk?.close().catch(() => undefined);
			throw this.#asClientError(error, "master SDK connection failed");
		}
	}

	async #subscribe(): Promise<void> {
		const client = this.#client;
		if (!client) throw new MasterDaemonClientError("master daemon client is not connected", "not_connected");
		const afterSeq = this.#lastSeq > 0 ? this.#lastSeq : undefined;
		let response = await this.#withTimeout(
			client.request({
				type: "subscribe",
				requestId: this.#requestId("master-subscribe"),
				...(afterSeq === undefined ? {} : { afterSeq }),
			}),
			this.#subscribeTimeout(),
			"master SDK subscription",
		);
		if (response.type === "resync_required") {
			this.#lastSeq = 0;
			response = await this.#withTimeout(
				client.request({ type: "subscribe", requestId: this.#requestId("master-subscribe") }),
				this.#subscribeTimeout(),
				"master SDK resubscription",
			);
		}
		if (response.type !== "subscription_ready")
			throw new MasterDaemonClientError(
				"master daemon did not acknowledge its event subscription",
				"invalid_subscription",
			);
		this.#subscribed = true;
	}

	#attachTransportListener(): void {
		if (this.#transportDisposer || !this.#client?.onFrame) return;
		this.#transportDisposer = this.#client.onFrame(frame => this.#observeFrame(frame));
	}

	#observeFrame(frame: MasterServerFrame): void {
		if (
			"seq" in frame &&
			typeof frame.seq === "number" &&
			Number.isSafeInteger(frame.seq) &&
			frame.seq > this.#lastSeq
		)
			this.#lastSeq = frame.seq;
		if (frame.type === "master_snapshot") this.#recordSnapshot(frame.masters);
		for (const listener of [...this.#listeners]) {
			try {
				listener(frame);
			} catch {
				// A provider worker must not prevent another worker from receiving a frame.
			}
		}
	}

	#recordSnapshot(masters: readonly unknown[]): void {
		this.#remoteChannels.clear();
		this.#ambiguousRemoteChannels.clear();
		for (const master of masters) {
			if (!master || typeof master !== "object" || Array.isArray(master)) continue;
			const candidate = master as { masterName?: unknown; channels?: unknown };
			if (typeof candidate.masterName !== "string" || !Array.isArray(candidate.channels)) continue;
			for (const channel of candidate.channels) {
				if (!channel || typeof channel !== "object" || Array.isArray(channel)) continue;
				const value = channel as {
					provider?: unknown;
					state?: unknown;
					bindingId?: unknown;
					remoteChannelId?: unknown;
				};
				if (
					(value.provider === "telegram" || value.provider === "discord") &&
					value.state === "active" &&
					typeof value.bindingId === "string" &&
					typeof value.remoteChannelId === "string" &&
					value.bindingId.length > 0 &&
					value.remoteChannelId.length > 0
				) {
					const key = remoteKey(value.provider, candidate.masterName, value.bindingId);
					if (this.#ambiguousRemoteChannels.has(key)) continue;
					const existing = this.#remoteChannels.get(key);
					if (existing !== undefined && existing !== value.remoteChannelId) {
						this.#remoteChannels.delete(key);
						this.#ambiguousRemoteChannels.add(key);
					} else this.#remoteChannels.set(key, value.remoteChannelId);
				}
			}
		}
	}

	#detachTransport(client: MasterDaemonSdkClientLike | undefined): void {
		if (!client || this.#client !== client) return;
		this.#transportDisposer?.();
		this.#transportDisposer = undefined;
		this.#client = undefined;
		this.#subscribed = false;
		if (this.#options.client !== client) void client.close().catch(() => undefined);
	}

	#scheduleReconnect(): void {
		if (
			this.#closed ||
			this.#options.client !== undefined ||
			this.#reconnectTimer !== undefined ||
			this.#reconnectTask
		)
			return;
		const initial = finiteTimeout(this.#options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
		const maximum = Math.max(
			initial,
			finiteTimeout(this.#options.reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS),
		);
		const delay = Math.min(maximum, initial * 2 ** Math.min(this.#reconnectAttempt, 8));
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			const task = this.#reconnect();
			this.#reconnectTask = task;
			void task.finally(() => {
				if (this.#reconnectTask === task) this.#reconnectTask = undefined;
				if (!this.#closed && this.#client === undefined) this.#scheduleReconnect();
			});
		}, delay);
	}

	async #reconnect(): Promise<void> {
		if (this.#closed || this.#client !== undefined) return;
		try {
			await this.connect();
			this.#reconnectAttempt = 0;
		} catch {
			this.#reconnectAttempt += 1;
		}
	}

	#asClientError(error: unknown, fallback: string): MasterDaemonClientError {
		if (error instanceof MasterDaemonClientError) return error;
		if (error instanceof Error && error.message) return new MasterDaemonClientError(error.message);
		return new MasterDaemonClientError(fallback);
	}

	async #withTimeout<T>(value: Promise<T>, timeoutMs: number, label: string): Promise<T> {
		const { promise: timeout, reject } = Promise.withResolvers<never>();
		const timer: NodeJS.Timeout = setTimeout(
			() => reject(new MasterDaemonClientError(`${label} timed out`, "timeout")),
			timeoutMs,
		);
		try {
			return await Promise.race([value, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
}

export async function connectMasterDaemonClient(options: MasterDaemonClientOptions = {}): Promise<MasterDaemonClient> {
	return await MasterDaemonClient.connect(options);
}

export type { MasterServerFrame, ProviderEffectResultFrame } from "../../master/sdk-contract";
