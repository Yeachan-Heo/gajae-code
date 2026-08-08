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
		const event = {
			type: "event",
			kind: "notice",
			sessionId: SESSION_ID,
			generation: this.#generation,
			seq: this.#log.length + 1,
			payload: { type: "notice", text },
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
		const sinceSeq = typeof frame.sinceSeq === "number" ? frame.sinceSeq : 0;
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
