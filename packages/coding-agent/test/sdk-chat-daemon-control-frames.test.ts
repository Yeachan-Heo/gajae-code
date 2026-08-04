import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { ChatDaemonRuntime, type ChatDaemonSdkClient } from "../src/sdk/bus/chat-daemon-runtime";
import { ConversationStore } from "../src/sdk/bus/conversation-store";
import type { SlackConversation } from "../src/sdk/bus/slack-conversation";
import type { SlackProviderClient } from "../src/sdk/bus/slack-provider";
import { SESSION_PREPARED_EVENT } from "../src/sdk/host";

const SESSION_ID = "control-frame-session";
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
 * The exact protocol answer `ChatDaemonRuntime.attach()` provokes on every
 * attachment: `SdkClient` settles the pending `event_replay` request and still
 * forwards the same frame to every observer.
 */
const EVENT_REPLAY_RESULT_FRAME = {
	type: "event_replay_result",
	id: "replay-1",
	ok: true,
	events: [],
	generation: GENERATION,
	lastSeq: 0,
};

const PREPARED_FRAME = {
	type: "event",
	name: SESSION_PREPARED_EVENT,
	sessionId: SESSION_ID,
	generation: GENERATION,
};

const READY_FRAME = {
	type: "event",
	name: "session_ready",
	sessionId: SESSION_ID,
	generation: GENERATION,
};

type FrameDeliveryMode = "replay" | "live";

interface RuntimeHarness {
	provider: FakeSlackProvider;
	store: ConversationStore<SlackConversation>;
	deliver: (frame: Record<string, unknown>) => void;
	/** Settles every queued frame by observing the publications a live frame produces. */
	awaitPosts: (count: number) => Promise<void>;
	awaitFirstPublication: () => Promise<void>;
}

async function withRuntime(
	replayEvents: Array<Record<string, unknown>>,
	run: (input: RuntimeHarness) => Promise<void>,
): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-chat-control-frames-"));
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
		let observer: ((frame: Record<string, unknown>) => void) | undefined;
		const client: ChatDaemonSdkClient = {
			onFrame: handler => {
				observer = handler;
				return () => {
					observer = undefined;
				};
			},
			request: async () => ({ ...EVENT_REPLAY_RESULT_FRAME, events: replayEvents }),
			close: async () => undefined,
			send: () => undefined,
		};
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
				createClient: async () => client,
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => undefined) as unknown as typeof clearInterval,
			},
		);
		await runtime.start();
		const awaitPosts = async (count: number): Promise<void> => {
			// Frames for one session are processed strictly in order, so a
			// publication produced by the last frame proves every earlier frame
			// already ran to completion.
			for (let attempt = 0; attempt < 2_000 && provider.posts.length < count; attempt++) await Bun.sleep(1);
		};
		await run({
			provider,
			store: new ConversationStore<SlackConversation>({ agentDir, kind: "slack" }),
			deliver: frame => observer?.(frame),
			awaitPosts,
			awaitFirstPublication: async () => await awaitPosts(1),
		});
	} finally {
		await runtime?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

describe("chat daemon control-plane frame containment", () => {
	test("replayed control-plane frames publish no root, message, or mapping", async () => {
		// `attach()` awaits every replayed frame before `start()` resolves, so this
		// assertion observes a settled replay path.
		await withRuntime(
			[{ ...EVENT_REPLAY_RESULT_FRAME }, { ...PREPARED_FRAME }, { ...PREPARED_FRAME, generation: GENERATION + 1 }],
			async ({ provider, store }) => {
				expect(provider.posts).toEqual([]);
				expect(Object.keys((await store.load()).conversations)).toEqual([]);
			},
		);
	});

	test("live control-plane frames publish nothing while a real readiness signal still does", async () => {
		await withRuntime([], async ({ provider, store, deliver, awaitFirstPublication }) => {
			deliver({ ...EVENT_REPLAY_RESULT_FRAME });
			deliver({ ...PREPARED_FRAME });
			deliver({ ...PREPARED_FRAME, generation: GENERATION + 1 });
			deliver({
				type: "event",
				kind: "notification",
				sessionId: SESSION_ID,
				generation: GENERATION,
				payload: { ...EVENT_REPLAY_RESULT_FRAME },
			});
			deliver({ ...READY_FRAME });
			await awaitFirstPublication();

			// Exactly one publication exists and it is the readiness root, so every
			// control-plane frame ahead of it produced no post, root, or mapping.
			expect(provider.posts).toHaveLength(1);
			expect(provider.posts[0]?.threadTs).toBeUndefined();
			const mappings = Object.values((await store.load()).conversations);
			expect(mappings).toHaveLength(1);
			expect(mappings[0]).toMatchObject({ sessionId: SESSION_ID, endpointGeneration: GENERATION });
		});
	});
});

/**
 * One event frame carries at most one authority. An event envelope and its
 * payload — and the envelope's own `name`/`kind` aliases — are representations
 * of the same event, so a frame that states a different session, generation, or
 * reserved identity in each is not a usable event at all: it is an attempt to
 * have one representation clear a filter while the other supplies the identity a
 * later step consumes.
 */
describe("chat daemon event envelope correlation", () => {
	/** A valid ordinary wrapper: outer transport name, payload event body. */
	function sentinel(text: string): Record<string, unknown> {
		return {
			type: "event",
			name: "notification",
			sessionId: SESSION_ID,
			generation: GENERATION,
			payload: { type: "marker", sessionId: SESSION_ID, text },
		};
	}

	const LIFECYCLE_EVENTS = [SESSION_PREPARED_EVENT, "session_ready", "session_closed", "session_terminated"] as const;

	async function withFrames(
		mode: FrameDeliveryMode,
		frames: Array<Record<string, unknown>>,
		assert: (harness: RuntimeHarness) => Promise<void>,
	): Promise<void> {
		await withRuntime(mode === "replay" ? frames : [], async harness => {
			if (mode === "live") for (const frame of frames) harness.deliver(frame);
			await assert(harness);
		});
	}

	/**
	 * A post is recorded while its mapping is still `posting_root`, so settling
	 * waits for the publication *and* for the mapping it produces to reach its
	 * terminal state before anything is asserted.
	 */
	async function settle(harness: RuntimeHarness, posts: number): Promise<void> {
		await harness.awaitPosts(posts);
		for (let attempt = 0; attempt < 2_000; attempt++) {
			const records = Object.values((await harness.store.load()).conversations);
			if (records.length > 0 && records.every(record => record.state === "active")) return;
			await Bun.sleep(1);
		}
	}

	/**
	 * The frame under test is delivered before an ordinary sentinel on the same
	 * session's serialized frame tail, so the sentinel's own publication proves
	 * the frame was already handled — and published nothing of its own.
	 */
	async function expectInert(frame: Record<string, unknown>, mode: FrameDeliveryMode): Promise<void> {
		await withFrames(mode, [frame, sentinel("ordering-sentinel")], async harness => {
			const { provider, store } = harness;
			await settle(harness, 1);
			expect(provider.posts).toHaveLength(1);
			expect(provider.posts[0]?.text).toContain("ordering-sentinel");
			expect(provider.posts[0]?.threadTs).toBeUndefined();
			const mappings = Object.values((await store.load()).conversations);
			expect(mappings).toHaveLength(1);
			expect(mappings[0]).toMatchObject({ state: "active", sessionId: SESSION_ID, endpointGeneration: GENERATION });
		});
	}

	/**
	 * Closure and resume are only observable against a mapping that already
	 * exists, so the same frame is also delivered behind an established root.
	 */
	async function expectInertAgainstActiveRoot(frame: Record<string, unknown>, mode: FrameDeliveryMode): Promise<void> {
		await withFrames(mode, [sentinel("first"), frame, sentinel("second")], async harness => {
			const { provider, store } = harness;
			await settle(harness, 2);
			expect(provider.posts).toHaveLength(2);
			expect(provider.posts[0]?.text).toContain("first");
			expect(provider.posts[0]?.threadTs).toBeUndefined();
			expect(provider.posts[1]?.text).toContain("second");
			// A close would have retired the mapping and a resume would have
			// published a second root; the reply threaded into the first root
			// instead, whose timestamp the fake provider issues as `7.1`.
			expect(provider.posts[1]?.threadTs).toBe("7.1");
			const mappings = Object.values((await store.load()).conversations);
			expect(mappings).toHaveLength(1);
			expect(mappings[0]).toMatchObject({
				state: "active",
				sessionId: SESSION_ID,
				endpointGeneration: GENERATION,
			});
		});
	}

	for (const mode of ["replay", "live"] as const) {
		/**
		 * The envelope's two spellings are aliases, not two authorities. Preferring
		 * `name` lets a benign transport name clear control-plane filtering while
		 * `kind` carries the reserved discriminant a later step consumes.
		 */
		test(`an envelope whose name and kind aliases disagree is inert (${mode})`, async () => {
			for (const aliases of [
				{ name: "notification", kind: "event_replay_result" },
				{ name: "event_replay_result", kind: "notification" },
				{ name: "notification", kind: "session_closed" },
				{ name: "session_ready", kind: "notification" },
				{ name: "notification", kind: 7 },
				{ name: undefined, kind: "notification" },
			])
				await expectInert({ type: "event", ...aliases, sessionId: SESSION_ID, generation: GENERATION }, mode);
		}, 30_000);

		test(`a control-plane payload under an ordinary envelope is inert (${mode})`, async () => {
			await expectInert(
				{
					type: "event",
					name: "notification",
					sessionId: SESSION_ID,
					generation: GENERATION,
					payload: { ...EVENT_REPLAY_RESULT_FRAME },
				},
				mode,
			);
		});

		for (const lifecycle of LIFECYCLE_EVENTS) {
			test(`a payload-smuggled ${lifecycle} under an ordinary envelope is inert (${mode})`, async () => {
				const smuggled = {
					type: "event",
					name: "notification",
					sessionId: SESSION_ID,
					generation: GENERATION,
					payload: { type: lifecycle, sessionId: SESSION_ID, generation: GENERATION },
				};
				await expectInert(smuggled, mode);
				await expectInertAgainstActiveRoot(smuggled, mode);
			}, 20_000);
		}

		test(`a foreign outer session cannot resume through an attached payload session id (${mode})`, async () => {
			await expectInert(
				{
					type: "event",
					name: "session_ready",
					sessionId: "foreign-session",
					generation: GENERATION,
					payload: { type: "session_ready", sessionId: SESSION_ID, generation: GENERATION },
				},
				mode,
			);
		});

		test(`a frame whose envelope and payload disagree on session id is inert (${mode})`, async () => {
			await expectInert(
				{
					type: "event",
					name: "notification",
					sessionId: SESSION_ID,
					generation: GENERATION,
					payload: { type: "marker", sessionId: "session-2", text: "conflicting-session-id" },
				},
				mode,
			);
		});

		test(`a frame whose envelope and payload disagree on generation is inert (${mode})`, async () => {
			for (const frame of [
				{
					type: "event",
					name: "session_ready",
					sessionId: SESSION_ID,
					generation: GENERATION,
					payload: { type: "session_ready", sessionId: SESSION_ID, generation: GENERATION - 1 },
				},
				{
					type: "event",
					name: "notification",
					sessionId: SESSION_ID,
					generation: GENERATION,
					payload: { type: "marker", sessionId: SESSION_ID, generation: GENERATION - 1, text: "conflict" },
				},
			])
				await expectInert(frame, mode);
		}, 20_000);

		/**
		 * A duplicate that cannot be the identity it claims is never read as an
		 * absent duplicate: reading it as absence silently promotes the other
		 * representation to sole authority over a frame that stated two.
		 */
		test(`a duplicated identity that is present but malformed is inert (${mode})`, async () => {
			for (const generation of ["4", 4.5, -1, null, true, undefined])
				await expectInert(
					{
						type: "event",
						name: "notification",
						sessionId: SESSION_ID,
						generation: GENERATION,
						payload: { type: "marker", sessionId: SESSION_ID, generation, text: "malformed-generation" },
					},
					mode,
				);
			for (const sessionId of [7, "", null, false, undefined])
				await expectInert(
					{
						type: "event",
						name: "notification",
						sessionId: SESSION_ID,
						generation: GENERATION,
						payload: { type: "marker", sessionId, text: "malformed-session-id" },
					},
					mode,
				);
		}, 60_000);

		test(`equal duplicates and one-sided identities still deliver exactly once (${mode})`, async () => {
			await withFrames(
				mode,
				[
					{
						type: "event",
						name: "notification",
						sessionId: SESSION_ID,
						generation: GENERATION,
						payload: {
							type: "marker",
							sessionId: SESSION_ID,
							generation: GENERATION,
							text: "agreed-duplicate",
						},
					},
				],
				async harness => {
					const { provider, store } = harness;
					await settle(harness, 1);
					expect(provider.posts).toHaveLength(1);
					expect(provider.posts[0]?.text).toContain("agreed-duplicate");
					expect(Object.values((await store.load()).conversations)).toHaveLength(1);
				},
			);
		});

		test(`a canonical prepared-then-ready sequence still publishes exactly one root (${mode})`, async () => {
			await withFrames(mode, [{ ...PREPARED_FRAME }, { ...READY_FRAME }], async harness => {
				const { provider, store } = harness;
				await settle(harness, 1);
				expect(provider.posts).toHaveLength(1);
				expect(provider.posts[0]?.threadTs).toBeUndefined();
				const mappings = Object.values((await store.load()).conversations);
				expect(mappings).toHaveLength(1);
				expect(mappings[0]).toMatchObject({ sessionId: SESSION_ID, endpointGeneration: GENERATION });
			});
		});
	}
});
