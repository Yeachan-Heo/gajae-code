import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import {
	type ChatDaemonCommandHandler,
	type ChatDaemonCommandOwner,
	serveChatDaemonCommandsOnce,
	submitChatDaemonCommand,
} from "../src/sdk/bus/chat-daemon-command-channel";
import { chatDaemonGeneration, chatDaemonIdentity, chatDaemonPaths } from "../src/sdk/bus/chat-daemon-control";
import { ConversationStore, type ConversationStoreFs, conversationStorePath } from "../src/sdk/bus/conversation-store";
import { type SlackConversation, slackConversationKey } from "../src/sdk/bus/slack-conversation";
import { type SlackEndpoint, SlackNotificationDaemon } from "../src/sdk/bus/slack-daemon";
import { SlackProviderError } from "../src/sdk/bus/slack-live-provider";
import { SlackProvider } from "../src/sdk/bus/slack-provider";
import {
	bindConfiguredSlackThread,
	isBoundedSlackRootTs,
	SlackThreadBindingError,
} from "../src/sdk/bus/slack-thread-binding";

const TEAM = "T1";
const CHANNEL = "C1";
const EXISTING_ROOT = "1785573662.132329";
const SECOND_ROOT = "1785573662.132330";

class FakeSlack {
	posts: Array<{ channel: string; text: string; threadTs?: string; clientMsgId: string }> = [];
	knownTimestamps = new Set<string>([EXISTING_ROOT, SECOND_ROOT]);
	timestampLookups: Array<{ channel: string; ts: string }> = [];
	failTimestampLookup = false;

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
		return { channel: input.channel, ts: `9.${this.posts.length}`, client_msg_id: input.clientMsgId };
	}

	async findMessageByClientMsgId(): Promise<null> {
		return null;
	}

	async findMessageByTimestamp(input: {
		channel: string;
		ts: string;
	}): Promise<{ channel: string; ts: string } | null> {
		this.timestampLookups.push(input);
		if (this.failTimestampLookup) throw new SlackProviderError("connection", "conversations.replies");
		return this.knownTimestamps.has(input.ts) ? { channel: input.channel, ts: input.ts } : null;
	}
}

function endpoint(sessionId: string, generation: number): SlackEndpoint {
	return { sessionId, url: "ws://localhost", token: "not-persisted", path: "", generation };
}

function intentKey(sessionId: string): string {
	return slackConversationKey({ teamId: TEAM, channelId: CHANNEL, rootTs: `intent:${sessionId}` });
}

/**
 * A persistence seam whose parent-directory durability barrier fails *after* the
 * document rename applied. It is the exact shape of the real hazard: the
 * replacement is already the store's visible document when the failure is
 * raised, so the mapping may exist even though the call throws.
 */
function parentSyncFailingFs(directory: string): ConversationStoreFs & { failParentSync: boolean } {
	const seam: ConversationStoreFs & { failParentSync: boolean } = {
		failParentSync: false,
		mkdir: async (target, options) => await fs.mkdir(target, options),
		chmod: async (target, mode) => await fs.chmod(target, mode),
		readFile: async (file, encoding) => await fs.readFile(file, encoding),
		writeFile: async (file, data, options) => await fs.writeFile(file, data, options),
		rename: async (from, to) => await fs.rename(from, to),
		unlink: async file => await fs.unlink(file),
		stat: async file => await fs.stat(file),
		open: async (file, flags) => {
			const handle = await fs.open(file, flags);
			if (file !== directory || !seam.failParentSync) return handle;
			return {
				sync: async () => {
					await handle.close();
					throw Object.assign(new Error("simulated parent directory barrier failure"), { code: "EIO" });
				},
				close: async () => undefined,
				writeFile: async (data, encoding) => await handle.writeFile(data, encoding),
			};
		},
	};
	return seam;
}

async function withDaemon(
	run: (input: {
		daemon: SlackNotificationDaemon;
		fake: FakeSlack;
		store: ConversationStore<SlackConversation>;
		agentDir: string;
		setGeneration: (generation: number) => void;
	}) => Promise<void>,
	createStore?: (agentDir: string) => ConversationStore<SlackConversation>,
): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-bind-"));
	let daemon: SlackNotificationDaemon | undefined;
	try {
		const fake = new FakeSlack();
		let generation = 3;
		let id = 0;
		daemon = new SlackNotificationDaemon({
			agentDir,
			repo: agentDir,
			teamId: TEAM,
			channelId: CHANNEL,
			provider: new SlackProvider(fake),
			randomId: () => `client-id-${++id}`,
			createClient: () => ({ send: () => undefined }),
			resolveEndpoint: async sessionId => endpoint(sessionId, generation),
			...(createStore ? { store: createStore(agentDir) } : {}),
		});
		await run({
			daemon,
			fake,
			// Assertions always read through an unmodified store: the durable
			// document is the authority, never the seam under test.
			store: new ConversationStore<SlackConversation>({ agentDir, kind: "slack" }),
			agentDir,
			setGeneration: value => {
				generation = value;
			},
		});
	} finally {
		await daemon?.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

describe("slack existing-root adoption", () => {
	test("bounded root timestamps are the only addressable ones", () => {
		expect(isBoundedSlackRootTs(EXISTING_ROOT)).toBe(true);
		for (const value of ["", ".", "1785573662", "17855736620000000.1", "1785573662.13a", "../etc", "1.2.3"])
			expect(isBoundedSlackRootTs(value)).toBe(false);
	});

	test("an unbounded root is refused before the provider or the store is reached", async () => {
		await withDaemon(async ({ daemon, fake, store }) => {
			await expect(daemon.bindExistingRoot("s1", "not-a-ts")).rejects.toMatchObject({ code: "invalid_root" });
			expect(fake.timestampLookups).toEqual([]);
			expect(Object.keys((await store.load()).conversations)).toEqual([]);
		});
	});

	test("binding adopts the exact operator root and publishes no replacement root", async () => {
		await withDaemon(async ({ daemon, fake, store }) => {
			const bound = await daemon.bindExistingRoot("s1", EXISTING_ROOT);
			expect(bound).toMatchObject({
				state: "active",
				sessionId: "s1",
				rootTs: EXISTING_ROOT,
				teamId: TEAM,
				channelId: CHANNEL,
				endpointGeneration: 3,
			});
			expect(fake.timestampLookups).toEqual([{ channel: CHANNEL, ts: EXISTING_ROOT }]);
			expect(fake.posts).toEqual([]);
			const document = await store.load();
			expect(Object.keys(document.conversations)).toEqual([intentKey("s1")]);
		});
	});

	test("a notification after binding threads into the adopted root and creates no second root", async () => {
		await withDaemon(async ({ daemon, fake, store }) => {
			await daemon.bindExistingRoot("s1", EXISTING_ROOT);
			await daemon.notify("s1", "first notification", undefined, 3);
			expect(fake.posts).toHaveLength(1);
			expect(fake.posts[0]).toMatchObject({ channel: CHANNEL, threadTs: EXISTING_ROOT });
			expect(fake.posts.filter(post => post.threadTs === undefined)).toEqual([]);
			const record = (await store.load()).conversations[intentKey("s1")];
			expect(record).toMatchObject({ state: "active", rootTs: EXISTING_ROOT });
		});
	});

	test("an exact rebind is idempotent and mutates nothing", async () => {
		await withDaemon(async ({ daemon, fake, store }) => {
			const first = await daemon.bindExistingRoot("s1", EXISTING_ROOT);
			const second = await daemon.bindExistingRoot("s1", EXISTING_ROOT);
			expect(second.generation).toBe(first.generation);
			expect(second.rootTs).toBe(EXISTING_ROOT);
			expect(fake.posts).toEqual([]);
			expect(Object.keys((await store.load()).conversations)).toEqual([intentKey("s1")]);
		});
	});

	test("a root the provider cannot find is refused with no mapping", async () => {
		await withDaemon(async ({ daemon, store }) => {
			await expect(daemon.bindExistingRoot("s1", "1785573662.000001")).rejects.toMatchObject({
				code: "root_not_found",
			});
			expect(Object.keys((await store.load()).conversations)).toEqual([]);
		});
	});

	test("an unreachable provider is refused as unavailable with no mapping", async () => {
		await withDaemon(async ({ daemon, fake, store }) => {
			fake.failTimestampLookup = true;
			await expect(daemon.bindExistingRoot("s1", EXISTING_ROOT)).rejects.toMatchObject({
				code: "provider_unavailable",
			});
			expect(Object.keys((await store.load()).conversations)).toEqual([]);
		});
	});

	test("a root already bound to another session is refused as a conflict", async () => {
		await withDaemon(async ({ daemon, store }) => {
			await daemon.bindExistingRoot("s1", EXISTING_ROOT);
			await expect(daemon.bindExistingRoot("s2", EXISTING_ROOT)).rejects.toMatchObject({ code: "root_conflict" });
			expect(Object.keys((await store.load()).conversations)).toEqual([intentKey("s1")]);
		});
	});

	test("commit authority that refuses inside the store fence leaves no mapping", async () => {
		await withDaemon(async ({ daemon, store }) => {
			await expect(daemon.bindExistingRoot("s1", EXISTING_ROOT, async () => false)).rejects.toMatchObject({
				code: "session_not_live",
			});
			expect(Object.keys((await store.load()).conversations)).toEqual([]);
		});
	});

	test("an endpoint generation that rolls before the commit leaves no mapping", async () => {
		await withDaemon(async ({ daemon, store, setGeneration }) => {
			await expect(
				daemon.bindExistingRoot("s1", EXISTING_ROOT, async () => {
					setGeneration(4);
					return true;
				}),
			).rejects.toMatchObject({ code: "session_not_live" });
			expect(Object.keys((await store.load()).conversations)).toEqual([]);
		});
	});

	/**
	 * `ConversationStore` renames the staged document and only then flushes the
	 * parent directory, so a failure raised from that barrier — or from the lock
	 * cleanup behind it — happens when the replacement is already the visible
	 * document. Once the final authority proof has granted commit authority, such
	 * a failure may therefore be the failure of an applied mapping, and reporting
	 * it as a definitive rejection would invite a retry against a store that
	 * already changed.
	 */
	test("a durability barrier that fails after the rename is unknown, never a rejection", async () => {
		let seam: (ConversationStoreFs & { failParentSync: boolean }) | undefined;
		await withDaemon(
			async ({ daemon, store }) => {
				if (!seam) throw new Error("expected an injected persistence seam");
				seam.failParentSync = true;
				await expect(daemon.bindExistingRoot("s1", EXISTING_ROOT)).rejects.toMatchObject({
					code: "binding_outcome_unknown",
				});
				seam.failParentSync = false;

				// The mapping may be — and here provably is — applied. The durable
				// document is the authority the caller must observe; the thrown
				// outcome asserts only that it cannot be told apart from a refusal.
				const applied = (await store.load()).conversations[intentKey("s1")];
				expect(applied).toMatchObject({
					state: "active",
					sessionId: "s1",
					rootTs: EXISTING_ROOT,
					endpointGeneration: 3,
					generation: 1,
				});

				// A retry after an ambiguous commit can neither create a second root
				// claim for the session nor supersede the applied one.
				await expect(daemon.bindExistingRoot("s1", SECOND_ROOT)).rejects.toMatchObject({
					code: "session_conflict",
				});
				const rebound = await daemon.bindExistingRoot("s1", EXISTING_ROOT);
				expect(rebound).toMatchObject({ rootTs: EXISTING_ROOT, generation: 1 });
				expect(Object.keys((await store.load()).conversations)).toEqual([intentKey("s1")]);
			},
			agentDir => {
				seam = parentSyncFailingFs(path.dirname(conversationStorePath(agentDir, "slack")));
				return new ConversationStore<SlackConversation>({ agentDir, kind: "slack", fs: seam });
			},
		);
	});

	test("a persistence failure before commit authority stays a definitive rejection", async () => {
		await withDaemon(async ({ daemon, store, agentDir }) => {
			// A document the store refuses to parse fails the transaction before the
			// final authority proof runs, so nothing was ever staged.
			const file = conversationStorePath(agentDir, "slack");
			await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			await fs.writeFile(file, `${JSON.stringify({ version: 1, conversations: "not-a-record" })}\n`);

			await expect(daemon.bindExistingRoot("s1", EXISTING_ROOT)).rejects.toMatchObject({
				code: "binding_failed",
			});
			await expect(store.load()).rejects.toMatchObject({ message: "Invalid conversation store document" });
		});
	});
});

function owner(agentDir: string): ChatDaemonCommandOwner {
	return { ownerId: `owner-${path.basename(agentDir)}`, pid: process.pid, incarnation: "test:1", generation: 41 };
}

function recordingHandler(): ChatDaemonCommandHandler & { calls: Array<{ sessionId: string; rootTs: string }> } {
	const calls: Array<{ sessionId: string; rootTs: string }> = [];
	return {
		calls,
		bindExistingRoot: async request => {
			calls.push({ sessionId: request.sessionId, rootTs: request.rootTs });
			if (request.commitAuthority && !(await request.commitAuthority()))
				return { ok: false, certainty: "rejected", code: "binding_failed" };
			return {
				ok: true,
				sessionId: request.sessionId,
				endpointGeneration: 3,
				teamId: TEAM,
				channelId: CHANNEL,
				rootTs: request.rootTs,
			};
		},
	};
}

async function withCommandDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-slack-command-"));
	try {
		await run(agentDir);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

function commandDirectory(agentDir: string): string {
	return path.join(chatDaemonPaths(agentDir, "slack").dir, "commands");
}

/** Copy the public request envelope into a `status:"ok"` answer, exactly as a stale or planted document would. */
async function forgeOkResponse(agentDir: string): Promise<boolean> {
	const directory = commandDirectory(agentDir);
	const names = await fs.readdir(directory).catch(() => [] as string[]);
	const requestName = names.find(name => name.endsWith(".request.json"));
	if (!requestName) return false;
	const responseName = `${requestName.slice(0, -".request.json".length)}.response.json`;
	if (names.includes(responseName)) return false;
	const request = JSON.parse(await fs.readFile(path.join(directory, requestName), "utf8"));
	const forged = {
		...request,
		status: "ok",
		endpointGeneration: 3,
		teamId: TEAM,
		channelId: CHANNEL,
		completedAt: Date.now(),
	};
	await fs.writeFile(path.join(directory, responseName), `${JSON.stringify(forged)}\n`, { mode: 0o600 });
	return true;
}

describe("chat daemon command channel", () => {
	test("the owning daemon answers a request addressed to its exact tuple", async () => {
		await withCommandDir(async agentDir => {
			const authority = owner(agentDir);
			const handler = recordingHandler();
			const submission = submitChatDaemonCommand({
				agentDir,
				kind: "slack",
				owner: authority,
				command: "bind-thread",
				sessionId: "s1",
				rootTs: EXISTING_ROOT,
				timeoutMs: 2_000,
				pollIntervalMs: 1,
				sleep: async () => {
					await serveChatDaemonCommandsOnce({ agentDir, kind: "slack", ...authority, handler });
				},
			});
			const result = await submission;
			expect(result.outcome).toBe("answered");
			expect(result.outcome === "answered" && result.response).toMatchObject({
				status: "ok",
				sessionId: "s1",
				rootTs: EXISTING_ROOT,
				endpointGeneration: 3,
				teamId: TEAM,
				channelId: CHANNEL,
				ownerId: authority.ownerId,
				generation: authority.generation,
			});
			expect(handler.calls).toEqual([{ sessionId: "s1", rootTs: EXISTING_ROOT }]);
		});
	});

	test("a daemon that is not the addressed owner answers owner_changed and performs no work", async () => {
		await withCommandDir(async agentDir => {
			const authority = owner(agentDir);
			const handler = recordingHandler();
			const result = await submitChatDaemonCommand({
				agentDir,
				kind: "slack",
				owner: authority,
				command: "bind-thread",
				sessionId: "s1",
				rootTs: EXISTING_ROOT,
				timeoutMs: 2_000,
				pollIntervalMs: 1,
				sleep: async () => {
					await serveChatDaemonCommandsOnce({
						agentDir,
						kind: "slack",
						...authority,
						incarnation: "test:2",
						handler,
					});
				},
			});
			expect(result.outcome).toBe("answered");
			expect(result.outcome === "answered" && result.response.status).toBe("owner_changed");
			expect(handler.calls).toEqual([]);
		});
	});

	test("an ownership change inside the commit fence refuses without dispatching a mutation", async () => {
		await withCommandDir(async agentDir => {
			const authority = owner(agentDir);
			const handler = recordingHandler();
			let ownershipProofs = 0;
			const result = await submitChatDaemonCommand({
				agentDir,
				kind: "slack",
				owner: authority,
				command: "bind-thread",
				sessionId: "s1",
				rootTs: EXISTING_ROOT,
				timeoutMs: 2_000,
				pollIntervalMs: 1,
				sleep: async () => {
					await serveChatDaemonCommandsOnce({
						agentDir,
						kind: "slack",
						...authority,
						handler,
						verifyOwnership: async () => ++ownershipProofs === 1,
					});
				},
			});
			expect(result.outcome).toBe("answered");
			expect(result.outcome === "answered" && result.response.status).toBe("owner_changed");
			expect(handler.calls).toEqual([{ sessionId: "s1", rootTs: EXISTING_ROOT }]);
		});
	});

	test("a timeout is a definitive cancellation and no later serve may dispatch it", async () => {
		await withCommandDir(async agentDir => {
			const authority = owner(agentDir);
			const handler = recordingHandler();
			const result = await submitChatDaemonCommand({
				agentDir,
				kind: "slack",
				owner: authority,
				command: "bind-thread",
				sessionId: "s1",
				rootTs: EXISTING_ROOT,
				timeoutMs: 0,
				settleGraceMs: 0,
				pollIntervalMs: 1,
			});
			expect(result.outcome).toBe("cancelled");
			expect(await serveChatDaemonCommandsOnce({ agentDir, kind: "slack", ...authority, handler })).toBe(0);
			expect(handler.calls).toEqual([]);
		});
	});

	test("a document that does not carry this request's envelope is untrusted, never an answer", async () => {
		await withCommandDir(async agentDir => {
			const authority = owner(agentDir);
			const result = await submitChatDaemonCommand({
				agentDir,
				kind: "slack",
				owner: authority,
				command: "bind-thread",
				sessionId: "s1",
				rootTs: EXISTING_ROOT,
				timeoutMs: 2_000,
				pollIntervalMs: 1,
				sleep: async () => {
					const directory = commandDirectory(agentDir);
					const names = await fs.readdir(directory);
					const requestName = names.find(name => name.endsWith(".request.json"));
					if (!requestName) return;
					const request = JSON.parse(await fs.readFile(path.join(directory, requestName), "utf8"));
					await fs.writeFile(
						path.join(directory, `${requestName.slice(0, -".request.json".length)}.response.json`),
						`${JSON.stringify({ ...request, sessionId: "other-session", status: "ok", completedAt: Date.now() })}\n`,
					);
				},
			});
			expect(result).toEqual({ outcome: "untrusted", code: "response_envelope_mismatch" });
		});
	});
});

const OWNER_INCARNATION = processIncarnation(process.pid);

function configuredSettings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.slack.botToken": "xoxb-not-persisted",
		"notifications.slack.appToken": "xapp-not-persisted",
		"notifications.slack.workspaceId": TEAM,
		"notifications.slack.channelId": CHANNEL,
	});
	// Every read and write stays inside the temp agent directory: the suite must
	// never resolve, read, or create the developer's real agent directory.
	return new Proxy(base, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

async function writeRunningOwner(agentDir: string, settings: Settings): Promise<void> {
	const paths = chatDaemonPaths(agentDir, "slack");
	await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await fs.writeFile(
		paths.state,
		`${JSON.stringify({
			version: 1,
			kind: "slack",
			pid: process.pid,
			ownerId: "slack-owner-1",
			identity: chatDaemonIdentity(settings, "slack"),
			incarnation: OWNER_INCARNATION,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			transportHealthy: true,
			generation: chatDaemonGeneration("slack"),
		})}\n`,
	);
}

describe("configured slack thread binding", () => {
	test.skipIf(OWNER_INCARNATION === undefined)(
		"a forged status:ok with no durable mapping is reported as unknown, never as success",
		async () => {
			await withCommandDir(async agentDir => {
				const settings = configuredSettings(agentDir);
				await writeRunningOwner(agentDir, settings);
				let forged = false;
				await expect(
					bindConfiguredSlackThread(
						{ settings, sessionId: "s1", threadTs: EXISTING_ROOT },
						{
							ensureDaemon: async () => "attached",
							timeoutMs: 2_000,
							settleGraceMs: 0,
							pollIntervalMs: 1,
							sleep: async () => {
								forged = (await forgeOkResponse(agentDir)) || forged;
							},
						},
					),
				).rejects.toMatchObject({ code: "binding_outcome_unknown" });
				expect(forged).toBe(true);

				const store = new ConversationStore<SlackConversation>({ agentDir, kind: "slack" });
				expect(Object.keys((await store.load()).conversations)).toEqual([]);

				// The forged answer occupied the identifier, so it can never buy a later
				// dispatch either: nothing is left for a serving owner to execute.
				const handler = recordingHandler();
				expect(
					await serveChatDaemonCommandsOnce({
						agentDir,
						kind: "slack",
						ownerId: "slack-owner-1",
						pid: process.pid,
						incarnation: OWNER_INCARNATION as string,
						generation: chatDaemonGeneration("slack"),
						handler,
					}),
				).toBe(0);
				expect(handler.calls).toEqual([]);
				expect(Object.keys((await store.load()).conversations)).toEqual([]);
			});
		},
	);

	test.skipIf(OWNER_INCARNATION === undefined)(
		"a daemon that never answers is a definitive, mutation-free failure",
		async () => {
			await withCommandDir(async agentDir => {
				const settings = configuredSettings(agentDir);
				await writeRunningOwner(agentDir, settings);
				const failure = await bindConfiguredSlackThread(
					{ settings, sessionId: "s1", threadTs: EXISTING_ROOT },
					{ ensureDaemon: async () => "attached", timeoutMs: 0, settleGraceMs: 0, pollIntervalMs: 1 },
				).catch(error => error);
				expect(failure).toBeInstanceOf(SlackThreadBindingError);
				expect((failure as SlackThreadBindingError).code).toBe("daemon_unavailable");
				const store = new ConversationStore<SlackConversation>({ agentDir, kind: "slack" });
				expect(Object.keys((await store.load()).conversations)).toEqual([]);
			});
		},
	);

	test("an unconfigured Slack target refuses before any daemon or command work", async () => {
		await withCommandDir(async agentDir => {
			const settings = new Proxy(Settings.isolated({ "notifications.enabled": true }), {
				get(target, property) {
					if (property === "getAgentDir") return () => agentDir;
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as Settings;
			await expect(
				bindConfiguredSlackThread({ settings, sessionId: "s1", threadTs: EXISTING_ROOT }),
			).rejects.toMatchObject({ code: "target_not_configured" });
			await expect(fs.readdir(commandDirectory(agentDir))).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
});
