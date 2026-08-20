import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ChatDaemonRuntime } from "../src/sdk/bus/chat-daemon-runtime";
import { chatEffectJournalPath } from "../src/sdk/bus/chat-effect-journal";
import { HEARTBEAT_TTL_MS } from "../src/sdk/bus/daemon-paths";
import type { DiscordMessageComponent, DiscordProvider, DiscordThread } from "../src/sdk/bus/discord-provider";
import { SlackProviderError } from "../src/sdk/bus/slack-live-provider";
import type { SlackProviderClient } from "../src/sdk/bus/slack-provider";
import { ACP_SESSION_RECONNECT } from "../src/sdk/session-reconnect";
import { drainReconnects, expectedBackoffs, FakeWebSocket, withFakeTransport } from "./helpers/fake-sdk-transport";

const SESSION_ID = "chat-reconnect-session";
const GENERATION = 4;
const wallClockNow = Date.now;

function currentHostIncarnation(): string {
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("Current process incarnation is unavailable.");
	return incarnation;
}

// Keep the Router's independent attach deadline outside the fake reconnect clock.
const inertAttachmentTimeout = (() => ({ unref: () => undefined })) as unknown as typeof setTimeout;
const clearInertAttachmentTimeout = (() => undefined) as unknown as typeof clearTimeout;
/**
 * Mirrors `REPLAY_BARRIER_LIMIT`: how many live frames one attachment holds behind an
 * outstanding replay. Too low a mirror still overflows the real barrier; too high a real
 * limit leaves the flood below it, and the test fails on the frames that never arrive.
 */
const HOLD_LIMIT = 1_024;

/**
 * Mirrors `CAP_GATED_FRAME_KINDS` in `sdk/host/host.ts`: the kinds a replay answer
 * withholds from a connection without the tool-activity capability, which is every
 * connection a chat daemon opens.
 */
const CAP_GATED_REPLAY_KINDS = new Set(["tool_activity", "reasoning_summary"]);

class FakeSlackProvider implements SlackProviderClient {
	posts: Array<{ channel: string; text: string; threadTs?: string; clientMsgId: string }> = [];
	readonly postAttempts: Array<{ channel: string; text: string; threadTs?: string; clientMsgId: string }> = [];
	/** How many upcoming posts are refused, the way a provider outage refuses them. */
	failPosts = 0;
	/** How many upcoming posts Slack accepts before their acknowledgements are lost. */
	acceptThenThrowPosts = 0;
	/** How many publication reconciliation attempts fail after an ambiguous acknowledgement. */
	failReconciliations = 0;
	/** Every post this provider refused, so a test can settle on the refusal itself. */
	readonly refused: string[] = [];
	readonly completedClientMsgIds = new Set<string>();
	readonly transportHealthy = true;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async ack(): Promise<void> {}

	/**
	 * Holds every publish after it is recorded. Publishing is what the runtime's frame
	 * queue is made of, so a publish that never returns pins every frame delivered behind
	 * it inside that queue — which is how a test drives the interleaving where a socket
	 * has already carried a frame the runtime has not ingested yet.
	 */
	#publishGate: Promise<void> | undefined;
	#releasePublish: (() => void) | undefined;

	stallPosts(): void {
		if (this.#publishGate) return;
		const gate = Promise.withResolvers<void>();
		this.#publishGate = gate.promise;
		this.#releasePublish = gate.resolve;
	}

	/** Lets the stalled publish, and every frame queued behind it, run to completion. */
	releasePosts(): void {
		const release = this.#releasePublish;
		this.#publishGate = undefined;
		this.#releasePublish = undefined;
		release?.();
	}

	async postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
	}): Promise<{ channel: string; ts: string; client_msg_id: string }> {
		if (this.failPosts > 0) {
			this.failPosts -= 1;
			this.refused.push(input.text);
			throw new Error("slack provider is unavailable");
		}
		this.postAttempts.push(input);
		const duplicate = this.posts.findIndex(post => post.clientMsgId === input.clientMsgId);
		if (duplicate >= 0) {
			this.completedClientMsgIds.add(input.clientMsgId);
			return { channel: input.channel, ts: `7.${duplicate + 1}`, client_msg_id: input.clientMsgId };
		}
		const position = this.posts.push(input);
		if (this.acceptThenThrowPosts > 0) {
			this.acceptThenThrowPosts -= 1;
			this.failReconciliations = 1;
			throw new SlackProviderError("connection", "chat.postMessage", undefined, undefined, true);
		}
		if (this.#publishGate) await this.#publishGate;
		this.completedClientMsgIds.add(input.clientMsgId);
		return { channel: input.channel, ts: `7.${position}`, client_msg_id: input.clientMsgId };
	}

	async findMessageByClientMsgId(): Promise<null> {
		if (this.failReconciliations > 0) {
			this.failReconciliations -= 1;
			throw new Error("slack reconciliation is unavailable");
		}
		return null;
	}

	async findMessageByTimestamp(): Promise<null> {
		return null;
	}
}

class FakeDiscordProvider implements DiscordProvider {
	readonly applicationId = "discord-app";
	readonly botUserId = "discord-bot";
	readonly transportHealthy = true;
	readonly posts: Array<{ threadId: string; content: string; nonce?: string }> = [];
	readonly postAttempts: Array<{ threadId: string; content: string; nonce?: string }> = [];
	readonly #threadsByNonce = new Map<string, DiscordThread>();
	readonly #messagesByNonce = new Map<string, { id: string; threadId: string }>();
	acceptThenThrowPosts = 0;
	reconciliationFailureNonce: string | undefined;
	/**
	 * How many times the daemon probed reconciliation by nonce. The ambiguous-ack
	 * retry rides the daemon's lease-recovery timer, so a probe count above one is
	 * the observable that the retry actually ran (#4665 review).
	 */
	reconcileProbes = 0;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async createThread(input: {
		guildId: string;
		parentId: string;
		name: string;
		nonce: string;
	}): Promise<DiscordThread> {
		const existing = this.#threadsByNonce.get(input.nonce);
		if (existing) return existing;
		const thread = {
			id: `discord-thread-${this.#threadsByNonce.size + 1}`,
			guildId: input.guildId,
			parentId: input.parentId,
			archived: false,
		};
		this.#threadsByNonce.set(input.nonce, thread);
		return thread;
	}

	async findThreadByNonce(input: { guildId: string; parentId: string; nonce: string }): Promise<DiscordThread | null> {
		return this.#threadsByNonce.get(input.nonce) ?? null;
	}

	async findMessageByNonce(input: { threadId: string; nonce: string }): Promise<{ id: string } | null> {
		this.reconcileProbes += 1;
		if (input.nonce === this.reconciliationFailureNonce) throw new Error("discord reconciliation is unavailable");
		const message = this.#messagesByNonce.get(input.nonce);
		return message?.threadId === input.threadId ? { id: message.id } : null;
	}

	async postMessage(input: {
		threadId: string;
		content: string;
		nonce?: string;
		components?: DiscordMessageComponent[];
	}): Promise<{ id: string }> {
		this.postAttempts.push(input);
		const existing = input.nonce === undefined ? undefined : this.#messagesByNonce.get(input.nonce);
		if (existing) return { id: existing.id };
		const id = `discord-message-${this.posts.length + 1}`;
		this.posts.push(input);
		if (input.nonce !== undefined) this.#messagesByNonce.set(input.nonce, { id, threadId: input.threadId });
		if (this.acceptThenThrowPosts > 0) {
			this.acceptThenThrowPosts -= 1;
			this.reconciliationFailureNonce = input.nonce;
			throw new Error("discord disconnected after accepting post");
		}
		return { id };
	}

	async deferInteraction(): Promise<void> {}
	async archiveThread(): Promise<void> {}
	async unarchiveThread(): Promise<void> {}
}

/**
 * The session host as `SdkClient` sees it: one socket at a time, a fresh
 * connection id per socket, a monotonic event log, and `event_replay` answered
 * from whatever cursor the client asked for.
 */
class FakeSessionHost {
	/** Every replay the client asked for, in order, exactly as it was framed. */
	readonly replayRequests: Array<{ sinceGeneration: unknown; sinceSeq: unknown }> = [];
	/** Answers this many sequences below the cursor asked for, re-offering acknowledged events. */
	replayRewind = 0;
	/** Accepts replay requests and never answers them, the way a wedged host would. */
	stallReplay = false;
	/** Answers with a typed error to this many replays, leaving the socket open. */
	rejectReplays = 0;
	/** Answers with a gap that never states the range it covers, the way a malformed host would. */
	malformedGap = false;
	/** Answers with this gap verbatim, the way a host that miscounts its own ring would. */
	forcedGap: Record<string, unknown> | undefined;
	/** The id of the last replay the client asked for, so a test can answer it by hand. */
	lastReplayId: string | undefined;
	#generation = GENERATION;
	#log: Array<Record<string, unknown>> = [];
	#connections = 0;
	#socket: FakeWebSocket | undefined;
	#sequence = 0;
	readonly #ringSize: number;

	constructor(ringSize = Number.POSITIVE_INFINITY) {
		this.#ringSize = ringSize;
	}

	/** Brings up the socket the client just dialed: open, then hello. */
	accept(socket: FakeWebSocket): void {
		this.#socket = socket;
		socket.onSend = data => this.#answer(socket, data);
		socket.open();
		socket.deliver({ type: "hello", connectionId: `connection-${++this.#connections}` });
	}

	/**
	 * Records one event and delivers it to the attached socket. With no socket
	 * attached the event still enters the log — that is the gap a reconnect owes.
	 */
	emit(text: string): Record<string, unknown> {
		return this.#record("notice", { type: "notice", text });
	}

	emitSessionReady(): Record<string, unknown> {
		return this.#record("session_ready", { type: "session_ready" });
	}

	/**
	 * Records one live turn-stream event. It owns a sequence, so the barrier orders it
	 * like any other, but presentation drops it — it costs a hold slot and nothing else.
	 */
	emitStream(): Record<string, unknown> {
		return this.#record("turn_stream", { type: "turn_stream", phase: "live" });
	}

	/**
	 * Records one capability-gated event. It occupies a ring slot like any other, but
	 * `SessionSdkHost` filters this kind out of every replay answer to a connection
	 * that did not negotiate `tool_activity_v2` — which a chat daemon never does — so
	 * a host that retained it still answers this cursor with nothing above its gap.
	 */
	emitGated(): Record<string, unknown> {
		return this.#record("tool_activity", { type: "tool_activity" });
	}

	#record(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
		const event = {
			type: "event",
			kind,
			sessionId: SESSION_ID,
			generation: this.#generation,
			seq: ++this.#sequence,
			payload,
		};
		this.#log.push(event);
		if (this.#log.length > this.#ringSize) this.#log.shift();
		this.#socket?.deliver(event);
		return event;
	}

	/** Loses the open socket. The session keeps running; only the transport is gone. */
	drop(): void {
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.drop();
	}

	/** Restarts the event stream at the next generation, exactly as the host does. */
	roll(): void {
		this.#generation += 1;
		this.#log = [];
		this.#sequence = 0;
	}

	#answer(socket: FakeWebSocket, data: string): void {
		const frame = JSON.parse(data) as Record<string, unknown>;
		if (frame.type !== "event_replay") return;
		this.replayRequests.push({ sinceGeneration: frame.sinceGeneration, sinceSeq: frame.sinceSeq });
		this.lastReplayId = typeof frame.id === "string" ? frame.id : undefined;
		if (this.stallReplay) return;
		if (this.rejectReplays > 0) {
			this.rejectReplays -= 1;
			queueMicrotask(() =>
				socket.deliver({
					type: "event_replay_result",
					id: frame.id,
					ok: false,
					error: { code: "replay_unavailable", message: "replay log unavailable" },
				}),
			);
			return;
		}
		const asked = typeof frame.sinceSeq === "number" ? frame.sinceSeq : 0;
		const sinceSeq = Math.max(0, asked - this.replayRewind);
		const retained =
			frame.sinceGeneration === this.#generation
				? this.#log.filter(event => Number(event.seq) > sinceSeq)
				: [...this.#log];
		// Mirrors `SessionSdkHost`: capability-gated kinds are stripped from the answer
		// of a connection that never negotiated `tool_activity_v2`, so a retained
		// sequence can be missing from the suffix while the host still holds it.
		const events = retained.filter(event => !CAP_GATED_REPLAY_KINDS.has(String(event.kind)));
		const gap = this.#replayGap(frame.sinceGeneration, sinceSeq + 1);
		queueMicrotask(() =>
			socket.deliver({
				type: "event_replay_result",
				id: frame.id,
				ok: true,
				events,
				...(gap ? { gap } : {}),
				generation: this.#generation,
				lastSeq: this.#sequence,
			}),
		);
	}

	/**
	 * Mirrors `SessionEventStream.replay`: a stream that has rolled reports a
	 * generation reset, an evicted prefix reports the sequences it lost, and an
	 * answer that covers the whole request reports no gap at all.
	 */
	#replayGap(sinceGeneration: unknown, replayFrom: number): Record<string, unknown> | undefined {
		const resyncQueries = ["Q01", "Q02", "Q03"];
		if (sinceGeneration !== this.#generation)
			return {
				kind: "generation_reset",
				fromGeneration: sinceGeneration,
				toGeneration: this.#generation,
				resyncQueries,
			};
		if (this.forcedGap) return this.forcedGap;
		if (this.malformedGap) return { kind: "sequence_gap", fromSeq: replayFrom, resyncQueries };
		const oldest = Number(this.#log[0]?.seq ?? this.#sequence + 1);
		return replayFrom < oldest
			? { kind: "sequence_gap", fromSeq: replayFrom, toSeq: oldest - 1, resyncQueries }
			: undefined;
	}
}

interface AttachedRuntimeHarness {
	runtime: ChatDaemonRuntime;
	provider: FakeSlackProvider;
	/** The scratch agent dir the runtime writes its daemon journals under. */
	agentDir: string;
	/**
	 * Every warning the runtime logged, in order. A conceded retention gap is a
	 * permanent loss the operator only ever learns about here, so the concession is
	 * observable exactly where the runtime states it.
	 */
	warnings: string[];
	/** Fires one reconcile pass, exactly as the runtime's own interval does. */
	reconcile: () => void;
	/** Supersedes the indexed attachment with a newer endpoint generation. */
	supersede: () => Promise<void>;
}

/**
 * Runs the real attach path: one live indexed session with a readable, non-stale
 * discovery endpoint, and no `createClient` override, so the runtime connects its
 * attached-session client itself.
 */
async function withAttachedSessionRuntime(run: (harness: AttachedRuntimeHarness) => Promise<void>): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-chat-reconnect-"));
	let runtime: ChatDaemonRuntime | undefined;
	const warnings: string[] = [];
	const warnSpy = spyOn(logger, "warn").mockImplementation((message: string) => {
		warnings.push(message);
	});
	try {
		const stateRoot = path.join(agentDir, ".gjc", "state");
		const endpointFile = path.join(stateRoot, "sdk", `${SESSION_ID}.json`);
		await fs.mkdir(path.dirname(endpointFile), { recursive: true });
		await fs.writeFile(
			endpointFile,
			`${JSON.stringify({ version: 1, sessionId: SESSION_ID, url: "ws://localhost:1/", token: "not-persisted", pid: process.pid })}\n`,
		);
		const endpointMtimeMs = (await fs.stat(endpointFile)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		const hostIncarnation = currentHostIncarnation();
		await index.append({
			type: "host_registered",
			sessionId: SESSION_ID,
			locator: { repo: agentDir, stateRoot },
			endpointGeneration: GENERATION,
			pid: process.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
			endpointMtimeMs,
		});
		await index.checkpointLiveHeartbeats();

		const provider = new FakeSlackProvider();
		let reconcileTick: (() => void) | undefined;
		runtime = new ChatDaemonRuntime(
			{
				kind: "slack",
				agentDir,
				config: {
					identity: "test-identity",
					notifications: {
						slack: {
							botToken: "xoxb-not-persisted",
							appToken: "xapp-not-persisted",
							workspaceId: "T1",
							channelId: "C1",
						},
					},
				},
			},
			{
				createSlackProvider: () => provider,
				routerDeps: {
					setInterval: ((callback: () => void) => {
						reconcileTick = callback;
						return 0;
					}) as unknown as typeof setInterval,
					clearInterval: (() => undefined) as unknown as typeof clearInterval,
					setTimeout: inertAttachmentTimeout,
					clearTimeout: clearInertAttachmentTimeout,
				},
			},
		);
		await run({
			runtime,
			provider,
			agentDir,
			warnings,
			reconcile: () => reconcileTick?.(),
			supersede: async () => {
				await index.append({
					type: "host_registered",
					sessionId: SESSION_ID,
					locator: { repo: agentDir, stateRoot },
					endpointGeneration: GENERATION + 1,
					pid: process.pid,
					processIncarnation: hostIncarnation,
					hostIncarnation,
					endpointMtimeMs,
				});
				await index.checkpointLiveHeartbeats(wallClockNow());
			},
		});
	} finally {
		await runtime?.stop();
		warnSpy.mockRestore();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function withAttachedDiscordRuntime(
	run: (harness: {
		runtime: ChatDaemonRuntime;
		provider: FakeDiscordProvider;
		reconcile: () => void;
	}) => Promise<void>,
): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-chat-reconnect-discord-"));
	let runtime: ChatDaemonRuntime | undefined;
	try {
		const stateRoot = path.join(agentDir, ".gjc", "state");
		const endpointFile = path.join(stateRoot, "sdk", `${SESSION_ID}.json`);
		await fs.mkdir(path.dirname(endpointFile), { recursive: true });
		await fs.writeFile(
			endpointFile,
			`${JSON.stringify({ version: 1, sessionId: SESSION_ID, url: "ws://localhost:1/", token: "not-persisted", pid: process.pid })}\n`,
		);
		const endpointMtimeMs = (await fs.stat(endpointFile)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		const hostIncarnation = currentHostIncarnation();
		await index.append({
			type: "host_registered",
			sessionId: SESSION_ID,
			locator: { repo: agentDir, stateRoot },
			endpointGeneration: GENERATION,
			pid: process.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
			endpointMtimeMs,
		});
		await index.checkpointLiveHeartbeats();

		const provider = new FakeDiscordProvider();
		let reconcileTick: (() => void) | undefined;
		runtime = new ChatDaemonRuntime(
			{
				kind: "discord",
				agentDir,
				config: {
					identity: "test-identity",
					notifications: {
						discord: {
							botToken: "discord-not-persisted",
							applicationId: provider.applicationId,
							guildId: "discord-guild",
							parentChannelId: "discord-parent",
						},
					},
				},
			},
			{
				createDiscordProvider: () => provider,
				routerDeps: {
					setInterval: ((callback: () => void) => {
						reconcileTick = callback;
						return 0;
					}) as unknown as typeof setInterval,
					clearInterval: (() => undefined) as unknown as typeof clearInterval,
					setTimeout: inertAttachmentTimeout,
					clearTimeout: clearInertAttachmentTimeout,
				},
			},
		);
		await run({
			runtime,
			provider,
			reconcile: () => reconcileTick?.(),
		});
	} finally {
		await runtime?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

/** The runtime does its index and endpoint IO before it dials, so wait for the dial. */
async function awaitSocket(count: number): Promise<FakeWebSocket> {
	for (let attempt = 0; attempt < 8_000 && FakeWebSocket.instances.length < count; attempt++) await Bun.sleep(1);
	expect(FakeWebSocket.instances).toHaveLength(count);
	return FakeWebSocket.instances[count - 1]!;
}

/**
 * Delivery is observable only where it lands, so settle on the publications themselves.
 *
 * A post is recorded the moment the surface is handed it, which is before Router
 * advances its replay cursor. Tests that reconnect or capture `sinceSeq` must then
 * await `runtime.whenDispatchSettled()` — the completion marker is not the cursor.
 */
async function awaitPosts(provider: FakeSlackProvider, count: number): Promise<void> {
	for (let attempt = 0; attempt < 8_000 && provider.posts.length < count; attempt++) await Bun.sleep(1);
	expect(provider.posts).toHaveLength(count);
}

/** Drain Router `#enqueueFrame` tails so `attached.cursor` has moved past the posts above. */
async function awaitDispatchedPosts(
	runtime: ChatDaemonRuntime,
	provider: FakeSlackProvider,
	count: number,
): Promise<void> {
	await awaitPosts(provider, count);
	await runtime.whenDispatchSettled();
}

async function awaitDiscordPosts(provider: FakeDiscordProvider, count: number): Promise<void> {
	await awaitDiscordPostCount(provider, count);
}

async function awaitDiscordPostCount(provider: FakeDiscordProvider, count: number): Promise<void> {
	for (let attempt = 0; attempt < 8_000 && provider.posts.length < count; attempt++) await Bun.sleep(1);
	expect(provider.posts).toHaveLength(count);
}

/** A refusal is the only trace a failed publication leaves on this side of the runtime. */
async function awaitRefusals(provider: FakeSlackProvider, count: number): Promise<void> {
	await awaitRefusalCount(provider, count);
}

async function awaitRefusalCount(provider: FakeSlackProvider, count: number): Promise<void> {
	for (let attempt = 0; attempt < 8_000 && provider.refused.length < count; attempt++) await Bun.sleep(1);
	expect(provider.refused).toHaveLength(count);
}

/** The replay rides the socket, so settle on the request the host itself observed. */
async function awaitReplayRequests(host: FakeSessionHost, count: number): Promise<void> {
	for (let attempt = 0; attempt < 8_000 && host.replayRequests.length < count; attempt++) await Bun.sleep(1);
	expect(host.replayRequests).toHaveLength(count);
}

/** Flush queued host answers and chained frame tails without waiting on a stalled publish. */
async function drainMicrotasks(passes = 16): Promise<void> {
	for (let pass = 0; pass < passes; pass++) await Promise.resolve();
}
/**
 * A retry after a failed reconciliation is only observable on the attempt ledger, so
 * settle on the attempts themselves instead of a fixed wall-clock sleep: under loaded
 * CI runners the retry can land after a 50ms window and the test would report the
 * publication as never retried (#4596 flake).
 */
async function awaitPostAttempts(provider: FakeSlackProvider, text: string, count: number): Promise<void> {
	// Lease recovery is wall-clock scheduled; under a loaded shard the reconciliation
	// pass can trail the 2s settle every other helper uses, so this settle takes the
	// wide bound the 20s test timeout already provides (#4596 flake). A helper that
	// returns on timeout would silently convert "the retry never happened" into a
	// pass, so it throws instead (#4665 review).
	for (let attempt = 0; attempt < 8_000; attempt++) {
		if (provider.postAttempts.filter(post => post.text === text).length >= count) return;
		await Bun.sleep(1);
	}
	throw new Error(
		`expected ${count} post attempts for ${JSON.stringify(text)}, saw ${provider.postAttempts.filter(post => post.text === text).length}`,
	);
}

/** The barrier-failure/concession warnings are the runtime's synchronous completion signals. */
async function awaitWarning(warnings: string[], fragment: string): Promise<void> {
	for (let attempt = 0; attempt < 8_000; attempt++) {
		if (warnings.some(line => line.includes(fragment))) return;
		await Bun.sleep(1);
	}
	throw new Error(
		`expected a warning containing ${JSON.stringify(fragment)}, saw none of ${warnings.length} warnings`,
	);
}

/** The slack daemon's own retry timer is the lease-recovery scheduling; settle on the journal it drives. */
async function awaitSlackEffectState(agentDir: string, text: string, state: string): Promise<void> {
	const journalPath = chatEffectJournalPath(agentDir, "slack");
	for (let attempt = 0; attempt < 8_000; attempt++) {
		try {
			const raw = await fs.readFile(journalPath, "utf8");
			const effects = Object.values(JSON.parse(raw).conversations ?? {}) as Array<{
				state?: string;
				payload?: { text?: string };
			}>;
			if (effects.some(effect => effect.payload?.text === text && effect.state === state)) return;
		} catch {
			// The journal may not exist yet on the first pass.
		}
		await Bun.sleep(1);
	}
	throw new Error(`slack effect ${text} never reached state ${state}`);
}

test("chat daemon startup isolates an unreachable indexed endpoint from a healthy attachment", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-chat-reconcile-"));
	let runtime: ChatDaemonRuntime | undefined;
	const warnings: string[] = [];
	const warnSpy = spyOn(logger, "warn").mockImplementation((message: string) => {
		warnings.push(message);
	});
	try {
		const stateRoot = path.join(agentDir, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fs.mkdir(endpointDir, { recursive: true });
		const sessions = [
			{ sessionId: "chat-unreachable", url: "ws://unreachable.test/", token: "chat-unreachable-secret" },
			{ sessionId: "chat-healthy", url: "ws://healthy.test/", token: "chat-healthy-secret" },
		] as const;
		const index = await new SessionIndex(agentDir).open();
		const hostIncarnation = currentHostIncarnation();
		for (const session of sessions) {
			const endpointFile = path.join(endpointDir, `${session.sessionId}.json`);
			await fs.writeFile(endpointFile, `${JSON.stringify({ ...session, pid: process.pid })}\n`);
			const endpointMtimeMs = (await fs.stat(endpointFile)).mtimeMs;
			await index.append({
				type: "host_registered",
				sessionId: session.sessionId,
				locator: { repo: agentDir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				processIncarnation: hostIncarnation,
				hostIncarnation,
				endpointMtimeMs,
			});
		}
		await index.checkpointLiveHeartbeats();
		const provider = new FakeSlackProvider();
		const attachedSessions: string[] = [];
		runtime = new ChatDaemonRuntime(
			{
				kind: "slack",
				agentDir,
				config: {
					identity: "test-identity",
					notifications: {
						slack: {
							botToken: "xoxb-not-persisted",
							appToken: "xapp-not-persisted",
							workspaceId: "T1",
							channelId: "C1",
						},
					},
				},
			},
			{
				createSlackProvider: () => provider,
				routerDeps: {
					createClient: async endpoint => {
						if (endpoint.sessionId === "chat-unreachable") throw new Error("connect failed");
						attachedSessions.push(endpoint.sessionId);
						return {
							onFrame: () => () => {},
							request: async () => ({ events: [] }),
							close: async () => {},
							send: () => {},
						};
					},
					setInterval: (() => 0) as unknown as typeof setInterval,
					clearInterval: (() => {}) as unknown as typeof clearInterval,
				},
			},
		);
		await runtime.start();
		expect(runtime.transportHealthy()).toBe(true);
		expect(attachedSessions).toEqual(["chat-healthy"]);
		expect(warnings.some(message => message.includes("chat-unreachable"))).toBe(true);
		expect(warnings.every(message => !message.includes("chat-unreachable-secret"))).toBe(true);
	} finally {
		await runtime?.stop();
		warnSpy.mockRestore();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("an unreachable attached chat session exhausts its long-lived reconnect budget without blocking startup", async () => {
	await withAttachedSessionRuntime(async ({ runtime }) => {
		await withFakeTransport(async clock => {
			const starting = runtime.start();
			await awaitSocket(1);
			const observed = await drainReconnects(clock);
			await expect(starting).resolves.toBeUndefined();

			// The attached-session client must follow the shared long-lived schedule,
			// not the transport's one-shot defaults (3 attempts, 25/50/100ms = 175ms).
			expect(observed).toEqual(expectedBackoffs(ACP_SESSION_RECONNECT));
			expect(FakeWebSocket.instances).toHaveLength(ACP_SESSION_RECONNECT.reconnectAttempts + 1);
			expect(observed.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 2_000]);
			expect(Math.max(...observed)).toBe(2_000);

			// The host reaps a session whose client has not ponged within
			// HEARTBEAT_TTL_MS, so the whole retry window must cover that TTL twice.
			const totalBudgetMs = observed.reduce((total, backoff) => total + backoff, 0);
			expect(totalBudgetMs).toBeGreaterThanOrEqual(2 * HEARTBEAT_TTL_MS);
			expect(observed.length).toBeGreaterThan(3);
		});
	});
}, 20_000);

test("an established chat attachment that loses its open socket resumes from its last acknowledged event", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("before the drop");
			await awaitDispatchedPosts(runtime, provider, 1);

			// Drop the already-attached, already-active socket, then keep the session
			// producing: these events exist only in the host's log until delivery resumes.
			host.drop();
			host.emit("during the outage");

			reconcile();
			host.accept(await awaitSocket(2));
			// Cursor settlement for the first publication happened before the drop, so
			// this resume is issued from seq 1. Wait for the outage frame's dispatch to
			// settle before reading the exact replay-request array (#4665 review).
			await awaitDispatchedPosts(runtime, provider, 2);

			// The resume is a replay from the last acknowledged sequence, fenced on the
			// attachment's own endpoint generation — not a fresh attach from zero.
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
			// The frame the outage swallowed is delivered exactly once, and the frame that
			// was already acknowledged before the drop is not delivered twice.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\nbefore the drop",
				"GJC notice\nduring the outage",
			]);
		});
	});
}, 20_000);

test("a superseded endpoint generation disposes the old attachment instead of resuming it", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, supersede }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("before the roll");
			await awaitDispatchedPosts(runtime, provider, 1);

			// The socket drops and the endpoint rolls before anything reattaches, so the
			// attachment that owned the cursor is stale by the time reconcile runs.
			host.drop();
			await supersede();
			host.roll();

			reconcile();
			host.accept(await awaitSocket(2));
			host.emit("after the roll");
			await awaitPosts(provider, 2);

			// The superseded attachment was disposed, not resumed: the second replay is a
			// fresh attach at the new generation, never a resume from the old cursor.
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION + 1, sinceSeq: 0 },
			]);
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\nbefore the roll",
				"GJC notice\nafter the roll",
			]);
		});
	});
}, 20_000);

test("a live frame delivered before the resume replay answers is published in sequence, once", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");

			reconcile();
			// The replacement hello starts the replay, and this frame is delivered on the
			// replacement socket before that replay can answer: two producers, one stream.
			// Nothing here waits for the replay, which is exactly the window the barrier owns.
			host.accept(await awaitSocket(2));
			host.emit("three");

			await awaitPosts(provider, 3);
			// A late duplicate would land after the third publication, so asserting on the
			// count alone would read the stream before it can go wrong; the no-double-
			// publication invariant is a window, so settle once more after the count
			// (#4665).
			await runtime.whenDispatchSettled();
			// The socket carried "three" and the replay carried "two" and "three": ordering
			// follows the sequence, not the arrival, and the frame both producers carried is
			// published exactly once.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\ntwo",
				"GJC notice\nthree",
			]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
		});
	});
}, 20_000);

test("a replayed frame at or below the cursor is dropped instead of published a second time", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");
			// A host that answers from one sequence too far back re-offers an event this
			// attachment already acknowledged. The cursor settles delivery, so it is dropped.
			host.replayRewind = 1;

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitPosts(provider, 2);
			// A late duplicate would land after the count; the no-double-publication
			// invariant is a window, so settle once more after the count (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\ntwo"]);
		});
	});
}, 20_000);

test("stopping the runtime while a replay is pending neither hangs nor publishes what is held", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");
			host.stallReplay = true;

			reconcile();
			host.accept(await awaitSocket(2));
			host.emit("three");
			await awaitReplayRequests(host, 2);

			// `stop()` must not wait on a replay that never answers, and the frames the
			// barrier is holding belong to an attachment that no longer exists.
			await runtime.stop();
			// Stop is asynchronous teardown; the 20ms settle lets the pending replay's
			// abort signal propagate before the no-publication invariant is asserted
			// (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none"]);
		});
	});
}, 20_000);

test("a supersession while a replay is pending discards it instead of replaying onto the new attachment", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, supersede }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");
			host.stallReplay = true;

			reconcile();
			host.accept(await awaitSocket(2));
			host.emit("three");
			await awaitReplayRequests(host, 2);

			// The endpoint rolls while that replay is still outstanding: the superseded
			// attachment's held frames and its answer are dead work at the new generation.
			await supersede();
			host.roll();
			host.stallReplay = false;

			reconcile();
			host.accept(await awaitSocket(3));
			host.emit("after the roll");
			await awaitPosts(provider, 2);
			// The exact replay-request array below is only stable after the superseded
			// attachment's in-flight replay has been discarded; the post count above plus
			// this settle keeps the count/generation assertions race-free under load
			// (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\nafter the roll"]);
			// The middle resume request races the cursor ack of the first publication
			// (0 vs 1); what must hold is the count, the generations, and that the
			// rebuilt attachment starts the rolled stream from its own beginning.
			expect(host.replayRequests).toHaveLength(3);
			expect(host.replayRequests[0]).toEqual({ sinceGeneration: GENERATION, sinceSeq: 0 });
			expect(host.replayRequests[1]?.sinceGeneration).toBe(GENERATION);
			expect(host.replayRequests[2]).toEqual({ sinceGeneration: GENERATION + 1, sinceSeq: 0 });
		});
	});
}, 20_000);

test("a replay refused on a live socket loses no event and leaves the cursor below the gap", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");
			// The host refuses the resume replay on a socket that stays open. No hello can
			// follow a socket that never dropped, so nothing but this round will ever
			// re-issue the replay that owes the gap.
			host.rejectReplays = 1;

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			// Delivered on the live socket after the refusal, while the gap is still open.
			host.emit("three");

			await awaitPosts(provider, 3);
			// The exact replay-request array below is only stable after the retry tail has
			// been issued, so settle on it rather than a fixed wall-clock window (#4665).
			await awaitReplayRequests(host, 3);
			// The refusal costs the stream nothing: every sequence, exactly once, in order.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\ntwo",
				"GJC notice\nthree",
			]);
			// The cursor never moved over the un-replayed gap: the retry asks from the same
			// acknowledged sequence, and it rides the socket that is already open rather
			// than waiting for a reconnect that is not coming.
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
			expect(FakeWebSocket.instances).toHaveLength(2);
		});
	});
}, 20_000);

test("a replay refused past its retry budget rebuilds the attachment from its cursor", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");
			// Refuses the resume replay and every retry it is allowed, so the round runs out
			// of budget with the gap still open.
			host.rejectReplays = 4;

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 5);
			// The barrier has failed by now, so this frame is not published on the fenced
			// attachment — but it is in the host log, so the rebuild owes it too.
			host.emit("three");

			reconcile();
			host.accept(await awaitSocket(3));
			await awaitPosts(provider, 3);
			// The rebuild's own attach request is the sixth replay; settling on it (not a
			// wall-clock sleep) keeps the exact-array assertion below race-free under load.
			await awaitReplayRequests(host, 6);
			// The rebuild resumes the same stream instead of restarting it: nothing above the
			// cursor is skipped, and nothing at or below it is published twice.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\ntwo",
				"GJC notice\nthree",
			]);
			// Six requests: the initial attach plus five from the refused-replay retry
			// round and the rebuild. Retry-tail requests race the cursor ack of the
			// first publication (0 vs 1) by construction — what must hold everywhere
			// is the generation, the count, that the initial attach starts from 0,
			// and that the rebuilt attachment resumes from the acknowledged cursor.
			expect(host.replayRequests).toHaveLength(6);
			expect(host.replayRequests[0]).toEqual({ sinceGeneration: GENERATION, sinceSeq: 0 });
			for (const request of host.replayRequests.slice(1, 5)) {
				expect(request.sinceGeneration).toBe(GENERATION);
			}
			expect(host.replayRequests[5]).toEqual({ sinceGeneration: GENERATION, sinceSeq: 1 });
		});
	});
}, 30_000);

test("a real 256-frame host ring loses only the sequences the host says it evicted", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, warnings }) => {
		// The round's own replay answer concedes the evicted range, then the ring's
		// retained suffix is published behind it; the publication settle below is
		// what makes the post-count assertion race-free under a loaded runner.
		// #4665 CI failure: a fixed sleep read the count before the tail had been
		// published, reporting the eviction as having cost "flood tail" too.
		await withFakeTransport(async () => {
			const host = new FakeSessionHost(256);
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");
			host.stallReplay = true;

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);

			// One frame more than the barrier may hold, all on the live socket, while the
			// replay they are fenced behind never answers. The oldest and the newest carry
			// text so both ends of the buffer are observable; the rest only take slots.
			host.emit("flood head");
			for (let index = 0; index < HOLD_LIMIT - 1; index++) host.emitStream();
			host.emit("flood tail");

			host.stallReplay = false;
			reconcile();
			host.accept(await awaitSocket(3));
			await awaitReplayRequests(host, 3);
			// Cursor settlement for the first publication already happened before the drop,
			// so the middle replay's sinceSeq is 1. After this rebuild, wait for Router
			// frame-tail drain — not a completion marker or sleep — before reading posts
			// or the replay-request array (#4665 review).
			await awaitDispatchedPosts(runtime, provider, 2);
			// The replacement can retrieve only the newest 256 events, and the host says so:
			// sequences 2-771 are gone, which costs "two" and "flood head" for good. No
			// rebuild can re-fetch them, so the round concedes exactly that range and
			// publishes everything the ring did keep behind it.
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\nflood tail"]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);

			// The eviction is stated, not inferred: the round names the exact range the host
			// lost, once, and concedes nothing else in the stream.
			expect(warnings.filter(line => line.includes("conceded a retention gap"))).toEqual([
				`chat daemon replay conceded a retention gap (sequences 2-771 are gone from the host); session ${SESSION_ID} generation ${GENERATION} resumes at seq 772.`,
			]);

			// The cursor now sits above the conceded range, so the stream continues on the
			// socket it already has: no fourth dial, no fourth replay, and the next live
			// frame is published rather than fenced behind a gap nothing can close.
			host.emit("after the gap");
			await awaitPosts(provider, 3);
			reconcile();
			// The reconcile must not dial a fourth socket or issue a fourth replay; a fixed
			// window would only observe absence, so assert it after the live publication
			// has settled (the posts count above already pinned the no-rebuild outcome).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\nflood tail",
				"GJC notice\nafter the gap",
			]);
			expect(FakeWebSocket.instances).toHaveLength(3);
			expect(host.replayRequests).toHaveLength(3);
		});
	});
}, 30_000);
test("a retention gap at the initial attach keeps delivering instead of rebuilding forever", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, warnings }) => {
		await withFakeTransport(async () => {
			// A two-frame ring that has already rolled past its first event. The daemon
			// attaches from zero, so the host answers with the suffix it still holds and
			// states that sequence 1 is gone — a gap no retry and no rebuild can close.
			const host = new FakeSessionHost(2);
			host.emit("evicted one");
			host.emit("retained two");
			host.emit("retained three");

			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			// The conceded sequence is the whole loss: the retained suffix publishes in
			// order, and live delivery continues on the attachment that just conceded it.
			await awaitPosts(provider, 2);
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\nretained two",
				"GJC notice\nretained three",
			]);
			expect(warnings.filter(line => line.includes("conceded a retention gap"))).toEqual([
				`chat daemon replay conceded a retention gap (sequences 1-1 are gone from the host); session ${SESSION_ID} generation ${GENERATION} resumes at seq 2.`,
			]);
			host.emit("future four");
			await awaitPosts(provider, 3);

			// Retiring the attachment here would be permanent: every reconcile rebuilds
			// against the same evicted sequence, so the barrier would fail again on every
			// round while `transportHealthy()` still reported true and nothing shipped.
			for (let round = 0; round < 3; round++) {
				reconcile();
				await runtime.whenDispatchSettled();
			}
			// Three reconciles later the attachment must still be the original one: the
			// reconcile pass rides the fake transport's fake clock, so the sleeps above are
			// the pacing the loop needs, and the no-rebuild invariant is asserted exactly
			// once the loop has had every chance to rebuild (#4665).
			expect(runtime.transportHealthy()).toBe(true);
			expect(FakeWebSocket.instances).toHaveLength(1);
			expect(host.replayRequests).toEqual([{ sinceGeneration: GENERATION, sinceSeq: 0 }]);

			host.emit("future five");
			await awaitPosts(provider, 4);
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\nretained two",
				"GJC notice\nretained three",
				"GJC notice\nfuture four",
				"GJC notice\nfuture five",
			]);
		});
	});
}, 20_000);
test("a replay answered from a rolled generation retires the attachment instead of publishing it", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, supersede, warnings }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			// The host restarts its stream while this attachment is off the air, so the
			// resume it issues names a generation the host no longer keeps a log for.
			host.drop();
			host.roll();
			host.emit("after the roll");

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			// The round's answer retires the attachment with a generation reset warning before
			// the frame it fenced off is ever published; settle on the observable outcome
			// (the barrier-failure warning) rather than a fixed wall-clock window (#4665).
			await awaitWarning(warnings, "replay reported a generation reset");
			// A reset stream shares no sequence space with this cursor, so its events
			// cannot be ordered against it: publishing them here would deliver the new
			// generation's log once on the stale root and again on the rebuilt one.
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none"]);

			await supersede();
			reconcile();
			host.accept(await awaitSocket(3));
			// The supersession discards the retired attachment's in-flight replay; the
			// rebuild's own attach request (the third) is the last observable of that
			// discard, so settling on it — not a wall-clock window — is what makes the
			// exact array below race-free. The wait throws if the rebuild never asks
			// (#4665 review).
			await awaitReplayRequests(host, 3);
			await awaitPosts(provider, 2);
			// The rebuilt attachment owns the new generation, so the event it fenced off is
			// published there, exactly once.
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\nafter the roll"]);
			// The middle resume request races the cursor ack of the first publication
			// (0 vs 1); what must hold is the count, the generations, and that the
			// rebuilt attachment starts the rolled stream from its own beginning.
			expect(host.replayRequests).toHaveLength(3);
			expect(host.replayRequests[0]).toEqual({ sinceGeneration: GENERATION, sinceSeq: 0 });
			expect(host.replayRequests[1]?.sinceGeneration).toBe(GENERATION);
			expect(host.replayRequests[2]).toEqual({ sinceGeneration: GENERATION + 1, sinceSeq: 0 });
		});
	});
}, 20_000);

test("a replay whose gap never states its range fails the barrier instead of publishing behind it", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, warnings }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			host.emit("two");
			// The answer claims a gap without saying which sequences it covers. Nothing can
			// be concluded from it — not that the range is closed, not that it is lost.
			host.malformedGap = true;

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			// The malformed answer fails the barrier; the failure warning is the synchronous
			// completion signal, so settle on it instead of a fixed wall-clock window (#4665).
			await awaitWarning(warnings, "replay reported a gap it did not state");
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none"]);

			host.malformedGap = false;
			reconcile();
			host.accept(await awaitSocket(3));
			await awaitPosts(provider, 2);
			// The exact replay-request array below is only stable after the rebuild's
			// attach request has been issued; settle after the publication so the array is
			// read in its final state (#4665).
			await runtime.whenDispatchSettled();
			// The rebuild asks the same gap from the same cursor, and a readable answer
			// closes it: the event the unreadable one fenced off is published, once.
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\ntwo"]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
		});
	});
}, 20_000);
test("a gap that concedes sequences this cursor never asked about is refused, not skipped", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, warnings }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			host.emit("retained one");
			host.emit("retained two");
			// The daemon attaches from zero and the host returns both events it retained,
			// but the gap it states covers seq 5 — a range this request never asked about.
			// Conceding it would step the cursor to 5 and drop seq 1 and 2 as duplicates of
			// events nobody ever published.
			host.forcedGap = { kind: "sequence_gap", fromSeq: 5, toSeq: 5, resyncQueries: ["Q01"] };

			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;
			await awaitReplayRequests(host, 1);
			// The inconsistent answer fails the barrier; settle on the failure warning rather
			// than a fixed wall-clock window (#4665).
			await awaitWarning(warnings, "for a request that resumed from seq 0");
			// Nothing is published behind an answer that contradicts the request it answers,
			// and the cursor stays at zero, so nothing is conceded either.
			expect(provider.posts).toEqual([]);
			expect(warnings).toContain(
				`chat daemon replay barrier failed (replay conceded sequences 5-5 for a request that resumed from seq 0); rebuilding session ${SESSION_ID} at generation ${GENERATION} from seq 0.`,
			);
			expect(warnings.filter(line => line.includes("conceded a retention gap"))).toEqual([]);

			host.forcedGap = undefined;
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitPosts(provider, 2);
			// The exact replay-request array below is only stable after the rebuild's
			// attach request has been issued; settle after the publication so the array is
			// read in its final state (#4665).
			await runtime.whenDispatchSettled();
			// The rebuild re-asks the same cursor, and a consistent answer closes it: the
			// retained events the refused gap fenced off are published, in sequence, once.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\nretained one",
				"GJC notice\nretained two",
			]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
			]);
		});
	});
}, 20_000);

test("a gap that concedes sequences the same answer returns is refused, not skipped", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, warnings }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			host.emit("retained one");
			host.emit("retained two");
			// This gap does open where the request resumed, but it claims the same two
			// sequences the answer hands back. A host cannot have both lost and retained
			// them, so conceding the range would discard the events it arrived with.
			host.forcedGap = { kind: "sequence_gap", fromSeq: 1, toSeq: 2, resyncQueries: ["Q01"] };

			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;
			await awaitReplayRequests(host, 1);
			// The contradictory answer fails the barrier; settle on the failure warning
			// rather than a fixed wall-clock window (#4665).
			await awaitWarning(warnings, "while returning seq 1");
			expect(provider.posts).toEqual([]);
			expect(warnings).toContain(
				`chat daemon replay barrier failed (replay conceded sequences 1-2 while returning seq 1); rebuilding session ${SESSION_ID} at generation ${GENERATION} from seq 0.`,
			);
			expect(warnings.filter(line => line.includes("conceded a retention gap"))).toEqual([]);

			host.forcedGap = undefined;
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitPosts(provider, 2);
			// The exact replay-request array below is only stable after the rebuild's
			// attach request has been issued; settle after the publication so the array is
			// read in its final state (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\nretained one",
				"GJC notice\nretained two",
			]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
			]);
		});
	});
}, 20_000);

test("a conceded gap carries the cursor over the loss even when the retained suffix is filtered away", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, warnings }) => {
		await withFakeTransport(async () => {
			// A two-frame ring that evicted seq 1 and kept only capability-gated
			// sequences: the host still holds seq 2 and 3, but strips both from this
			// connection's answer. So the concession arrives with an empty suffix, and
			// nothing in the answer can carry the cursor over the range it named.
			const host = new FakeSessionHost(2);
			host.emit("evicted one");
			host.emitGated();
			host.emitGated();

			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;
			await awaitReplayRequests(host, 1);
			// The concession warning is the synchronous completion signal for the empty-suffix
			// answer; settle on it rather than a fixed wall-clock window (#4665).
			await awaitWarning(warnings, "conceded a retention gap");
			expect(provider.posts).toEqual([]);
			expect(warnings.filter(line => line.includes("conceded a retention gap"))).toEqual([
				`chat daemon replay conceded a retention gap (sequences 1-1 are gone from the host); session ${SESSION_ID} generation ${GENERATION} resumes at seq 2.`,
			]);

			host.drop();
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			host.emit("after gap");
			await awaitPosts(provider, 1);
			// The exact replay-request array below is only stable after the resume request
			// has been issued; settle after the live publication so the array is read in
			// its final state (#4665).
			await runtime.whenDispatchSettled();

			// The resume asks for the first sequence the host still holds, not the evicted
			// one already conceded: a cursor left below the gap would re-ask for it on
			// every reconnect and concede the same permanent loss again, forever.
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
			expect(warnings.filter(line => line.includes("conceded a retention gap"))).toHaveLength(1);
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\nafter gap"]);
		});
	});
}, 20_000);
test("a conceded gap publishes the sequences live delivery already carried instead of dropping them", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, warnings }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost(2);
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			// A frame the socket has carried is not a frame the runtime has ingested: ingress
			// is a queue, so the two producers can be interleaved either way around unless the
			// test pins them. This publish never returns, so every frame delivered from here
			// on is still sitting in that queue when the replay answer resolves — the exact
			// interleaving the runtime must not lose an event under.
			provider.stallPosts();
			host.emit("one");
			await awaitPosts(provider, 1);
			host.drop();
			// The replay is answered by hand below, so the round's own answer can name a
			// gap over a sequence the replacement socket has already delivered.
			host.stallReplay = true;

			reconcile();
			const replacement = await awaitSocket(2);
			host.accept(replacement);
			await awaitReplayRequests(host, 2);

			// All three ride the replacement socket ahead of the answer, and all three are
			// still queued behind the stalled publish when it arrives, so the gap the answer
			// names below covers a sequence live delivery holds and the barrier does not.
			const recoverable = host.emit("live recoverable");
			const filtered = host.emitStream();
			const tail = host.emit("tail");
			expect(host.lastReplayId).toBeDefined();
			replacement.deliver({
				type: "event_replay_result",
				id: host.lastReplayId,
				ok: true,
				events: [filtered, tail],
				gap: {
					kind: "sequence_gap",
					// The pinned publish leaves seq 1 undelivered, so this round asked from 0 and
					// its answer has to concede from the first sequence it asked for.
					fromSeq: 1,
					toSeq: Number(recoverable.seq),
					resyncQueries: ["Q01"],
				},
				generation: GENERATION,
				lastSeq: Number(tail.seq),
			});
			// The publish is pinned: the stall holds the only enqueued frame, so a microtask
			// drain is the settle the pin requires before the assertion below can observe the
			// complete picture without waiting on the stalled publish (#4665).
			await drainMicrotasks();

			// The pin holds: nothing has moved while the frames the answer reasons about are
			// still in flight, so the concession below is decided against a complete picture
			// of what live delivery carried rather than against a partially drained queue.
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none"]);

			provider.failPosts = 1;
			provider.releasePosts();
			await awaitRefusals(provider, 1);
			// The refusal retires the barrier; the failure warning is the synchronous
			// completion signal, so settle on it rather than a fixed wall-clock window
			// (#4665).
			await awaitWarning(warnings, "publication failed at seq 2");
			host.stallReplay = false;
			reconcile();
			host.accept(await awaitSocket(3));
			await awaitReplayRequests(host, 3);
			await awaitPosts(provider, 3);
			// The retained-suffix publication is the round's last observable step; the
			// concede-range warning below is emitted before the suffix publishes, so the
			// count settle above is what makes the post-order assertion race-free (#4665).

			// The host evicted the sequence, but live delivery kept it: the two producers
			// fail independently, so the concession costs only what neither of them holds.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\nlive recoverable",
				"GJC notice\ntail",
			]);
			expect(warnings.filter(line => line.includes("conceded a retention gap"))).toEqual([
				`chat daemon replay conceded a retention gap (sequences 1-2 are gone from the host, 1 of them recovered from live delivery); session ${SESSION_ID} generation ${GENERATION} resumes at seq 3.`,
			]);

			// The recovered frame did not strand the cursor below the conceded range: the
			// stream continues on the socket it already has, in sequence, exactly once.
			host.emit("after gap");
			await awaitPosts(provider, 4);
			// The exact replay-request array below is only stable after the tail has been
			// issued; the count settle above plus this settle keeps the assertion race-free
			// under load (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\nlive recoverable",
				"GJC notice\ntail",
				"GJC notice\nafter gap",
			]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 2 },
			]);
			expect(warnings.filter(line => line.includes("publication failed at seq 2"))).toHaveLength(1);
		});
	});
}, 20_000);

test("a frame the surface refused stays above the cursor and is re-served by the next replay", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, warnings, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			// One transient refusal from the surface. Nothing published this sequence, so
			// the cursor — whose only job is recording what was delivered — must still sit
			// below it when the next replay asks.
			provider.failPosts = 1;
			host.emit("two");
			await awaitRefusals(provider, 1);
			// The refusal retires the barrier; the failure warning is the synchronous
			// completion signal, so settle on it rather than a fixed wall-clock window
			// (#4665).
			await awaitWarning(warnings, "publication failed at seq 2");

			host.drop();
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);

			// The refused frame is re-served and published, once, in sequence.
			await awaitPosts(provider, 2);
			// A late duplicate would land after the second publication; the no-double-
			// publication invariant is a window, so settle once more after the count
			// (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\ntwo"]);
			expect(warnings.filter(line => line.includes("publication failed at seq 2"))).toHaveLength(1);
		});
	});
}, 20_000);

test("an ambiguously acknowledged Slack session-ready publication is not posted twice", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			provider.acceptThenThrowPosts = 1;
			host.emitSessionReady();
			await awaitDispatchedPosts(runtime, provider, 1);

			host.drop();
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			// The ambiguous-ack reconciliation retry is the only observable trace; settle on
			// the attempt ledger rather than a fixed wall-clock window. The wait throws if
			// the retry never happens, so the retry this test exists to cover is pinned at
			// exactly two attempts on one clientMsgId (#4665 review).
			await awaitPostAttempts(provider, "GJC session ready.", 2);

			expect(provider.posts.map(post => post.text)).toEqual(["GJC session ready."]);
			expect(provider.postAttempts.filter(post => post.text === "GJC session ready.")).toHaveLength(2);
			expect(
				provider.postAttempts
					.filter(post => post.text === "GJC session ready.")
					.every(post => post.clientMsgId === provider.posts[0]?.clientMsgId),
			).toBe(true);
		});
	});
}, 20_000);
test("an ambiguously acknowledged Discord session-ready publication is not posted twice", async () => {
	await withAttachedDiscordRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async clock => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			provider.acceptThenThrowPosts = 1;
			host.emitSessionReady();
			await awaitDiscordPosts(provider, 1);
			await runtime.whenDispatchSettled();

			host.drop();
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			await awaitDiscordPostCount(provider, 1);
			// The retry that proves the ambiguous publication was reconciled rides the
			// daemon's lease-recovery timer, which the fake transport's clock owns. Let the
			// provider answer the next reconciliation (the nonce already posted resolves
			// through #messagesByNonce), then fire the timer past its recovery bound: the
			// probe count is the observable that the retry ran, and the single post plus
			// the shared nonce are the no-double-publication invariant (#4665 review).
			provider.reconciliationFailureNonce = undefined;
			for (let i = 0; i < 10; i++) {
				await Bun.sleep(30);
				clock.advanceBy(20_000);
			}
			for (let attempt = 0; attempt < 8_000 && provider.reconcileProbes < 2; attempt++) await Bun.sleep(1);
			expect(provider.reconcileProbes).toBeGreaterThanOrEqual(2);
			expect(provider.posts.map(post => post.content)).toEqual(["GJC session ready."]);
			expect(provider.posts[0]?.nonce).toBeDefined();
		});
	});
}, 20_000);
test("an ambiguously acknowledged publication is not posted twice when reconciliation fails", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile, agentDir }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			provider.acceptThenThrowPosts = 1;
			host.emit("two");
			await awaitDispatchedPosts(runtime, provider, 2);

			host.drop();
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			// The ambiguous-ack reconciliation retry is only observable on the attempt
			// ledger the daemon's lease-recovery timer drives; settle on it rather than a
			// wall-clock window (#4665). The retry's own completion is the journal's
			// terminal state, so the idempotency assertion below settles on it.
			await awaitPostAttempts(provider, "GJC notice\ntwo", 2);
			await awaitSlackEffectState(agentDir, "GJC notice\ntwo", "terminal");

			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\ntwo"]);
			expect(
				provider.postAttempts.filter(post => post.text === "GJC notice\ntwo").map(post => post.clientMsgId),
			).toEqual([provider.posts[1]?.clientMsgId, provider.posts[1]?.clientMsgId]);
		});
	});
}, 20_000);
test("a surface that refuses a frame for good concedes it instead of wedging the stream", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, warnings, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			// The surface is down for good. Holding the cursor below seq 2 forever would
			// cost every later frame too, so the rounds are bounded: mirrors
			// `DELIVERY_ATTEMPT_LIMIT`, one round live and two from a rebuild's replay.
			provider.failPosts = Number.POSITIVE_INFINITY;
			host.emit("two");
			for (let round = 2; round <= 3; round++) {
				await awaitRefusals(provider, round - 1);
				await runtime.whenDispatchSettled();
				reconcile();
				host.accept(await awaitSocket(round));
			}
			await awaitRefusals(provider, 3);
			await runtime.whenDispatchSettled();

			// Every round re-served that same sequence from the same cursor, and the last
			// one conceded it rather than asking again.
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
			expect(warnings.filter(line => line.includes("conceded seq 2"))).toHaveLength(1);

			// The stream is not wedged: it resumes above the conceded frame on the socket
			// it already holds, with no further rebuild.
			provider.failPosts = 0;
			host.emit("three");
			await awaitPosts(provider, 2);
			// The socket-count assertion below is a no-rebuild window; settle after the
			// live publication so the reconcile that would have rebuilt has had its chance
			// (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\nthree"]);
			expect(FakeWebSocket.instances).toHaveLength(3);
		});
	});
}, 20_000);

test("a rolled endpoint's first frame gets its own delivery budget, not the previous generation's", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, warnings, reconcile, supersede }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			// Two rounds spent on this generation's seq 1 — one short of conceding it.
			provider.failPosts = 2;
			host.emit("old one");
			await awaitRefusals(provider, 1);
			// The refusal retires the barrier; the failure warning is the synchronous
			// completion signal, so settle on it rather than a fixed wall-clock window
			// (#4665).
			await awaitWarning(warnings, "publication failed at seq 1");
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitRefusals(provider, 2);
			await awaitWarning(warnings, "publication failed at seq 1");

			// The endpoint rolls, so the replacement attachment opens a fresh sequence space
			// whose seq 1 is a different frame. The rounds the old stream spent buy it
			// nothing: charging them here would concede a frame refused exactly once.
			await supersede();
			host.roll();
			provider.failPosts = 1;
			reconcile();
			host.accept(await awaitSocket(3));
			await awaitReplayRequests(host, 3);
			host.emit("new one");
			await awaitRefusals(provider, 3);
			// The refusal retires the barrier at the new generation; settle on its failure
			// warning rather than a fixed wall-clock window (#4665). The retry round the
			// old generation's budget left is consumed first, so the stale-generation
			// warning precedes this one; what matters is the freshest warning carries the
			// new generation.
			await awaitWarning(warnings, "generation 5");
			expect(warnings.filter(line => line.includes("conceded seq"))).toEqual([]);
			expect(warnings).toContain(
				`chat daemon replay barrier failed (publication failed at seq 1 (slack provider is unavailable)); rebuilding session ${SESSION_ID} at generation ${GENERATION + 1} from seq 0.`,
			);

			// Refused once, so it still sits above the cursor and the rebuild re-serves it.
			reconcile();
			host.accept(await awaitSocket(4));
			await awaitPosts(provider, 1);
			// The exact replay-request array below is only stable after the rebuild's
			// attach request has been issued; settle after the publication so the array is
			// read in its final state (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\nnew one"]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION + 1, sinceSeq: 0 },
				{ sinceGeneration: GENERATION + 1, sinceSeq: 0 },
			]);
		});
	});
}, 20_000);
test("a frame queued behind a failed publication cannot advance the cursor past it", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, warnings, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitDispatchedPosts(runtime, provider, 1);

			// A later frame is already queued behind the failing one. The rollback a
			// naive fix would apply is defeated here: `enqueueFrame` swallows the
			// rejection, so the later frame runs. Only retiring the attachment on
			// failure prevents its cursor from advancing past the undelivered sequence.
			provider.failPosts = 1;
			host.emit("two");
			host.emit("three");
			await awaitRefusals(provider, 1);
			// Wait for the runtime to retire the attachment, not just for the surface to
			// refuse: the failure warning is the synchronous completion signal from
			// `#failDelivery` → `#failBarrier`, and reconciling before it arrives races a
			// replay the delayed retirement would still discard.
			for (
				let attempt = 0;
				attempt < 8_000 && !warnings.some(line => line.includes("publication failed at seq 2"));
				attempt++
			)
				await Bun.sleep(1);
			expect(warnings.some(line => line.includes("publication failed at seq 2"))).toBe(true);

			// The cursor sits at seq 1 — below the failed publication — not at seq 2 or 3.
			host.drop();
			reconcile();
			host.accept(await awaitSocket(2));
			await awaitReplayRequests(host, 2);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);

			// The failed frame is re-served and published, and the frame queued behind it
			// follows in order. Neither is permanently lost or duplicated.
			await awaitPosts(provider, 3);
			// A late duplicate would land after the third publication; the no-double-
			// publication invariant is a window, so settle once more after the count
			// (#4665).
			await runtime.whenDispatchSettled();
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\ntwo",
				"GJC notice\nthree",
			]);
			expect(warnings.filter(line => line.includes("publication failed at seq 2"))).toHaveLength(1);
		});
	});
}, 20_000);
