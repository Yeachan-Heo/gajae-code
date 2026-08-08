import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ChatDaemonRuntime } from "../src/sdk/bus/chat-daemon-runtime";
import { HEARTBEAT_TTL_MS } from "../src/sdk/bus/daemon-paths";
import type { SlackProviderClient } from "../src/sdk/bus/slack-provider";
import { ACP_SESSION_RECONNECT } from "../src/sdk/session-reconnect";
import { drainReconnects, expectedBackoffs, FakeWebSocket, withFakeTransport } from "./helpers/fake-sdk-transport";

const SESSION_ID = "chat-reconnect-session";
const GENERATION = 4;
/**
 * Mirrors `REPLAY_BARRIER_LIMIT`: how many live frames one attachment holds behind an
 * outstanding replay. Too low a mirror still overflows the real barrier; too high a real
 * limit leaves the flood below it, and the test fails on the frames that never arrive.
 */
const HOLD_LIMIT = 1_024;

class FakeSlackProvider implements SlackProviderClient {
	posts: Array<{ channel: string; text: string; threadTs?: string; clientMsgId: string }> = [];
	readonly transportHealthy = true;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async ack(): Promise<void> {}

	async postMessage(input: {
		channel: string;
		text: string;
		threadTs?: string;
		clientMsgId: string;
	}): Promise<{ channel: string; ts: string; client_msg_id: string }> {
		this.posts.push(input);
		return { channel: input.channel, ts: `7.${this.posts.length}`, client_msg_id: input.clientMsgId };
	}

	async findMessageByClientMsgId(): Promise<null> {
		return null;
	}

	async findMessageByTimestamp(): Promise<null> {
		return null;
	}
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
	/** Refuses this many replays with a typed error, leaving the socket that carried them open. */
	rejectReplays = 0;
	#generation = GENERATION;
	#log: Array<Record<string, unknown>> = [];
	#connections = 0;
	#socket: FakeWebSocket | undefined;

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

	/**
	 * Records one live turn-stream event. It owns a sequence, so the barrier orders it
	 * like any other, but presentation drops it — it costs a hold slot and nothing else.
	 */
	emitStream(): Record<string, unknown> {
		return this.#record("turn_stream", { type: "turn_stream", phase: "live" });
	}

	#record(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
		const event = {
			type: "event",
			kind,
			sessionId: SESSION_ID,
			generation: this.#generation,
			seq: this.#log.length + 1,
			payload,
		};
		this.#log.push(event);
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
	}

	#answer(socket: FakeWebSocket, data: string): void {
		const frame = JSON.parse(data) as Record<string, unknown>;
		if (frame.type !== "event_replay") return;
		this.replayRequests.push({ sinceGeneration: frame.sinceGeneration, sinceSeq: frame.sinceSeq });
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
		const events =
			frame.sinceGeneration === this.#generation
				? this.#log.filter(event => Number(event.seq) > sinceSeq)
				: [...this.#log];
		queueMicrotask(() =>
			socket.deliver({
				type: "event_replay_result",
				id: frame.id,
				ok: true,
				events,
				generation: this.#generation,
				lastSeq: this.#log.length,
			}),
		);
	}
}

interface AttachedRuntimeHarness {
	runtime: ChatDaemonRuntime;
	provider: FakeSlackProvider;
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
	try {
		const stateRoot = path.join(agentDir, ".gjc", "state");
		const endpointFile = path.join(stateRoot, "sdk", `${SESSION_ID}.json`);
		await fs.mkdir(path.dirname(endpointFile), { recursive: true });
		await fs.writeFile(
			endpointFile,
			`${JSON.stringify({ version: 1, url: "ws://localhost:1/", token: "not-persisted", pid: process.pid })}\n`,
		);
		const endpointMtimeMs = (await fs.stat(endpointFile)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: SESSION_ID,
			locator: { repo: agentDir, stateRoot },
			endpointGeneration: GENERATION,
			pid: process.pid,
			endpointMtimeMs,
		});

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
				setInterval: ((callback: () => void) => {
					reconcileTick = callback;
					return 0;
				}) as unknown as typeof setInterval,
				clearInterval: (() => undefined) as unknown as typeof clearInterval,
			},
		);
		await run({
			runtime,
			provider,
			reconcile: () => reconcileTick?.(),
			supersede: async () => {
				await index.append({
					type: "host_registered",
					sessionId: SESSION_ID,
					locator: { repo: agentDir, stateRoot },
					endpointGeneration: GENERATION + 1,
					pid: process.pid,
					endpointMtimeMs,
				});
			},
		});
	} finally {
		await runtime?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

/** The runtime does its index and endpoint IO before it dials, so wait for the dial. */
async function awaitSocket(count: number): Promise<FakeWebSocket> {
	for (let attempt = 0; attempt < 2_000 && FakeWebSocket.instances.length < count; attempt++) await Bun.sleep(1);
	expect(FakeWebSocket.instances).toHaveLength(count);
	return FakeWebSocket.instances[count - 1]!;
}

/** Delivery is observable only where it lands, so settle on the publications themselves. */
async function awaitPosts(provider: FakeSlackProvider, count: number): Promise<void> {
	for (let attempt = 0; attempt < 2_000 && provider.posts.length < count; attempt++) await Bun.sleep(1);
	expect(provider.posts).toHaveLength(count);
}

/** The replay rides the socket, so settle on the request the host itself observed. */
async function awaitReplayRequests(host: FakeSessionHost, count: number): Promise<void> {
	for (let attempt = 0; attempt < 2_000 && host.replayRequests.length < count; attempt++) await Bun.sleep(1);
	expect(host.replayRequests).toHaveLength(count);
}

test("an attached chat session reconnects on a budget that outlives the host heartbeat TTL", async () => {
	await withAttachedSessionRuntime(async ({ runtime }) => {
		await withFakeTransport(async clock => {
			const starting = runtime.start();
			await awaitSocket(1);
			const observed = await drainReconnects(clock);
			await expect(starting).rejects.toMatchObject({ code: "reconnect_exhausted" });

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
			await awaitPosts(provider, 1);

			// Drop the already-attached, already-active socket, then keep the session
			// producing: these events exist only in the host's log until delivery resumes.
			host.drop();
			host.emit("during the outage");

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitPosts(provider, 2);

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
			await awaitPosts(provider, 1);

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
			await awaitPosts(provider, 1);

			host.drop();
			host.emit("two");

			reconcile();
			// The replacement hello starts the replay, and this frame is delivered on the
			// replacement socket before that replay can answer: two producers, one stream.
			// Nothing here waits for the replay, which is exactly the window the barrier owns.
			host.accept(await awaitSocket(2));
			host.emit("three");

			await awaitPosts(provider, 3);
			// Settle first: a late duplicate lands after the third publication, so asserting
			// on the count alone would read the stream before it can go wrong.
			await Bun.sleep(20);
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
			await awaitPosts(provider, 1);

			host.drop();
			host.emit("two");
			// A host that answers from one sequence too far back re-offers an event this
			// attachment already acknowledged. The cursor settles delivery, so it is dropped.
			host.replayRewind = 1;

			reconcile();
			host.accept(await awaitSocket(2));
			await awaitPosts(provider, 2);
			await Bun.sleep(20);
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
			await awaitPosts(provider, 1);

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
			await Bun.sleep(20);
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
			await awaitPosts(provider, 1);

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
			await Bun.sleep(20);
			expect(provider.posts.map(post => post.text)).toEqual(["GJC notice\none", "GJC notice\nafter the roll"]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION + 1, sinceSeq: 0 },
			]);
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
			await awaitPosts(provider, 1);

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
			await Bun.sleep(20);
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
			await awaitPosts(provider, 1);

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
			await Bun.sleep(20);
			// The rebuild resumes the same stream instead of restarting it: nothing above the
			// cursor is skipped, and nothing at or below it is published twice.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\ntwo",
				"GJC notice\nthree",
			]);
			// Every request after the initial attach asks from the last acknowledged
			// sequence, including the one the rebuilt attachment issues.
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
		});
	});
}, 30_000);

test("a hold buffer that overflows re-fetches the gap instead of skipping the frame the cursor needs next", async () => {
	await withAttachedSessionRuntime(async ({ runtime, provider, reconcile }) => {
		await withFakeTransport(async () => {
			const host = new FakeSessionHost();
			const starting = runtime.start();
			host.accept(await awaitSocket(1));
			await starting;

			host.emit("one");
			await awaitPosts(provider, 1);

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
			await awaitPosts(provider, 4);
			await Bun.sleep(20);
			// Overflow re-fetches the gap from the cursor rather than evicting inside it:
			// "flood head" is the oldest held frame and the one the cursor needs first, and
			// it is still published, in sequence, ahead of the frame that overflowed it.
			expect(provider.posts.map(post => post.text)).toEqual([
				"GJC notice\none",
				"GJC notice\ntwo",
				"GJC notice\nflood head",
				"GJC notice\nflood tail",
			]);
			expect(host.replayRequests).toEqual([
				{ sinceGeneration: GENERATION, sinceSeq: 0 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
				{ sinceGeneration: GENERATION, sinceSeq: 1 },
			]);
		});
	});
}, 30_000);
