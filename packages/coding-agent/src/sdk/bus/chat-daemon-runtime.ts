import { randomUUID } from "node:crypto";
import { type IndexedSession, SessionIndex } from "../broker/session-index";
import { SdkClient, SdkClientError } from "../client/client";
import { readSdkBrokerDiscovery, readSdkSessionEndpoint, type SdkSessionEndpoint } from "../client/discovery";

import { createDiscordAdapter, createSlackAdapter } from "./chat-adapters";
import { type ChatTransport, projectChatCommandOutcome, sendAuthorizedChatOperation } from "./chat-command-policy";
import type { ChatDaemonKind } from "./chat-daemon-control";
import { type DiscordEndpointBinding, DiscordEndpointBindingError, DiscordNotificationDaemon } from "./discord-daemon";
import { DiscordLiveProvider } from "./discord-live-provider";
import type { DiscordProvider } from "./discord-provider";
import { type NotificationEvent, NotificationPresentationEngine } from "./engine";
import { type SlackEndpoint, SlackEndpointBindingError, SlackNotificationDaemon } from "./slack-daemon";
import { SlackLiveProvider } from "./slack-live-provider";
import { SlackProvider, type SlackProviderClient } from "./slack-provider";

export interface ChatDaemonRuntimeConfig {
	identity: string;
	notifications: {
		discord?: { botToken: string; applicationId: string; guildId: string; parentChannelId: string };
		slack?: { botToken: string; appToken: string; workspaceId: string; channelId: string; authorizedUserId?: string };
	};
	presentation?: { redact: boolean; verbosity: "lean" | "verbose" };
}

export interface ChatDaemonSdkClient {
	onFrame(handler: (frame: Record<string, unknown>) => void): () => void;
	request(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
	close(): Promise<void>;
	send(frame: Record<string, unknown>): void;
}

export type ChatDeliveryPhase = "pre_send" | "ambiguous";

/** An authorized SDK command could not be conclusively delivered. */
export class ChatDeliveryError extends Error {
	constructor(readonly phase: ChatDeliveryPhase) {
		super("Authorized chat SDK command delivery failed.");
		this.name = "ChatDeliveryError";
	}
}

function chatDeliveryPhase(error: unknown): ChatDeliveryPhase | undefined {
	if (error instanceof ChatDeliveryError) return error.phase;
	if (!(error instanceof SdkClientError)) return undefined;
	// `connection_closed` conveys no send-progress guarantee: SdkClient also emits it
	// when a pending, already-sent request loses its response.
	return ["connection_closed", "unavailable", "timeout", "reconnect_exhausted", "protocol_error"].includes(error.code)
		? "ambiguous"
		: undefined;
}

export interface ChatDaemonRuntimeDeps {
	createDiscordProvider?: (
		config: NonNullable<ChatDaemonRuntimeConfig["notifications"]["discord"]>,
	) => DiscordProvider;

	createSlackProvider?: (
		config: NonNullable<ChatDaemonRuntimeConfig["notifications"]["slack"]>,
	) => SlackProviderClient;
	createClient?: (endpoint: SdkSessionEndpoint) => Promise<ChatDaemonSdkClient>;
	createIndex?: (agentDir: string) => SessionIndex;
	createBrokerClient?: (endpoint: { url: string; token: string }) => Promise<ChatDaemonSdkClient>;
	onReconciled?: () => void;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
}

type AttachedSession = Readonly<{
	id: string;
	sessionId: string;
	endpoint: SdkSessionEndpoint;
	generation: number;
	client: ChatDaemonSdkClient;
	dispose: () => void;
}>;

function notificationFrame(frame: Record<string, unknown>): Record<string, unknown> {
	const payload = frame.type === "event" ? frame.payload : undefined;
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: frame;
}

function eventName(frame: Record<string, unknown>, normalized: Record<string, unknown>): string | undefined {
	if (frame.type === "event") {
		if (typeof frame.name === "string") return frame.name;
		if (typeof frame.kind === "string") return frame.kind;
	}
	return typeof normalized.type === "string" ? normalized.type : undefined;
}

function sessionIdFrom(frame: Record<string, unknown>): string | undefined {
	return typeof frame.sessionId === "string" && frame.sessionId ? frame.sessionId : undefined;
}

function generationFrom(frame: Record<string, unknown>): number | undefined {
	return typeof frame.generation === "number" && Number.isSafeInteger(frame.generation) && frame.generation >= 0
		? frame.generation
		: undefined;
}

/**
 * Worker-owned session discovery and event fanout. It connects only through the
 * public SDK transport and retains endpoint tokens solely in live client objects.
 */
export class ChatDaemonRuntime {
	readonly #sessions = new Map<string, AttachedSession>();
	readonly #index: SessionIndex;
	#stopTimer: (() => void) | undefined;
	readonly #pending = new Set<Promise<void>>();
	readonly #frameTails = new Map<string, Promise<void>>();
	#reconcileTail: Promise<void> = Promise.resolve();

	#discord: DiscordNotificationDaemon | undefined;
	#slack: SlackNotificationDaemon | undefined;
	#presentation: NotificationPresentationEngine | undefined;
	#transportHealthy: (() => boolean) | undefined;
	#reconcileReady = false;

	constructor(
		private readonly input: { kind: ChatDaemonKind; agentDir: string; config: ChatDaemonRuntimeConfig },
		private readonly deps: ChatDaemonRuntimeDeps = {},
	) {
		this.#index = deps.createIndex?.(input.agentDir) ?? new SessionIndex(input.agentDir);
	}

	async start(): Promise<void> {
		if (this.input.kind === "discord") {
			const config = this.input.config.notifications.discord;
			if (!config) throw new Error("Discord chat daemon provider configuration is unavailable.");
			const provider = (
				this.deps.createDiscordProvider ??
				((value: NonNullable<ChatDaemonRuntimeConfig["notifications"]["discord"]>) =>
					new DiscordLiveProvider(value))
			)(config);
			this.#transportHealthy = () => this.#reconcileReady && (provider.transportHealthy ?? true);
			this.#presentation = new NotificationPresentationEngine(
				[createDiscordAdapter({ channelId: config.parentChannelId })],
				{
					redact: this.input.config.presentation?.redact ?? true,
					sessionTag: sessionId => sessionId.slice(-6),
				},
			);
			this.#discord = new DiscordNotificationDaemon({
				agentDir: this.input.agentDir,
				repo: "",
				guildId: config.guildId,
				parentChannelId: config.parentChannelId,
				provider,
				resolveEndpoint: async sessionId => this.#discordEndpoint(sessionId),
				onCommand: async (sessionId, content, endpoint, idempotencyKey) => {
					const attached = this.#sessions.get(sessionId);
					if (!attached || !endpoint.isCurrent())
						throw new DiscordEndpointBindingError("Discord session endpoint changed before command dispatch.");
					return await this.#runChatCommand("discord", sessionId, content, attached.client, idempotencyKey);
				},
			});
		} else {
			const config = this.input.config.notifications.slack;
			if (!config) throw new Error("Slack chat daemon provider configuration is unavailable.");
			const provider = (
				this.deps.createSlackProvider ??
				((value: NonNullable<ChatDaemonRuntimeConfig["notifications"]["slack"]>) => new SlackLiveProvider(value))
			)(config);
			this.#transportHealthy = () => this.#reconcileReady && (provider.transportHealthy ?? true);
			this.#presentation = new NotificationPresentationEngine(
				[createSlackAdapter({ channelId: config.channelId })],
				{
					redact: this.input.config.presentation?.redact ?? true,
					sessionTag: sessionId => sessionId.slice(-6),
				},
			);
			this.#slack = new SlackNotificationDaemon({
				agentDir: this.input.agentDir,
				repo: "",
				teamId: config.workspaceId,
				channelId: config.channelId,
				provider: new SlackProvider(provider),
				authorizeActor: async actorId => config.authorizedUserId === actorId,
				createClient: endpoint => {
					const attached = this.#sessions.get(endpoint.sessionId);
					if (
						!attached ||
						attached.generation !== endpoint.generation ||
						attached.endpoint.url !== endpoint.url ||
						attached.endpoint.token !== endpoint.token
					)
						throw new SlackEndpointBindingError();
					return {
						send: frame => {
							if (this.#sessions.get(endpoint.sessionId) !== attached) throw new SlackEndpointBindingError();
							attached.client.send(frame);
						},
					};
				},
				resolveEndpoint: async sessionId => await this.resolveEndpoint(sessionId),
				onCommand: async (sessionId, content, endpoint, idempotencyKey) => {
					const attached = this.#sessions.get(sessionId);
					if (
						!attached ||
						attached.generation !== endpoint.generation ||
						attached.endpoint.url !== endpoint.url ||
						attached.endpoint.token !== endpoint.token
					)
						throw new SlackEndpointBindingError("Slack session endpoint changed before command dispatch.");
					return await this.#runChatCommand("slack", sessionId, content, attached.client, idempotencyKey);
				},
			});
		}
		try {
			await this.#serialReconcile();
			if (this.#discord) await this.#discord.start();
			if (this.#slack) await this.#slack.start();
			const timer = (this.deps.setInterval ?? setInterval)(() => {
				this.schedule(this.#serialReconcile());
			}, 2_000);
			this.#stopTimer = () => (this.deps.clearInterval ?? clearInterval)(timer);
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	transportHealthy(): boolean {
		return this.#transportHealthy?.() ?? false;
	}

	async stop(): Promise<void> {
		if (this.#stopTimer) this.#stopTimer();
		this.#stopTimer = undefined;
		await Promise.all([this.#discord?.stop(), this.#slack?.stop()]);
		this.#discord = undefined;
		this.#slack = undefined;
		this.#presentation = undefined;
		this.#transportHealthy = undefined;
		this.#reconcileReady = false;
		await Promise.allSettled([...this.#pending]);
		for (const [sessionId, attached] of this.#sessions) {
			this.#sessions.delete(sessionId);
			attached.dispose();
			await attached.client.close();
		}
	}

	#serialReconcile(): Promise<void> {
		const task = this.#reconcileTail
			.catch(() => undefined)
			.then(async () => {
				try {
					await this.reconcile();
					this.#reconcileReady = true;
					this.deps.onReconciled?.();
				} catch (error) {
					this.#reconcileReady = false;
					throw error;
				}
			});
		this.#reconcileTail = task;
		return task;
	}
	private async reconcile(): Promise<void> {
		await this.#index.open();
		await this.#index.refresh();
		const live = this.#index.listSessions().sessions.filter(session => session.live);
		const ids = new Set(live.map(session => session.sessionId));
		for (const session of live) await this.attach(session);
		for (const [sessionId, attached] of this.#sessions) {
			if (ids.has(sessionId)) continue;
			this.#sessions.delete(sessionId);
			attached.dispose();
			await attached.client.close();
			await this.close(sessionId);
		}
	}

	private async attach(indexed: IndexedSession): Promise<void> {
		const endpoint = await readSdkSessionEndpoint(indexed.locator.repo, indexed.sessionId);
		if (!endpoint) return;
		const existing = this.#sessions.get(indexed.sessionId);
		if (
			existing &&
			existing.endpoint.url === endpoint.url &&
			existing.endpoint.token === endpoint.token &&
			existing.generation === indexed.endpointGeneration
		)
			return;
		if (existing) {
			this.#sessions.delete(indexed.sessionId);
			existing.dispose();
			await existing.client.close();
		}
		const client = await (this.deps.createClient ?? (async value => await SdkClient.connect(value.url, value.token)))(
			endpoint,
		);
		let attached: AttachedSession | undefined;
		const dispose = client.onFrame(frame => {
			if (attached) this.schedule(this.enqueueFrame(attached, frame));
		});
		attached = Object.freeze({
			id: randomUUID(),
			sessionId: indexed.sessionId,
			endpoint,
			generation: indexed.endpointGeneration,
			client,
			dispose,
		});
		this.#sessions.set(indexed.sessionId, attached);
		this.#presentation?.connectSession(indexed.sessionId, {
			sendReply: route => {
				if (this.#sessions.get(indexed.sessionId) !== attached)
					throw new Error("Session endpoint changed before reply.");
				attached.client.send({ type: "reply", id: route.actionId, answer: route.answer });
			},
		});
		const replay = await client.request({
			type: "event_replay",
			sinceGeneration: indexed.endpointGeneration,
			sinceSeq: 0,
		});
		if (Array.isArray(replay.events))
			for (const event of replay.events)
				if (event && typeof event === "object" && !Array.isArray(event))
					await this.enqueueFrame(attached, event as Record<string, unknown>);
	}

	private async resolveEndpoint(sessionId: string): Promise<SlackEndpoint | null> {
		const attached = this.#sessions.get(sessionId);
		return attached ? { ...attached.endpoint, generation: attached.generation } : null;
	}
	#discordEndpoint(sessionId: string): DiscordEndpointBinding | null {
		const attached = this.#sessions.get(sessionId);
		if (!attached) return null;
		return {
			generation: attached.generation,
			isCurrent: () => this.#sessions.get(sessionId) === attached,
			send: frame => {
				if (this.#sessions.get(sessionId) !== attached) throw new DiscordEndpointBindingError();
				attached.client.send(frame);
			},
		};
	}

	private schedule(task: Promise<void>): void {
		this.#pending.add(task);
		void task.then(
			() => this.#pending.delete(task),
			() => this.#pending.delete(task),
		);
	}
	private enqueueFrame(attached: AttachedSession, frame: Record<string, unknown>): Promise<void> {
		const previous = this.#frameTails.get(attached.sessionId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(async () => await this.handleFrame(attached, frame));
		this.#frameTails.set(attached.sessionId, current);
		void current.then(
			() => {
				if (this.#frameTails.get(attached.sessionId) === current) this.#frameTails.delete(attached.sessionId);
			},
			() => {
				if (this.#frameTails.get(attached.sessionId) === current) this.#frameTails.delete(attached.sessionId);
			},
		);
		return current;
	}
	private async handleFrame(attached: AttachedSession, frame: Record<string, unknown>): Promise<void> {
		if (this.#sessions.get(attached.sessionId) !== attached) return;
		const normalizedFrame = notificationFrame(frame);
		if (normalizedFrame.type === "turn_stream" && normalizedFrame.phase === "live") return;
		const frameSessionId = sessionIdFrom(normalizedFrame) ?? sessionIdFrom(frame);
		if (frameSessionId !== undefined && frameSessionId !== attached.sessionId) return;
		const sessionId = attached.sessionId;
		const name = eventName(frame, normalizedFrame);
		if (name === "session_closed" || name === "session_terminated") {
			await this.close(sessionId);
			return;
		}
		if (name === "session_ready") {
			if (generationFrom(frame) !== attached.generation) return;
			await this.resume(sessionId, attached.generation, "GJC session ready.");
			return;
		}
		const notification = this.#notificationEvent(sessionId, normalizedFrame);
		if (notification?.type === "action_resolved") {
			await Promise.all([
				this.#discord?.resolveAction(sessionId, notification.id),
				this.#slack?.resolveAction(sessionId, notification.id),
			]);
			return;
		}
		if (!notification) return;
		const payload = this.#presentation?.fanout(notification)[0];
		const body = payload?.body;
		const content =
			body && typeof body === "object" && !Array.isArray(body)
				? typeof (body as Record<string, unknown>).content === "string"
					? (body as Record<string, unknown>).content
					: (body as Record<string, unknown>).text
				: undefined;
		if (typeof content !== "string") return;
		if (this.#discord)
			await this.#discord.notify({
				sessionId,
				endpointGeneration: attached.generation,
				content,
				...(notification.type === "action_needed"
					? { actionId: notification.id, options: notification.options }
					: {}),
			});
		if (this.#slack)
			await this.#slack.notify(
				sessionId,
				content,
				notification.type === "action_needed" ? notification.id : undefined,
				attached.generation,
			);
	}

	private async close(sessionId: string): Promise<void> {
		await this.#discord?.close(sessionId);
		await this.#slack?.close(sessionId);
	}

	private async resume(sessionId: string, generation: number, content: string): Promise<void> {
		if (this.#discord) {
			await this.#discord.resume(sessionId, generation);
			await this.#discord.notify({ sessionId, endpointGeneration: generation, content });
		}
		if (this.#slack) await this.#slack.resume(sessionId, content, generation);
	}
	async #runChatCommand(
		transport: ChatTransport,
		sessionId: string,
		content: string,
		boundClient?: ChatDaemonSdkClient,
		idempotencyKey: string = randomUUID(),
	): Promise<boolean> {
		const match = /^\/sdk\s+(control|query|global)\s+([^\s]+)(?:\s+(.+))?\s*$/.exec(content);
		if (!match) return false;
		const kind = match[1] as "control" | "query" | "global";
		let input: unknown = {};
		if (match[3]) {
			try {
				input = JSON.parse(match[3]);
			} catch {
				return false;
			}
		}
		if (!input || typeof input !== "object" || Array.isArray(input)) return false;
		const operation = match[2]!;
		let outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
		try {
			outcome = await sendAuthorizedChatOperation(transport, { kind, operation, input }, async () => {
				if (kind === "global")
					return await this.#runGlobalCommand(operation, input as Record<string, unknown>, idempotencyKey);
				const client = boundClient ?? this.#sessions.get(sessionId)?.client;
				if (!client) throw new ChatDeliveryError("pre_send");
				return await client.request(
					kind === "control"
						? { type: "control_request", operation, input, confirm: true, idempotencyKey }
						: { type: "query_request", query: operation, input, idempotencyKey },
				);
			});
		} catch (error) {
			const phase = chatDeliveryPhase(error);
			if (phase) throw error instanceof ChatDeliveryError ? error : new ChatDeliveryError(phase);
			if (!(error instanceof SdkClientError)) throw new ChatDeliveryError("ambiguous");
			outcome = {
				ok: false,
				error: {
					code: error.code,
					message: error.message,
				},
			};
		}
		await this.#postCommandOutcome(transport, sessionId, { kind, operation }, outcome);
		return outcome.ok;
	}
	async #runGlobalCommand(
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey: string,
	): Promise<Record<string, unknown>> {
		const discovery = await readSdkBrokerDiscovery(this.input.agentDir);
		if (!discovery) throw new ChatDeliveryError("pre_send");
		let client: ChatDaemonSdkClient;
		try {
			client = await (
				this.deps.createBrokerClient ?? (async endpoint => await SdkClient.connect(endpoint.url, endpoint.token))
			)({ url: discovery.url, token: discovery.token });
		} catch {
			throw new ChatDeliveryError("pre_send");
		}
		try {
			return await client.request({ type: "broker_request", operation, input, idempotencyKey });
		} finally {
			await client.close();
		}
	}
	async #postCommandOutcome(
		transport: ChatTransport,
		sessionId: string,
		request: Pick<import("./chat-command-policy").ChatOperationRequest, "kind" | "operation">,
		outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } },
	): Promise<void> {
		const content = JSON.stringify(projectChatCommandOutcome(request, outcome));
		if (transport === "discord") await this.#discord?.postCommandResult(sessionId, content);
		else await this.#slack?.postCommandResult(sessionId, content);
	}
	#notificationEvent(sessionId: string, frame: Record<string, unknown>): NotificationEvent {
		if (frame.type === "action_needed" && typeof frame.id === "string" && typeof frame.kind === "string") {
			return {
				type: "action_needed",
				id: frame.id,
				kind: frame.kind,
				sessionId,
				...(typeof frame.question === "string" ? { question: frame.question } : {}),
				...(Array.isArray(frame.options) && frame.options.every(option => typeof option === "string")
					? { options: frame.options.filter((option): option is string => typeof option === "string") }
					: {}),
				...(typeof frame.summary === "string" ? { summary: frame.summary } : {}),
			};
		}
		if (frame.type === "action_resolved" && typeof frame.id === "string")
			return { type: "action_resolved", id: frame.id, sessionId };
		return { type: "frame", sessionId, frame };
	}
}
