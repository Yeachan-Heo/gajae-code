import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";

import { brokerProcessIncarnation, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";
import { HEARTBEAT_TTL_MS } from "../src/sdk/bus/daemon-paths";
import {
	type NotificationSubscription,
	type SessionAttachment,
	SessionRouter,
	type SessionRouterClient,
	SessionRouterError,
	type SessionRouterFrame,
} from "../src/sdk/router";
import { SESSION_REQUEST_TIMEOUT_MS } from "../src/sdk/session-reconnect";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

interface RouterFixtureAuthority {
	generation: number;
	pid: number;
	endpointMtimeMs: number;
	indexed: boolean;
	terminalUncertain: boolean;
	warnings: string[];
}

interface RouterFixtureClient {
	sent: Record<string, unknown>[];
	requests: Record<string, unknown>[];
	requestOptions: ({ timeoutMs?: number } | undefined)[];
	client: SessionRouterClient;
	emit: (frame: Record<string, unknown>) => void;
	reconnect: () => void;
}

interface RouterFixture {
	repo: string;
	authority: RouterFixtureAuthority;
	attachments: SessionAttachment[];
	clients: RouterFixtureClient[];
	endpointFile: string;
	router: SessionRouter;
	sessionId: string;
}

async function routerFixture(
	options: {
		onAttachment?: (attachment: SessionAttachment) => void | Promise<void>;
		onAttachmentReady?: (attachment: SessionAttachment) => void | Promise<void>;
		onSessionRemoved?: (
			attachment: SessionAttachment,
			reason?: "removed" | "replaced" | "replaced_same_generation",
		) => void | Promise<void>;
		onFrame?: (attachment: SessionAttachment, frame: SessionRouterFrame) => void | Promise<void>;
		onNotificationSubscription?: (subscription: NotificationSubscription) => void | Promise<void>;
		onNotificationSubscriptionReady?: (subscription: NotificationSubscription) => void | Promise<void>;
		start?: boolean;
		initiallyIndexed?: boolean;
		onIndexRefresh?: () => void | Promise<void>;
		onClientCreated?: () => void | Promise<void>;
		createBrokerClient?: () => Promise<SessionRouterClient>;
		indexedRepo?: string;
	} = {},
): Promise<RouterFixture> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-router-authority-"));
	tempDirs.push(repo);
	const agentDir = path.join(repo, ".gjc", "agent");
	const stateRoot = path.join(repo, ".gjc", "state");
	const sessionId = "router-session";
	const endpointDir = path.join(stateRoot, "sdk");
	const endpointFile = path.join(endpointDir, `${sessionId}.json`);
	fs.mkdirSync(endpointDir, { recursive: true });
	fs.writeFileSync(endpointFile, JSON.stringify({ sessionId, url: "ws://router.test", token: "secret", pid: 42 }));
	const endpointMtimeMs = fs.statSync(endpointFile).mtimeMs;

	const authority = {
		generation: 1,
		pid: 42,
		endpointMtimeMs,
		indexed: options.initiallyIndexed !== false,
		terminalUncertain: false,
		warnings: [] as string[],
	};
	const index = {
		open: async () => {},
		refresh: async () => {
			await options.onIndexRefresh?.();
		},
		listSessions: () => ({
			indexSeq: authority.generation,
			sessions: authority.indexed
				? [
						{
							sessionId,
							locator: { repo: options.indexedRepo ?? repo, stateRoot },
							endpointGeneration: authority.generation,
							pid: authority.pid,
							endpointMtimeMs: authority.endpointMtimeMs,
							live: true,
							indexSeq: authority.generation,
							terminalUncertain: authority.terminalUncertain || undefined,
							ambiguous: false,
							terminal: false,
						},
					]
				: [],
			warnings: authority.warnings,
		}),
	} as unknown as SessionIndex;
	const clients: RouterFixtureClient[] = [];
	const attachments: SessionAttachment[] = [];
	const router = new SessionRouter({
		agentDir,
		deps: {
			createIndex: () => index,
			createClient: async () => {
				const sent: Record<string, unknown>[] = [];
				const requests: Record<string, unknown>[] = [];
				const requestOptions: ({ timeoutMs?: number } | undefined)[] = [];
				let handler: ((frame: Record<string, unknown>) => void) | undefined;
				let reconnectHandler: (() => void) | undefined;
				const client: SessionRouterClient = {
					onFrame: next => {
						handler = next;
						return () => {
							if (handler === next) handler = undefined;
						};
					},
					onReconnect: next => {
						reconnectHandler = next;
						return () => {
							if (reconnectHandler === next) reconnectHandler = undefined;
						};
					},
					request: async (operation, requestOption) => {
						requests.push(operation);
						requestOptions.push(requestOption);
						return { events: [] };
					},
					close: async () => {},
					send: frame => sent.push(frame),
				};
				clients.push({
					sent,
					requests,
					requestOptions,
					client,
					emit: frame => handler?.(frame),
					reconnect: () => reconnectHandler?.(),
				});
				await options.onClientCreated?.();
				return client;
			},
			createBrokerClient: options.createBrokerClient,
			onAttachment: attachment => {
				if (options.onAttachment) return options.onAttachment(attachment);
				attachments.push(attachment);
			},
			onAttachmentReady: options.onAttachmentReady,
			onFrame: options.onFrame,
			onNotificationSubscription: options.onNotificationSubscription,
			onNotificationSubscriptionReady: options.onNotificationSubscriptionReady,
			onSessionRemoved: options.onSessionRemoved,
			setInterval: (() => 0) as unknown as typeof setInterval,
			clearInterval: (() => {}) as unknown as typeof clearInterval,
		},
	});
	if (options.start !== false) await router.start();
	return {
		repo,
		authority,
		attachments,
		clients,
		endpointFile,
		router,
		sessionId,
	};
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error(message);
}

describe("SessionRouter dispatch authority", () => {
	test("withholds publication for two current state roots until one resolves", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-router-ambiguous-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const alternateStateRoot = path.join(repo, ".gjc", "alternate-state");
		const sessionId = "router-ambiguous";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		fs.mkdirSync(path.dirname(endpointPath), { recursive: true });
		fs.writeFileSync(
			endpointPath,
			JSON.stringify({ sessionId, url: "ws://router.test", token: "secret", pid: process.pid }),
		);
		const endpointMtimeMs = fs.statSync(endpointPath).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		const alternate = await index.append({
			type: "host_registered",
			sessionId,
			locator: { repo, stateRoot: alternateStateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: 1,
		});
		const current = await index.append({
			type: "host_registered",
			sessionId,
			locator: { repo, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs,
		});
		const attachments: SessionAttachment[] = [];
		const clients: SessionRouterClient[] = [];
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => {
					const client: SessionRouterClient = {
						onFrame: () => () => {},
						request: async () => ({ events: [] }),
						close: async () => {},
						send: () => {},
					};
					clients.push(client);
					return client;
				},
				onAttachment: attachment => {
					attachments.push(attachment);
				},
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});
		try {
			await router.start();
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({
					sessionId,
					endpointGeneration: current.endpointGeneration,
					ambiguous: true,
					live: false,
				}),
			]);
			expect(attachments).toEqual([]);
			expect(clients).toEqual([]);
			expect(router.attachment(sessionId)).toBeNull();

			await index.append({
				type: "host_unregistered",
				sessionId,
				locator: alternate.locator,
				endpointGeneration: alternate.endpointGeneration,
				pid: alternate.pid,
				...(alternate.processIncarnation === undefined ? {} : { processIncarnation: alternate.processIncarnation }),
				...(alternate.hostIncarnation === undefined ? {} : { hostIncarnation: alternate.hostIncarnation }),
			});
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
			await router.reconcile();
			expect(attachments).toHaveLength(1);
			expect(clients).toHaveLength(1);
			expect(router.attachment(sessionId)?.isCurrent()).toBe(true);
		} finally {
			await router.stop();
		}
	});
	test("publishes the lower-generation root after the higher-generation root terminates", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-router-ambiguous-reverse-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const alternateRepo = path.join(repo, "alternate-worktree");
		const alternateStateRoot = path.join(alternateRepo, ".gjc", "state");
		const currentStateRoot = path.join(repo, ".gjc", "state");
		const sessionId = "router-ambiguous-reverse";
		const endpointPath = path.join(alternateStateRoot, "sdk", `${sessionId}.json`);
		fs.mkdirSync(path.dirname(endpointPath), { recursive: true });
		fs.writeFileSync(
			endpointPath,
			JSON.stringify({ sessionId, url: "ws://router.test", token: "alternate-secret", pid: process.pid }),
		);
		const alternateEndpointMtimeMs = fs.statSync(endpointPath).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		const alternate = await index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: alternateRepo, stateRoot: alternateStateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: alternateEndpointMtimeMs,
		});
		const current = await index.append({
			type: "host_registered",
			sessionId,
			locator: { repo, stateRoot: currentStateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: 1,
		});
		const attachments: SessionAttachment[] = [];
		const clients: SessionRouterClient[] = [];
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => {
					const client: SessionRouterClient = {
						onFrame: () => () => {},
						request: async () => ({ events: [] }),
						close: async () => {},
						send: () => {},
					};
					clients.push(client);
					return client;
				},
				onAttachment: attachment => {
					attachments.push(attachment);
				},
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});
		try {
			await router.start();
			expect(index.listSessions().sessions).toEqual([
				expect.objectContaining({ sessionId, endpointGeneration: current.endpointGeneration, ambiguous: true }),
			]);
			expect(attachments).toEqual([]);

			await index.append({
				type: "host_unregistered",
				sessionId,
				locator: current.locator,
				endpointGeneration: current.endpointGeneration,
				pid: current.pid,
				...(current.processIncarnation === undefined ? {} : { processIncarnation: current.processIncarnation }),
				...(current.hostIncarnation === undefined ? {} : { hostIncarnation: current.hostIncarnation }),
			});
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
			await router.reconcile();
			expect(attachments).toHaveLength(1);
			expect(clients).toHaveLength(1);
			expect(attachments[0]).toMatchObject({
				sessionId,
				generation: alternate.endpointGeneration,
			});
			expect(router.attachment(sessionId)?.isCurrent()).toBe(true);
		} finally {
			await router.stop();
		}
	});
	test("contains an unreachable indexed endpoint while attaching healthy sessions", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-router-reconcile-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		fs.mkdirSync(endpointDir, { recursive: true });
		const indexed = [
			{
				sessionId: "router-unreachable",
				url: "ws://unreachable.test",
				token: "unreachable-secret",
			},
			{
				sessionId: "router-healthy",
				url: "ws://healthy.test",
				token: "healthy-secret",
			},
		] as const;
		const endpointMtimeMs = new Map<string, number>();
		for (const session of indexed) {
			const endpointFile = path.join(endpointDir, `${session.sessionId}.json`);
			fs.writeFileSync(endpointFile, `${JSON.stringify({ ...session, pid: 42 })}\n`);
			endpointMtimeMs.set(session.sessionId, fs.statSync(endpointFile).mtimeMs);
		}
		const index = {
			open: async () => {},
			refresh: async () => {},
			listSessions: () => ({
				indexSeq: 1,
				sessions: indexed.map(session => ({
					sessionId: session.sessionId,
					locator: { repo, stateRoot },
					endpointGeneration: 1,
					pid: 42,
					endpointMtimeMs: endpointMtimeMs.get(session.sessionId),
					live: true,
					indexSeq: 1,
					ambiguous: false,
					terminal: false,
				})),
				warnings: [],
			}),
		} as unknown as SessionIndex;
		const attachments: SessionAttachment[] = [];
		const warnings: string[] = [];
		const warnSpy = spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async authority => {
					if (authority.sessionId.includes("unreachable")) throw new Error("connect failed");
					return {
						onFrame: () => () => {},
						request: async () => ({ events: [] }),
						close: async () => {},
						send: () => {},
					};
				},
				onAttachment: attachment => {
					attachments.push(attachment);
				},
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});
		try {
			await router.start();
			expect(router.isReady()).toBe(true);
			expect(attachments.map(attachment => attachment.sessionId)).toEqual(["router-healthy"]);
			expect(router.attachment("router-unreachable")).toBeNull();
			expect(router.attachment("router-healthy")).not.toBeNull();
			expect(warnings.some(message => message.includes("router-unreachable"))).toBe(true);
			expect(warnings.every(message => !message.includes("unreachable-secret"))).toBe(true);
		} finally {
			await router.stop();
			warnSpy.mockRestore();
		}
	});

	test("revokes attachment authority when provider publication rejects", async () => {
		let removed: SessionAttachment | undefined;
		const fixture = await routerFixture({
			onAttachment: () => {
				throw new Error("provider cleanup recovery failed");
			},
			onSessionRemoved: attachment => {
				removed = attachment;
			},
		});
		try {
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
			expect(removed?.sessionId).toBe(fixture.sessionId);
			expect(removed?.isCurrent()).toBe(false);
		} finally {
			await fixture.router.stop();
		}
	});

	test("contains synchronous notification admission failure without revoking core attachment", async () => {
		const fixture = await routerFixture({
			onNotificationSubscription: () => {
				throw new Error("Telegram admission failed synchronously");
			},
		});
		try {
			await Bun.sleep(0);
			const attachment = fixture.router.attachment(fixture.sessionId);
			expect(attachment).not.toBeNull();
			expect(attachment?.isCurrent()).toBe(true);
			expect(await fixture.router.request(fixture.sessionId, { type: "query_request" })).toEqual({ events: [] });
		} finally {
			await fixture.router.stop();
		}
	});

	test("contains synchronous notification ready failure without revoking core attachment", async () => {
		const fixture = await routerFixture({
			onNotificationSubscriptionReady: () => {
				throw new Error("Telegram ready failed synchronously");
			},
		});
		try {
			await Bun.sleep(0);
			const attachment = fixture.router.attachment(fixture.sessionId);
			expect(attachment).not.toBeNull();
			expect(attachment?.isCurrent()).toBe(true);
			expect(await fixture.router.request(fixture.sessionId, { type: "query_request" })).toEqual({ events: [] });
		} finally {
			await fixture.router.stop();
		}
	});

	test("rejects a command carrying a different same-generation attachment", async () => {
		const fixture = await routerFixture();
		const impostor: SessionAttachment = Object.freeze({
			sessionId: fixture.sessionId,
			generation: 1,
			isCurrent: () => true,
			send: async () => {},
		});
		try {
			await expect(
				fixture.router.request(fixture.sessionId, { type: "query_request" }, 1, impostor),
			).rejects.toBeInstanceOf(SessionRouterError);
			expect(fixture.clients[0]?.requests.filter(frame => frame.type === "query_request")).toEqual([]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("dispatches session requests on the long-lived session budget, not the one-shot transport default", async () => {
		const fixture = await routerFixture();
		try {
			await fixture.router.request(
				fixture.sessionId,
				{ type: "query_request", id: "q10", query: "models.list/current", input: {} },
				1,
			);
			const dispatched = fixture.clients[0]!;
			const index = dispatched.requests.findIndex(frame => frame.type === "query_request");
			expect(index).toBeGreaterThanOrEqual(0);
			// A cold host's first credential-collecting Q10 outruns the transport's
			// 10s one-shot default and loses the session it was created for (#4258).
			expect(dispatched.requestOptions[index]?.timeoutMs).toBe(SESSION_REQUEST_TIMEOUT_MS);
			expect(SESSION_REQUEST_TIMEOUT_MS).toBeGreaterThan(HEARTBEAT_TTL_MS);
		} finally {
			await fixture.router.stop();
		}
	});

	test("preserves a caller-supplied request budget instead of widening it", async () => {
		const fixture = await routerFixture();
		try {
			await fixture.router.request(
				fixture.sessionId,
				{ type: "control_request", id: "abort", operation: "turn.abort", input: {} },
				1,
				undefined,
				{ timeoutMs: 1_500 },
			);
			const dispatched = fixture.clients[0]!;
			const index = dispatched.requests.findIndex(frame => frame.type === "control_request");
			expect(index).toBeGreaterThanOrEqual(0);
			expect(dispatched.requestOptions[index]?.timeoutMs).toBe(1_500);
		} finally {
			await fixture.router.stop();
		}
	});

	test("reruns the provider handshake before replay after reconnect", async () => {
		let readyCount = 0;
		const fixture = await routerFixture({
			onAttachmentReady: async attachment => {
				readyCount++;
				await attachment.send({ type: "hello", readyCount });
				await attachment.send({ type: "event_replay", id: `provider-replay-${readyCount}` });
			},
		});
		try {
			expect(readyCount).toBe(1);
			fixture.clients[0]?.reconnect();
			for (let attempt = 0; readyCount < 2 && attempt < 50; attempt++) await Bun.sleep(10);
			expect(readyCount).toBe(2);
			expect(fixture.clients[0]?.sent.map(frame => frame.type)).toEqual([
				"hello",
				"event_replay",
				"hello",
				"event_replay",
			]);
		} finally {
			await fixture.router.stop();
		}
	});
	test("reruns Telegram notification-ready handshake before replay after reconnect", async () => {
		let readyCount = 0;
		const fixture = await routerFixture({
			onNotificationSubscriptionReady: async subscription => {
				readyCount++;
				subscription.send({ type: "hello", readyCount });
				subscription.send({ type: "event_replay", id: `telegram-replay-${readyCount}` });
			},
		});
		try {
			expect(readyCount).toBe(1);
			fixture.clients[0]?.reconnect();
			for (let attempt = 0; readyCount < 2 && attempt < 50; attempt++) await Bun.sleep(10);
			expect(readyCount).toBe(2);
			expect(fixture.clients[0]?.sent.map(frame => frame.type)).toEqual([
				"hello",
				"event_replay",
				"hello",
				"event_replay",
			]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("publishes an attachment whose indexed repo is a symlinked spelling of the state root", async () => {
		// Production shape after reconcileReadyScope: locator.repo carries the
		// lifecycle caller's lexical cwd while locator.stateRoot stays the host's
		// physical path, because the host derives it from process.cwd(), which
		// resolves symlinks. A lexical scope test rejects every symlinked cwd and
		// the attachment can never be published.
		const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-router-symlink-"));
		tempDirs.push(linkParent);
		let readyCount = 0;
		const fixture = await routerFixture({
			start: false,
			indexedRepo: path.join(linkParent, "linked-workspace"),
			onAttachmentReady: () => {
				readyCount += 1;
			},
		});
		fs.symlinkSync(fixture.repo, path.join(linkParent, "linked-workspace"), "dir");
		try {
			await fixture.router.start();
			expect(fixture.clients).toHaveLength(1);
			expect(readyCount).toBe(1);
			expect(fixture.attachments).toHaveLength(1);
			expect(fixture.attachments[0]?.isCurrent()).toBe(true);
			expect(fixture.router.attachment(fixture.sessionId)).not.toBeNull();
		} finally {
			await fixture.router.stop();
		}
	});

	test("preserves Broker list results when transport cleanup fails", async () => {
		const response = { ok: true, sessions: [{ sessionId: "listed-session" }] };
		let closed = 0;
		let brokerRequest: Record<string, unknown> | undefined;
		const fixture = await routerFixture({
			start: false,
			createBrokerClient: async () => ({
				onFrame: () => () => {},
				request: async frame => {
					brokerRequest = frame;
					return response;
				},
				close: async () => {
					closed += 1;
					throw new Error("close handshake failed");
				},
				send: () => {},
			}),
		});
		const incarnation = brokerProcessIncarnation(process.pid);
		if (!incarnation) throw new Error("Test process incarnation is unavailable.");
		await writeBrokerDiscovery(path.join(fixture.repo, ".gjc", "agent"), {
			version: SDK_STATE_VERSION,
			protocolVersion: 3,
			packageGeneration: "router-test",
			ownerId: "router-test-owner",
			pid: process.pid,
			incarnation,
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "broker-test-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});
		const warnings: string[] = [];
		const warnSpy = spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			expect(await fixture.router.listBrokerSessions({ workspace: fixture.repo }, "list-key")).toEqual(response);
			expect(brokerRequest).toEqual({
				type: "broker_request",
				operation: "session.list",
				input: { workspace: fixture.repo },
				idempotencyKey: "list-key",
			});
			expect(closed).toBe(1);
			expect(warnings).toEqual([
				"SDK Broker session.list transport cleanup failed (Error: close handshake failed).",
			]);
		} finally {
			warnSpy.mockRestore();
			await fixture.router.stop();
		}
	});

	test("stamps the endpoint token onto token-authorized inbound frames", async () => {
		// The native session server silently drops user_message/reply/control
		// frames whose embedded token is missing or wrong; providers never see
		// the endpoint record, so the router must stamp the token itself.
		const subscriptions: NotificationSubscription[] = [];
		const fixture = await routerFixture({
			onNotificationSubscription: subscription => {
				subscriptions.push(subscription);
			},
		});
		try {
			expect(subscriptions.length).toBe(1);
			const [client] = fixture.clients;
			const subscription = subscriptions[0]!;
			subscription.send({ type: "user_message", sessionId: fixture.sessionId, text: "hi" });
			subscription.send({ type: "reply", id: "a1", answer: "yes" });
			subscription.send({ type: "user_message", sessionId: fixture.sessionId, text: "x", token: "preset" });
			subscription.send({ type: "session_frame_ack", seq: 1 });
			const byType = (type: string) => client!.sent.filter(frame => frame.type === type);
			expect(byType("user_message")[0]?.token).toBe("secret");
			expect(byType("reply")[0]?.token).toBe("secret");
			// A caller-provided token is never overwritten.
			expect(byType("user_message")[1]?.token).toBe("preset");
			// Non-authorized frame types stay untouched.
			expect(byType("session_frame_ack")[0]?.token).toBeUndefined();
		} finally {
			await fixture.router.stop();
		}
	});
});

describe("SessionRouter direct-attachment stub contract (#4530)", () => {
	test("attaches indexed sessions and delivers correlated frames in order with publication ids", async () => {
		const frames: SessionRouterFrame[] = [];
		const fixture = await routerFixture({
			onFrame: (_attachment, frame) => {
				frames.push(frame);
			},
		});
		try {
			const attachment = fixture.router.attachment(fixture.sessionId);
			expect(attachment?.isCurrent()).toBe(true);
			fixture.clients[0]?.emit({ type: "event", sessionId: fixture.sessionId, generation: 1, seq: 1 });
			fixture.clients[0]?.emit({ type: "event", sessionId: fixture.sessionId, generation: 1, seq: 2 });
			fixture.clients[0]?.emit({ type: "event", sessionId: fixture.sessionId, generation: 1, seq: 2 });
			await waitFor(() => frames.length === 2, "Router did not deliver the sequenced frames.");
			expect(frames.map(frame => frame.seq)).toEqual([1, 2]);
			expect(frames.map(frame => frame.publicationId)).toEqual([
				`${fixture.sessionId}:1:1`,
				`${fixture.sessionId}:1:2`,
			]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("drops frames correlated to a different session or generation", async () => {
		const frames: SessionRouterFrame[] = [];
		const fixture = await routerFixture({
			onFrame: (_attachment, frame) => {
				frames.push(frame);
			},
		});
		try {
			fixture.clients[0]?.emit({ type: "event", sessionId: "someone-else", generation: 1, seq: 1 });
			fixture.clients[0]?.emit({ type: "event", sessionId: fixture.sessionId, generation: 9, seq: 1 });
			fixture.clients[0]?.emit({ type: "event", sessionId: fixture.sessionId, generation: 1, seq: 1 });
			await waitFor(() => frames.length === 1, "Router did not deliver the owned frame.");
			expect(frames[0]?.sessionId).toBe(fixture.sessionId);
			expect(frames[0]?.generation).toBe(1);
		} finally {
			await fixture.router.stop();
		}
	});

	test("retires attachments whose session disappears from the index on reconcile", async () => {
		const reasons: Array<string | undefined> = [];
		const fixture = await routerFixture({
			onSessionRemoved: (_attachment, reason) => {
				reasons.push(reason);
			},
		});
		try {
			const attachment = fixture.router.attachment(fixture.sessionId);
			expect(attachment?.isCurrent()).toBe(true);
			fixture.authority.indexed = false;
			await fixture.router.reconcile();
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
			expect(attachment?.isCurrent()).toBe(false);
			expect(reasons).toEqual(["removed"]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("replaces attachments whose indexed pid or endpoint mtime changes", async () => {
		const fixture = await routerFixture();
		try {
			const predecessor = fixture.router.attachment(fixture.sessionId);
			expect(predecessor?.isCurrent()).toBe(true);
			fs.writeFileSync(
				fixture.endpointFile,
				JSON.stringify({ sessionId: fixture.sessionId, url: "ws://router.test", token: "secret", pid: 43 }),
			);
			fixture.authority.pid = 43;
			fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
			await fixture.router.reconcile();
			const successor = fixture.router.attachment(fixture.sessionId);
			expect(successor).not.toBeNull();
			expect(successor).not.toBe(predecessor);
			expect(predecessor?.isCurrent()).toBe(false);
			expect(fixture.clients).toHaveLength(2);
		} finally {
			await fixture.router.stop();
		}
	});

	test("rejects in-flight requests as ambiguous when the attachment changes mid-request", async () => {
		const release = Promise.withResolvers<void>();
		const fixture = await routerFixture();
		const router = fixture.router;
		const client = fixture.clients[0]!.client;
		const originalRequest = client.request.bind(client);
		client.request = async (frame, options) => {
			await release.promise;
			return await originalRequest(frame, options);
		};
		try {
			const pending = router.request(fixture.sessionId, { type: "query_request" }, 1);
			fixture.authority.generation = 2;
			fixture.authority.endpointMtimeMs = fixture.authority.endpointMtimeMs + 1;
			await router.reconcile();
			release.resolve();
			await expect(pending).rejects.toMatchObject({ phase: "ambiguous" });
		} finally {
			release.resolve();
			await router.stop();
		}
	});

	test("adoptLifecycleResult validates the exact endpoint authority and publishes the attachment", async () => {
		const fixture = await routerFixture({ initiallyIndexed: false, start: false });
		const router = fixture.router;
		await router.start();
		try {
			await expect(
				router.adoptLifecycleResult(
					{ ok: true, result: { sessionId: fixture.sessionId, endpointGeneration: 1, pid: 42 } },
					{ sessionId: fixture.sessionId, cwd: fixture.repo },
				),
			).rejects.toBeInstanceOf(SessionRouterError);
			const endpoint = JSON.parse(fs.readFileSync(fixture.endpointFile, "utf8")) as Record<string, unknown>;
			const adopted = await router.adoptLifecycleResult(
				{
					ok: true,
					result: {
						sessionId: fixture.sessionId,
						endpointGeneration: fixture.authority.generation,
						pid: fixture.authority.pid,
						endpointMtimeMs: fixture.authority.endpointMtimeMs,
						endpoint,
					},
				},
				{ sessionId: fixture.sessionId, cwd: fixture.repo },
			);
			expect(adopted.isCurrent()).toBe(true);
			expect(router.attachment(fixture.sessionId)).toBe(adopted);
		} finally {
			await router.stop();
		}
	});

	test("stop revokes every attachment, closes clients, and detaches notifications", async () => {
		let closed = 0;
		const removed: Array<string | undefined> = [];
		const fixture = await routerFixture({
			onClientCreated: () => {},
			onSessionRemoved: (_attachment, reason) => {
				removed.push(reason);
			},
		});
		const originalClose = fixture.clients[0]!.client.close;
		fixture.clients[0]!.client.close = async () => {
			closed += 1;
			await originalClose();
		};
		const attachment = fixture.router.attachment(fixture.sessionId);
		await fixture.router.stop();
		expect(attachment?.isCurrent()).toBe(false);
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		expect(closed).toBe(1);
		expect(removed).toEqual(["removed"]);
		expect(fixture.router.notificationCleanupReceipts().length).toBeGreaterThan(0);
	});

	test("rejects an endpoint rewritten after its indexed stat", async () => {
		const fixture = await routerFixture({ start: false });
		const realStat = fsPromises.stat;
		let rewritten = false;
		const statSpy = spyOn(fsPromises, "stat").mockImplementation((async (file, options) => {
			const stat = await realStat(file, options);
			if (!rewritten && file === fixture.endpointFile) {
				rewritten = true;
				fs.writeFileSync(
					fixture.endpointFile,
					JSON.stringify({
						sessionId: fixture.sessionId,
						url: "ws://router.test",
						token: "replacement",
						pid: 42,
					}),
				);
			}
			return stat;
		}) as typeof fsPromises.stat);
		try {
			await fixture.router.start();
			expect(rewritten).toBe(true);
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
			expect(fixture.clients).toEqual([]);
		} finally {
			statSpy.mockRestore();
			await fixture.router.stop();
		}
	});

	test("periodic reconcile converges while a rehosted attachment's replay is wedged (#4527)", async () => {
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4527-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "wedge";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://wedge.test", token: "v1", pid: 42 }));
		let generation = 1;
		let wedgeReplay = false;
		const wedgedGate = Promise.withResolvers<void>();
		let reconcileCount = 0;
		let tick: (() => void) | undefined;

		const index = {
			open: async () => {},
			refresh: async () => {},
			listSessions: () => ({
				indexSeq: generation,
				sessions: [
					{
						sessionId,
						locator: { repo, stateRoot },
						endpointGeneration: generation,
						pid: 42,
						endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
						live: true,
						indexSeq: generation,
						ambiguous: false,
						terminal: false,
					},
				],
				warnings: [],
			}),
		} as unknown as SessionIndex;

		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => ({
					onFrame: () => () => {},
					request: async (frame: Record<string, unknown>) => {
						if (wedgeReplay && frame.type === "event_replay") await wedgedGate.promise;
						return { events: [] };
					},
					close: async () => {},
					send: () => {},
				}),
				onReconciled: () => {
					reconcileCount++;
				},
				setInterval: ((callback: () => void) => {
					tick = callback;
					return 0;
				}) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});

		try {
			await router.start();
			expect(router.attachment(sessionId)?.isCurrent()).toBe(true);
			const baseline = reconcileCount;

			generation = 2;
			await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://wedge.test", token: "v2", pid: 42 }));
			wedgeReplay = true;

			const requestSettled = await Promise.race([
				Bun.sleep(500).then(() => false),
				router.request(sessionId, { type: "test" }).then(() => true),
			]);
			expect(requestSettled).toBe(true);
			expect(reconcileCount).toBeGreaterThan(baseline);

			const beforeSecond = reconcileCount;
			tick!();
			const secondSettled = await Promise.race([
				Bun.sleep(500).then(() => false),
				(async () => {
					for (let i = 0; i < 500 && reconcileCount <= beforeSecond; i++) await Bun.sleep(1);
					return reconcileCount > beforeSecond;
				})(),
			]);
			expect(secondSettled).toBe(true);

			let explicitSettled = false;
			const explicitReconcile = router.reconcile().then(() => {
				explicitSettled = true;
			});
			await Bun.sleep(10);
			expect(explicitSettled).toBe(false);
			wedgedGate.resolve();
			await explicitReconcile;
			expect(explicitSettled).toBe(true);
		} finally {
			wedgedGate.resolve();
			await router.stop();
		}
	});
});
