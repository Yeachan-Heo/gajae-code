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
import { SdkClientError } from "../src/sdk/client/client";
import {
	type NotificationSubscription,
	type SessionAttachment,
	SessionRouter,
	type SessionRouterClient,
	SessionRouterError,
	type SessionRouterFrame,
} from "../src/sdk/router";
import { SESSION_REQUEST_TIMEOUT_MS } from "../src/sdk/session-reconnect";

/** Longer than the 100/200/400ms replay retry ladder the attach pass must not run. */
const REPLAY_LADDER_WINDOW_MS = 900;

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
	requestOptions: Parameters<SessionRouterClient["request"]>[1][];
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
		invokeDispatchObservers?: boolean;
		onAttachment?: (attachment: SessionAttachment) => void | Promise<void>;
		onAttachmentReady?: (attachment: SessionAttachment) => void | Promise<void>;
		onSessionRemoved?: (
			attachment: SessionAttachment,
			reason?: "removed" | "replaced" | "replaced_same_generation",
		) => void | Promise<void>;
		onFrame?: (attachment: SessionAttachment, frame: SessionRouterFrame) => void | Promise<void>;
		onNotificationSubscription?: (subscription: NotificationSubscription) => void | Promise<void>;
		onNotificationSubscriptionReady?: (subscription: NotificationSubscription) => void | Promise<void>;
		onNotificationSubscriptionRemoved?: (
			subscription: NotificationSubscription,
			reason?: "removed" | "replaced" | "replaced_same_generation" | "cancelled",
		) => void | Promise<void>;
		onNotificationFrame?: (subscription: NotificationSubscription, frame: SessionRouterFrame) => void | Promise<void>;
		start?: boolean;
		initiallyIndexed?: boolean;
		onIndexRefresh?: () => void | Promise<void>;
		onClientCreated?: () => void | Promise<void>;
		createBrokerClient?: () => Promise<SessionRouterClient>;
		indexedRepo?: string;
		onRequest?: (operation: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
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
		refreshIfChanged: async () => {
			await options.onIndexRefresh?.();
			return true;
		},
		listSessions: () => ({
			indexSeq: authority.generation,
			sessions: authority.indexed
				? [
						{
							sessionId,
							locator: { cwd: options.indexedRepo ?? repo, worktreeRoot: null, stateRoot },
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
				const requestOptions: Parameters<SessionRouterClient["request"]>[1][] = [];
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
						if (options.invokeDispatchObservers !== false) {
							const context = {
								frame: operation,
								connectionId: "fixture-connection",
								generation: 1,
							};
							requestOption?.beforeDispatch?.(context);
							requestOption?.onDispatch?.(context);
						}
						return options.onRequest ? await options.onRequest(operation) : { events: [] };
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
			onNotificationSubscriptionRemoved: options.onNotificationSubscriptionRemoved,
			onNotificationFrame: options.onNotificationFrame,
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

interface ManualTimeouts {
	readonly clearTimeout: typeof clearTimeout;
	readonly fire: () => void;
	readonly pending: () => number;
	readonly setTimeout: typeof setTimeout;
}

function manualTimeouts(): ManualTimeouts {
	const timers = new Map<number, () => void>();
	let nextTimer = 0;
	return {
		setTimeout: ((callback: () => void) => {
			const timer = ++nextTimer;
			timers.set(timer, callback);
			return timer;
		}) as unknown as typeof setTimeout,
		clearTimeout: ((timer: number) => {
			timers.delete(timer);
		}) as unknown as typeof clearTimeout,
		pending: () => timers.size,
		fire: () => {
			const timer = timers.entries().next().value;
			if (!timer || timers.size !== 1) throw new Error("Expected exactly one pending attach deadline.");
			const [id, callback] = timer;
			timers.delete(id);
			callback();
		},
	};
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error(message);
}

interface HungRouterFixture {
	readonly deadlines: ManualTimeouts;
	readonly healthyPublished: Promise<void>;
	readonly healthySent: Record<string, unknown>[];
	readonly hungConnections: () => number;
	readonly reconciliations: () => number;
	readonly router: SessionRouter;
	readonly tick: () => void;
}

function hungRouterFixture(): HungRouterFixture {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-router-hung-"));
	tempDirs.push(repo);
	const agentDir = path.join(repo, ".gjc", "agent");
	const stateRoot = path.join(repo, ".gjc", "state");
	const endpointDir = path.join(stateRoot, "sdk");
	fs.mkdirSync(endpointDir, { recursive: true });
	const indexed = [
		{ sessionId: "router-hung", url: "ws://hung.test", token: "hung-secret" },
		{ sessionId: "router-healthy", url: "ws://healthy.test", token: "healthy-secret" },
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
		refreshIfChanged: async () => true,
		listSessions: () => ({
			indexSeq: 1,
			sessions: indexed.map(session => ({
				sessionId: session.sessionId,
				locator: { cwd: repo, worktreeRoot: null, stateRoot },
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
	const deadlines = manualTimeouts();
	const healthyPublished = Promise.withResolvers<void>();
	const healthySent: Record<string, unknown>[] = [];
	let hungConnections = 0;
	let reconciliations = 0;
	let reconcileTick: (() => void) | undefined;
	const router = new SessionRouter({
		agentDir,
		deps: {
			createIndex: () => index,
			createClient: async authority => {
				if (authority.sessionId === "router-hung") {
					hungConnections++;
					const connection = Promise.withResolvers<SessionRouterClient>();
					return await connection.promise;
				}
				return {
					onFrame: () => () => {},
					request: async () => ({ events: [] }),
					close: async () => {},
					send: frame => healthySent.push(frame),
				};
			},
			onAttachmentReady: attachment => {
				if (attachment.sessionId === "router-healthy") healthyPublished.resolve();
			},
			onReconciled: () => {
				reconciliations++;
			},
			setInterval: ((callback: () => void) => {
				reconcileTick = callback;
				return 0;
			}) as unknown as typeof setInterval,
			clearInterval: (() => {}) as unknown as typeof clearInterval,
			setTimeout: deadlines.setTimeout,
			clearTimeout: deadlines.clearTimeout,
		},
	});
	return {
		deadlines,
		healthyPublished: healthyPublished.promise,
		healthySent,
		hungConnections: () => hungConnections,
		reconciliations: () => reconciliations,
		router,
		tick: () => {
			if (!reconcileTick) throw new Error("SessionRouter interval was not installed.");
			reconcileTick();
		},
	};
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
			locator: { cwd: repo, worktreeRoot: null, stateRoot: alternateStateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: 1,
		});
		const current = await index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: repo, worktreeRoot: null, stateRoot },
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
			locator: { cwd: alternateRepo, worktreeRoot: null, stateRoot: alternateStateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: alternateEndpointMtimeMs,
		});
		const current = await index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: repo, worktreeRoot: null, stateRoot: currentStateRoot },
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
			refreshIfChanged: async () => true,
			listSessions: () => ({
				indexSeq: 1,
				sessions: indexed.map(session => ({
					sessionId: session.sessionId,
					locator: { cwd: repo, worktreeRoot: null, stateRoot },
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
						sendMaintenance: () => {},
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

	test("bounds a never-settling attachment without stopping the router", async () => {
		const fixture = hungRouterFixture();
		const starting = fixture.router.start();
		try {
			await fixture.healthyPublished;
			const healthy = fixture.router.attachment("router-healthy");
			if (!healthy) throw new Error("Healthy attachment was not published.");
			expect(healthy.isCurrent()).toBe(true);
			expect(fixture.router.attachment("router-hung")).toBeNull();
			expect(fixture.hungConnections()).toBe(1);
			expect(fixture.deadlines.pending()).toBe(1);

			fixture.deadlines.fire();
			await starting;
			expect(fixture.router.isReady()).toBe(true);
			expect(fixture.reconciliations()).toBe(1);
			expect(fixture.router.attachment("router-healthy")).toBe(healthy);
			expect(healthy.isCurrent()).toBe(true);

			fixture.tick();
			await waitFor(() => fixture.hungConnections() === 2, "Hung endpoint was not retried.");
			expect(fixture.deadlines.pending()).toBe(1);
			fixture.deadlines.fire();
			await waitFor(() => fixture.reconciliations() === 2, "Reconciliation did not continue after the deadline.");
			expect(fixture.router.attachment("router-hung")).toBeNull();
			expect(fixture.router.attachment("router-healthy")).toBe(healthy);
			expect(healthy.isCurrent()).toBe(true);
		} finally {
			await fixture.router.stop();
			await starting;
		}
	});

	test("coalesces hung-endpoint poll ticks while keeping a healthy attachment dispatchable", async () => {
		const fixture = hungRouterFixture();
		const starting = fixture.router.start();
		try {
			await fixture.healthyPublished;
			fixture.deadlines.fire();
			await starting;
			const healthy = fixture.router.attachment("router-healthy");
			if (!healthy) throw new Error("Healthy attachment was not published.");

			fixture.tick();
			await waitFor(() => fixture.hungConnections() === 2, "Hung endpoint did not begin reconciliation.");
			for (let tick = 0; tick < 6; tick++) fixture.tick();
			const dispatched = Promise.resolve(healthy.send({ type: "healthy-dispatch" }));

			fixture.deadlines.fire();
			await waitFor(() => fixture.hungConnections() === 3, "Coalesced reconciliation did not begin.");
			expect(fixture.deadlines.pending()).toBe(1);
			fixture.deadlines.fire();
			const settled = await Promise.race([dispatched.then(() => true), Bun.sleep(250).then(() => false)]);
			expect(settled).toBe(true);
			expect(fixture.hungConnections()).toBe(3);
			expect(fixture.reconciliations()).toBe(3);
			expect(fixture.router.attachment("router-healthy")).toBe(healthy);
			expect(healthy.isCurrent()).toBe(true);
			expect(fixture.healthySent).toEqual([{ type: "healthy-dispatch" }]);
		} finally {
			await fixture.router.stop();
			await starting;
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

	test("preserves session.last_assistant projection results through the broker Router", async () => {
		const directResponse = {
			type: "query_response",
			id: "last-assistant",
			ok: true,
			page: { items: ["latest readable assistant text"], complete: true, revision: "1" },
		};
		const fixture = await routerFixture({ onRequest: () => directResponse });
		try {
			const request = {
				type: "query_request",
				id: "last-assistant",
				query: "session.last_assistant",
				input: {},
			};
			expect(await fixture.router.request(fixture.sessionId, request)).toEqual(directResponse);
			expect(fixture.clients[0]?.requests).toContainEqual(request);
		} finally {
			await fixture.router.stop();
		}
	});

	test("retains a notification subscription when a single publication is refused", async () => {
		// A provider that refuses ONE publication has already settled that frame as
		// rejected on its own side; the next frame normally succeeds. Cancelling the
		// subscription there latched notificationCancelled for the life of the
		// AttachedSession, and a still-running session never gets a new one, so its
		// mirroring stayed dead until that session was restarted.
		const delivered: string[] = [];
		const subscriptions: NotificationSubscription[] = [];
		let refuseNext = true;
		const fixture = await routerFixture({
			onNotificationSubscription: subscription => {
				subscriptions.push(subscription);
			},
			onNotificationFrame: (_subscription, frame) => {
				delivered.push(String(frame.name));
				if (!refuseNext) return;
				refuseNext = false;
				throw new Error("Telegram publication rejected before send: trusted attachment lease is stale");
			},
		});
		try {
			fixture.clients[0]?.emit({ type: "refused", sessionId: fixture.sessionId });
			await waitFor(() => delivered.length === 1, "The first notification frame was not dispatched.");
			await Bun.sleep(10);
			fixture.clients[0]?.emit({ type: "accepted", sessionId: fixture.sessionId });
			await waitFor(() => delivered.length === 2, "A single refused publication cancelled the subscription.");
			expect(delivered).toEqual(["refused", "accepted"]);
			expect(subscriptions[0]?.isActive()).toBe(true);
		} finally {
			await fixture.router.stop();
		}
	});

	test("ends the refusal run at the next delivered notification frame", async () => {
		// The bound is on CONSECUTIVE refusals. A provider that refuses four frames,
		// delivers one, then refuses four more never reaches the limit, so an
		// intermittent authority flip cannot accumulate into a cancellation.
		const delivered: string[] = [];
		const subscriptions: NotificationSubscription[] = [];
		let refuse = true;
		const fixture = await routerFixture({
			onNotificationSubscription: subscription => {
				subscriptions.push(subscription);
			},
			onNotificationFrame: (_subscription, frame) => {
				delivered.push(String(frame.name));
				if (refuse) throw new Error("publication refused");
			},
		});
		try {
			for (const round of ["a", "b"]) {
				for (let index = 0; index < 4; index++) {
					const expected = delivered.length + 1;
					fixture.clients[0]?.emit({ type: `${round}${index}`, sessionId: fixture.sessionId });
					await waitFor(() => delivered.length === expected, `Frame ${round}${index} was not dispatched.`);
					await Bun.sleep(5);
				}
				refuse = false;
				const accepted = delivered.length + 1;
				fixture.clients[0]?.emit({ type: `${round}-ok`, sessionId: fixture.sessionId });
				await waitFor(() => delivered.length === accepted, `Frame ${round}-ok was not dispatched.`);
				await Bun.sleep(5);
				refuse = true;
			}
			expect(delivered).toHaveLength(10);
			expect(subscriptions[0]?.isActive()).toBe(true);
		} finally {
			await fixture.router.stop();
		}
	});

	test("cancels a notification subscription after a bounded run of refusals", async () => {
		// The tolerance is bounded: a provider that never accepts anything is still
		// conceded, so a permanently broken subscription cannot be dispatched to
		// forever. The exact count is the contract -- the run, not the first frame.
		const delivered: string[] = [];
		const removals: string[] = [];
		const subscriptions: NotificationSubscription[] = [];
		const fixture = await routerFixture({
			onNotificationSubscription: subscription => {
				subscriptions.push(subscription);
			},
			onNotificationSubscriptionRemoved: (_subscription, reason) => {
				removals.push(String(reason));
			},
			onNotificationFrame: (_subscription, frame) => {
				delivered.push(String(frame.name));
				throw new Error("publication refused");
			},
		});
		try {
			for (let index = 0; index < 8; index++) {
				fixture.clients[0]?.emit({ type: `refused-${index}`, sessionId: fixture.sessionId });
				await Bun.sleep(10);
			}
			// Five consecutive refusals are dispatched; the sixth frame finds the
			// subscription already conceded and is never handed to the provider.
			expect(delivered).toEqual(["refused-0", "refused-1", "refused-2", "refused-3", "refused-4"]);
			expect(removals).toEqual(["cancelled"]);
			expect(subscriptions[0]?.isActive()).toBe(false);
			// Core attachment authority is untouched by a conceded subscription.
			expect(fixture.router.attachment(fixture.sessionId)?.isCurrent()).toBe(true);
		} finally {
			await fixture.router.stop();
		}
	});

	test("keeps a rejecting provider publication provisional", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fixture = await routerFixture({
			start: false,
			onAttachment: async () => {
				entered.resolve();
				await release.promise;
				throw new Error("provider publication rejected");
			},
		});
		const starting = fixture.router.start();
		await entered.promise;
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		const request = fixture.router.request(fixture.sessionId, { type: "query_request" });
		await Bun.sleep(10);
		expect(fixture.clients[0]?.requests.filter(frame => frame.type === "query_request")).toEqual([]);
		release.resolve();
		await expect(request).rejects.toBeInstanceOf(SessionRouterError);
		await starting;
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		await fixture.router.stop();
	});

	test("restarts cleanly when stop overlaps an in-flight startup", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fixture = await routerFixture({
			start: false,
			onAttachment: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const firstStart = fixture.router.start();
		await entered.promise;
		const stopping = fixture.router.stop();
		release.resolve();
		await stopping;
		await firstStart;
		await fixture.router.start();
		try {
			expect(fixture.router.attachment(fixture.sessionId)?.isCurrent()).toBe(true);
		} finally {
			await fixture.router.stop();
		}
	});

	test("holds live frames until provider publication succeeds", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const frames: SessionRouterFrame[] = [];
		const fixture = await routerFixture({
			start: false,
			onAttachment: async () => {
				entered.resolve();
				await release.promise;
			},
			onFrame: (_attachment, frame) => {
				frames.push(frame);
			},
		});
		const starting = fixture.router.start();
		await entered.promise;
		fixture.clients[0]?.emit({ type: "notification", sessionId: fixture.sessionId });
		await Bun.sleep(10);
		expect(frames).toEqual([]);
		release.resolve();
		await starting;
		await Bun.sleep(10);
		expect(frames).toHaveLength(1);
		await fixture.router.stop();
	});

	test("rejects a command carrying a different same-generation attachment", async () => {
		const fixture = await routerFixture();
		const impostor: SessionAttachment = Object.freeze({
			sessionId: fixture.sessionId,
			generation: 1,
			isCurrent: () => true,
			send: async () => {},
			sendMaintenance: () => {},
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
	test("dispatch observers never see the injected session endpoint token", async () => {
		const fixture = await routerFixture();
		try {
			const seen: Array<{ phase: string; token: unknown; operation: unknown }> = [];
			let maliciousTried = false;
			await fixture.router.request(
				fixture.sessionId,
				{ type: "user_message", id: "redact", message: "hi" },
				1,
				undefined,
				{
					timeoutMs: 1_500,
					beforeDispatch: context => {
						seen.push({ phase: "before", token: context.frame.token, operation: context.frame.operation });
						try {
							// A malicious observer tries to read, delete, and rewrite the
							// credential-bearing field on the callback frame.
							(context.frame as { token?: unknown }).token = "injected-by-observer";
						} catch {
							maliciousTried = true;
						}
					},
					onDispatch: context => {
						seen.push({ phase: "after", token: context.frame.token, operation: context.frame.operation });
					},
				},
			);
			const dispatched = fixture.clients[0]!;
			const index = dispatched.requests.findIndex(frame => frame.type === "user_message");
			expect(index).toBeGreaterThanOrEqual(0);
			// The wire frame the private client received still carries the stamped
			// endpoint token (the transport needs it); only the observer copy is redacted.
			expect(dispatched.requests[index]?.token).toBe("secret");
			// Neither callback phase observed the token.
			expect(seen).toHaveLength(2);
			for (const entry of seen) {
				expect(entry.token).toBeUndefined();
			}
			// The observer's attempted credential injection either threw on the
			// frozen frame or was a no-op — the wire token is unchanged either way,
			// and the wire frame itself was never the object the observer held.
			expect(dispatched.requests[index]?.token).toBe("secret");
			// Strict-mode mutation of the frozen observer frame throws TypeError —
			// the freeze held, and the wire token is untouched either way.
			expect(maliciousTried).toBe(true);
		} finally {
			await fixture.router.stop();
		}
	});

	test("threads dispatch-boundary callbacks through the supported router surface", async () => {
		const fixture = await routerFixture();
		try {
			const boundaries: string[] = [];
			const observedIds: string[] = [];
			await fixture.router.request(
				fixture.sessionId,
				{ type: "control_request", id: "boundary", operation: "turn.prompt", input: {} },
				1,
				undefined,
				{
					timeoutMs: 1_500,
					beforeDispatch: context => {
						boundaries.push(`before:${String(context.frame.operation)}`);
						observedIds.push(String(context.frame.id));
					},
					onDispatch: context => {
						boundaries.push(`after:${String(context.frame.operation)}:${context.generation > 0}`);
						observedIds.push(String(context.frame.id));
					},
				},
			);
			const dispatched = fixture.clients[0]!;
			const index = dispatched.requests.findIndex(frame => frame.type === "control_request");
			expect(index).toBeGreaterThanOrEqual(0);
			// The capability-scoped managed surface carries the observers down to
			// the private transport without exposing it or its credentials.
			const options = dispatched.requestOptions[index];
			expect(options?.timeoutMs).toBe(1_500);
			expect(typeof options?.beforeDispatch).toBe("function");
			expect(typeof options?.onDispatch).toBe("function");
			expect(boundaries).toEqual(["before:turn.prompt", "after:turn.prompt:true"]);
			expect(observedIds).toEqual(["boundary", "boundary"]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("preserves managed-router observer thenables for the client boundary", async () => {
		const fixture = await routerFixture({ invokeDispatchObservers: false });
		try {
			const beforeFailure = new Error("managed before failure");
			const afterFailure = new Error("managed after failure");
			await fixture.router.request(
				fixture.sessionId,
				{ type: "control_request", id: "thenable", operation: "turn.prompt", input: {} },
				1,
				undefined,
				{
					beforeDispatch: async () => {
						throw beforeFailure;
					},
					onDispatch: async () => {
						throw afterFailure;
					},
				},
			);
			const options = fixture.clients[0]?.requestOptions.at(-1);
			expect(options?.beforeDispatch).toBeDefined();
			expect(options?.onDispatch).toBeDefined();
			const context = {
				frame: { id: "client-generated", operation: "turn.prompt" },
				connectionId: "fixture-connection",
				generation: 1,
			};
			const beforeResult = options!.beforeDispatch!(context) as unknown as Promise<never>;
			const afterResult = options!.onDispatch!(context) as unknown as Promise<never>;
			await expect(beforeResult).rejects.toBe(beforeFailure);
			await expect(afterResult).rejects.toBe(afterFailure);
		} finally {
			await fixture.router.stop();
		}
	});

	test("publishes readiness only after capability authority becomes current", async () => {
		const phases: string[] = [];
		const fixture = await routerFixture({
			onAttachment: attachment => {
				phases.push(`attachment:${attachment.isCurrent()}`);
			},
			onAttachmentReady: attachment => {
				phases.push(`ready:${attachment.isCurrent()}`);
			},
		});
		try {
			expect(phases).toEqual(["attachment:false", "ready:true"]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("allows an awaited attachment handshake to send before Router replay", async () => {
		const phases: string[] = [];
		const fixture = await routerFixture({
			onAttachmentReady: async attachment => {
				phases.push("ready");
				await attachment.send({ type: "hello" });
				await attachment.send({ type: "event_replay", id: "provider-replay" });
				phases.push("handshake-sent");
			},
		});
		try {
			expect(phases).toEqual(["ready", "handshake-sent"]);
			expect(fixture.clients[0]?.sent.map(frame => frame.type)).toEqual(["hello", "event_replay"]);
			expect(fixture.clients[0]?.requests.map(frame => frame.type)).toEqual(["event_replay"]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("allows exact publication-time requests before Router replay", async () => {
		let router: SessionRouter | undefined;
		const phases: string[] = [];
		const fixture = await routerFixture({
			start: false,
			onAttachmentReady: async attachment => {
				phases.push("ready");
				await router?.request(
					attachment.sessionId,
					{ type: "register_provider", capability: "ui" },
					attachment.generation,
					attachment,
				);
				phases.push("registered");
			},
		});
		router = fixture.router;
		try {
			await router.start();
			expect(phases).toEqual(["ready", "registered"]);
			expect(fixture.clients[0]?.requests.map(frame => frame.type)).toEqual(["register_provider", "event_replay"]);
		} finally {
			await router.stop();
		}
	});

	test("rejects an exact publication-time request after endpoint replacement", async () => {
		let router: SessionRouter | undefined;
		let endpointFile = "";
		let sessionId = "";
		const fixture = await routerFixture({
			start: false,
			onAttachmentReady: async attachment => {
				fs.writeFileSync(
					endpointFile,
					JSON.stringify({ sessionId, url: "ws://router.test", token: "replacement", pid: 42 }),
				);
				if (!router) throw new Error("Router fixture unavailable");
				await expect(
					router.request(
						attachment.sessionId,
						{ type: "register_provider", capability: "ui" },
						attachment.generation,
						attachment,
					),
				).rejects.toMatchObject({ phase: "pre_send" });
			},
		});
		router = fixture.router;
		endpointFile = fixture.endpointFile;
		sessionId = fixture.sessionId;
		try {
			await router.start();
			expect(fixture.clients[0]?.requests.map(frame => frame.type)).toEqual([]);
		} finally {
			await router.stop();
		}
	});

	test("revalidates exact endpoint authority before publication handshake sends", async () => {
		let authority: { pid: number; endpointMtimeMs: number } | undefined;
		let endpointFile = "";
		let sessionId = "";
		const fixture = await routerFixture({
			start: false,
			onAttachmentReady: async attachment => {
				if (!authority) throw new Error("test authority unavailable");
				authority.pid = 43;
				fs.writeFileSync(
					endpointFile,
					JSON.stringify({ sessionId, url: "ws://router.test", token: "replacement", pid: 43 }),
				);
				authority.endpointMtimeMs = fs.statSync(endpointFile).mtimeMs;
				await attachment.send({ type: "hello" });
			},
		});
		authority = fixture.authority;
		endpointFile = fixture.endpointFile;
		sessionId = fixture.sessionId;
		await fixture.router.start();
		expect(fixture.clients[0]?.sent).toEqual([]);
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		await fixture.router.stop();
	});

	test("publishes reconnect successor without awaiting predecessor provider retirement", async () => {
		const entered = Promise.withResolvers<"replaced_same_generation">();
		const release = Promise.withResolvers<void>();
		const fixture = await routerFixture({
			onSessionRemoved: async (_attachment, reason) => {
				if (reason !== "replaced_same_generation") return;
				entered.resolve(reason);
				await release.promise;
			},
		});
		try {
			fs.writeFileSync(
				fixture.endpointFile,
				JSON.stringify({
					sessionId: fixture.sessionId,
					url: "ws://router.test",
					token: "replacement",
					pid: 43,
				}),
			);
			fixture.authority.pid = 43;
			fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
			fixture.clients[0]?.reconnect();
			await entered.promise;
			const reconciliation = fixture.router.reconcile();
			await Bun.sleep(25);
			expect(fixture.clients).toHaveLength(2);
			expect(fixture.router.attachment(fixture.sessionId)).not.toBeNull();
			release.resolve();
			await reconciliation;
			expect(fixture.clients).toHaveLength(2);
		} finally {
			release.resolve();
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

	test("delivers an unsequenced replay response ahead of a blocked sequenced event", async () => {
		const eventEntered = Promise.withResolvers<void>();
		const replayDelivered = Promise.withResolvers<void>();
		const releaseEvent = Promise.withResolvers<void>();
		const order: string[] = [];
		const fixture = await routerFixture({
			onFrame: async (_attachment, frame) => {
				if (frame.name === "event") {
					order.push("event-entered");
					eventEntered.resolve();
					await releaseEvent.promise;
					order.push("event-settled");
					return;
				}
				if (frame.name === "event_replay_result") {
					order.push("replay-response");
					replayDelivered.resolve();
					releaseEvent.resolve();
				}
			},
		});
		try {
			fixture.clients[0]?.emit({
				type: "event",
				sessionId: fixture.sessionId,
				generation: 1,
				seq: 1,
			});
			await eventEntered.promise;
			fixture.clients[0]?.emit({ type: "event_replay_result", id: "provider-replay", events: [] });
			const delivered = await Promise.race([
				replayDelivered.promise.then(() => true),
				Bun.sleep(250).then(() => false),
			]);
			expect(delivered).toBe(true);
			await Bun.sleep(10);
			expect(order).toEqual(["event-entered", "replay-response", "event-settled"]);
		} finally {
			releaseEvent.resolve();
			await fixture.router.stop();
		}
	});

	test("keeps lifecycle adoption provisional until a delayed index proves the exact authority", async () => {
		const fixture = await routerFixture({ initiallyIndexed: false });
		const endpoint = JSON.parse(fs.readFileSync(fixture.endpointFile, "utf8")) as Record<string, unknown>;
		const adopted = await fixture.router.adoptLifecycleResult(
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
		try {
			expect(adopted.isCurrent()).toBe(false);
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
			fixture.authority.indexed = true;
			await fixture.router.reconcile();
			expect(adopted.isCurrent()).toBe(true);
			expect(fixture.router.attachment(fixture.sessionId)).toBe(adopted);
		} finally {
			await fixture.router.stop();
		}
	});

	test("revokes lifecycle adoption when the index remains missing or terminal", async () => {
		const fixture = await routerFixture({ initiallyIndexed: false });
		const endpoint = JSON.parse(fs.readFileSync(fixture.endpointFile, "utf8")) as Record<string, unknown>;
		const adopted = await fixture.router.adoptLifecycleResult(
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
		try {
			await fixture.router.reconcile();
			expect(adopted.isCurrent()).toBe(false);
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		} finally {
			await fixture.router.stop();
		}

		const terminal = await routerFixture();
		const terminalEndpoint = JSON.parse(fs.readFileSync(terminal.endpointFile, "utf8")) as Record<string, unknown>;
		const terminalAdopted = await terminal.router.adoptLifecycleResult(
			{
				ok: true,
				result: {
					sessionId: terminal.sessionId,
					endpointGeneration: terminal.authority.generation,
					pid: terminal.authority.pid,
					endpointMtimeMs: terminal.authority.endpointMtimeMs,
					endpoint: terminalEndpoint,
				},
			},
			{ sessionId: terminal.sessionId, cwd: terminal.repo },
		);
		try {
			terminal.authority.terminalUncertain = true;
			await terminal.router.reconcile();
			expect(terminalAdopted.isCurrent()).toBe(false);
			expect(terminal.router.attachment(terminal.sessionId)).toBeNull();
		} finally {
			await terminal.router.stop();
		}
	});
	test("revokes an old attachment at send time before the periodic reconciliation tick", async () => {
		const fixture = await routerFixture();
		const firstAttachment = fixture.attachments[0]!;
		expect(firstAttachment.generation).toBe(1);
		fixture.authority.generation = 2;

		await expect(firstAttachment.send({ type: "reply", id: "ask", answer: "yes" })).rejects.toBeInstanceOf(
			SessionRouterError,
		);
		expect(fixture.clients).toHaveLength(2);
		expect(fixture.clients[0]?.sent).toEqual([]);
		expect(fixture.router.attachment(fixture.sessionId)?.generation).toBe(2);
		await fixture.router.stop();
	});
	test("revokes a same-generation predecessor when successor pid and mtime replace the endpoint", async () => {
		const fixture = await routerFixture();
		const predecessor = fixture.attachments[0]!;
		fs.writeFileSync(
			fixture.endpointFile,
			JSON.stringify({ sessionId: fixture.sessionId, url: "ws://router-successor", token: "successor", pid: 43 }),
		);
		fixture.authority.pid = 43;
		fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;

		await expect(predecessor.send({ type: "reply", id: "ask", answer: "yes" })).rejects.toBeInstanceOf(
			SessionRouterError,
		);
		expect(predecessor.isCurrent()).toBe(false);
		expect(fixture.router.attachment(fixture.sessionId)?.generation).toBe(1);
		expect(fixture.clients[0]?.sent).toEqual([]);
		await fixture.router.stop();
	});
	test("revokes an attachment when the endpoint pid disagrees with the indexed process", async () => {
		const fixture = await routerFixture();
		const attachment = fixture.attachments[0]!;
		fs.writeFileSync(
			fixture.endpointFile,
			JSON.stringify({ sessionId: fixture.sessionId, url: "ws://router.test", token: "secret", pid: 43 }),
		);

		await expect(attachment.send({ type: "reply", id: "ask", answer: "yes" })).rejects.toBeInstanceOf(
			SessionRouterError,
		);
		expect(attachment.isCurrent()).toBe(false);
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		await fixture.router.stop();
	});
	test("rejects an endpoint when the Broker index rotates during endpoint validation", async () => {
		let refreshCount = 0;
		let fixture!: RouterFixture;
		fixture = await routerFixture({
			start: false,
			onIndexRefresh: () => {
				refreshCount += 1;
				if (refreshCount !== 2) return;
				fs.writeFileSync(
					fixture.endpointFile,
					JSON.stringify({ sessionId: fixture.sessionId, url: "ws://router-race", token: "race", pid: 43 }),
				);
				fixture.authority.pid = 43;
				fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
			},
		});
		await fixture.router.start();
		try {
			expect(refreshCount).toBeGreaterThanOrEqual(2);
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		} finally {
			await fixture.router.stop();
		}
	});

	test("revokes attachments when Broker terminal authority is uncertain", async () => {
		const fixture = await routerFixture();
		const attachment = fixture.attachments[0]!;
		fixture.authority.terminalUncertain = true;

		await expect(attachment.send({ type: "reply", id: "ask", answer: "yes" })).rejects.toBeInstanceOf(
			SessionRouterError,
		);
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		expect(fixture.clients[0]?.sent).toEqual([]);
		await fixture.router.stop();
	});

	test("revokes an attachment when exact endpoint revalidation fails for a still-live index row", async () => {
		const fixture = await routerFixture();
		const attachment = fixture.attachments[0]!;
		fs.rmSync(fixture.endpointFile);

		await expect(attachment.send({ type: "reply", id: "ask", answer: "yes" })).rejects.toBeInstanceOf(
			SessionRouterError,
		);
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		expect(fixture.clients[0]?.sent).toEqual([]);
		await fixture.router.stop();
	});
	test("detaches and rejects requests while the Broker index has corruption warnings", async () => {
		const fixture = await routerFixture();
		fixture.authority.warnings = ["corrupt index suffix"];

		await expect(
			fixture.router.request(
				fixture.sessionId,
				{
					type: "control_request",
					id: "state",
					operation: "session.state",
					input: {},
				},
				1,
			),
		).rejects.toBeInstanceOf(SessionRouterError);
		expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		expect(fixture.clients[0]?.requests).toEqual([{ type: "event_replay", sinceSeq: 0, sinceGeneration: 1 }]);
		await fixture.router.stop();
	});
	test("rejects activation when the exact endpoint rotates after connecting", async () => {
		let fixture!: RouterFixture;
		fixture = await routerFixture({
			start: false,
			onClientCreated: () => {
				fs.writeFileSync(
					fixture.endpointFile,
					JSON.stringify({
						sessionId: fixture.sessionId,
						url: "ws://router-successor",
						token: "successor",
						pid: 43,
					}),
				);
				fixture.authority.pid = 43;
				fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
			},
		});
		try {
			await expect(fixture.router.activatePreparedSession(fixture.sessionId)).rejects.toMatchObject({
				code: "session_not_live",
			});
			expect(fixture.clients).toHaveLength(1);
			expect(fixture.clients[0]?.requests).toEqual([]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("does not publish an attachment when its endpoint rotates after the client connects", async () => {
		const preservedTimestamp = new Date(1_700_000_000_000);
		let readyCount = 0;
		let fixture!: RouterFixture;
		fixture = await routerFixture({
			start: false,
			onClientCreated: () => {
				fs.writeFileSync(
					fixture.endpointFile,
					JSON.stringify({
						sessionId: fixture.sessionId,
						url: "ws://router.test",
						token: "successor",
						pid: 42,
					}),
				);
				fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
				expect(fs.statSync(fixture.endpointFile).mtimeMs).toBe(fixture.authority.endpointMtimeMs);
			},
			onAttachmentReady: () => {
				readyCount += 1;
			},
		});
		fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
		fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
		try {
			await fixture.router.start();
			expect(fixture.clients).toHaveLength(1);
			expect(readyCount).toBe(0);
			expect(fixture.attachments).toHaveLength(0);
			expect(fixture.clients[0]?.requests).toEqual([]);
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
		} finally {
			await fixture.router.stop();
		}
	});

	test("publishes an attachment whose indexed canonical cwd is symlink-equivalent to the state root", async () => {
		// Locator cwd is canonical before index registration. The state root remains
		// host-provided, so Router resolves only its identity when determining the
		// endpoint scope; canonical cwd preserves attachment authority.
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
				sendMaintenance: () => {},
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

	test("rejects an endpoint rewritten after its indexed stat", async () => {
		const fixture = await routerFixture({ start: false });
		const realStat = fsPromises.lstat;
		let rewritten = false;
		const statSpy = spyOn(fsPromises, "lstat").mockImplementation((async (file, options) => {
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
		}) as typeof fsPromises.lstat);
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

	test("does not hold successor endpoint validation behind provider retirement", async () => {
		const endpointValidationEntered = Promise.withResolvers<void>();
		const releaseEndpointValidation = Promise.withResolvers<void>();
		const retirementEntered = Promise.withResolvers<void>();
		const releaseRetirement = Promise.withResolvers<void>();
		const fixture = await routerFixture({
			onSessionRemoved: async (_attachment, reason) => {
				if (reason !== "replaced_same_generation") return;
				retirementEntered.resolve();
				await releaseRetirement.promise;
			},
		});
		fs.writeFileSync(
			fixture.endpointFile,
			JSON.stringify({
				sessionId: fixture.sessionId,
				url: "ws://router.test",
				token: "replacement",
				pid: 43,
			}),
		);
		fixture.authority.pid = 43;
		fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
		const realStat = fsPromises.lstat;
		let blockedValidation = false;
		const statSpy = spyOn(fsPromises, "lstat").mockImplementation((async (file, options) => {
			const stat = await realStat(file, options);
			if (!blockedValidation && file === fixture.endpointFile) {
				blockedValidation = true;
				endpointValidationEntered.resolve();
				await releaseEndpointValidation.promise;
			}
			return stat;
		}) as typeof fsPromises.lstat);
		try {
			const reconciliation = fixture.router.reconcile();
			await endpointValidationEntered.promise;
			fixture.clients[0]?.reconnect();
			await retirementEntered.promise;
			releaseEndpointValidation.resolve();
			await Bun.sleep(25);
			expect(fixture.clients).toHaveLength(2);
			expect(fixture.router.attachment(fixture.sessionId)).not.toBeNull();
			releaseRetirement.resolve();
			await reconciliation;
			expect(fixture.clients).toHaveLength(2);
		} finally {
			releaseEndpointValidation.resolve();
			releaseRetirement.resolve();
			statSpy.mockRestore();
			await fixture.router.stop();
		}
	});

	test("classifies token-only and URL-only same-generation rotations as successors", async () => {
		const reasons: Array<"removed" | "replaced" | "replaced_same_generation" | undefined> = [];
		const fixture = await routerFixture({
			start: false,
			onSessionRemoved: (_attachment, reason) => {
				reasons.push(reason);
			},
		});
		const preservedTimestamp = new Date(1_700_000_000_000);
		fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
		fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
		const replaceEndpoint = (url: string, token: string): void => {
			fs.writeFileSync(fixture.endpointFile, JSON.stringify({ sessionId: fixture.sessionId, url, token, pid: 42 }));
			fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
			expect(fs.statSync(fixture.endpointFile).mtimeMs).toBe(fixture.authority.endpointMtimeMs);
		};
		try {
			await fixture.router.start();
			replaceEndpoint("ws://router.test", "rotated-token");
			await fixture.router.reconcile();
			replaceEndpoint("ws://router-successor", "rotated-token");
			await fixture.router.reconcile();
			expect(reasons).toEqual(["replaced_same_generation", "replaced_same_generation"]);
		} finally {
			await fixture.router.stop();
		}
	});

	test("classifies a reconnect token rotation as a same-generation successor", async () => {
		const reasons: Array<"removed" | "replaced" | "replaced_same_generation" | undefined> = [];
		const fixture = await routerFixture({
			start: false,
			onSessionRemoved: (_attachment, reason) => {
				reasons.push(reason);
			},
		});
		const preservedTimestamp = new Date(1_700_000_000_000);
		fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
		fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
		try {
			await fixture.router.start();
			fs.writeFileSync(
				fixture.endpointFile,
				JSON.stringify({
					sessionId: fixture.sessionId,
					url: "ws://router.test",
					token: "rotated-token",
					pid: 42,
				}),
			);
			fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
			expect(fs.statSync(fixture.endpointFile).mtimeMs).toBe(fixture.authority.endpointMtimeMs);
			fixture.clients[0]?.reconnect();
			for (let attempt = 0; reasons.length === 0 && attempt < 50; attempt++) await Bun.sleep(10);
			expect(reasons).toEqual(["replaced_same_generation"]);
		} finally {
			await fixture.router.stop();
		}
	});
	test("derives distinct durable authority IDs for token and URL rotations", async () => {
		const fixture = await routerFixture({ start: false });
		const preservedTimestamp = new Date(1_700_000_000_000);
		fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
		fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
		const replaceEndpoint = (url: string, token: string): void => {
			fs.writeFileSync(fixture.endpointFile, JSON.stringify({ sessionId: fixture.sessionId, url, token, pid: 42 }));
			fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
			expect(fs.statSync(fixture.endpointFile).mtimeMs).toBe(fixture.authority.endpointMtimeMs);
		};
		try {
			await fixture.router.start();
			const initialAuthorityId = fixture.router.attachment(fixture.sessionId)?.authorityId;
			replaceEndpoint("ws://router.test", "rotated-token");
			await fixture.router.reconcile();
			const tokenAuthorityId = fixture.router.attachment(fixture.sessionId)?.authorityId;
			replaceEndpoint("ws://router-successor", "rotated-token");
			await fixture.router.reconcile();
			const urlAuthorityId = fixture.router.attachment(fixture.sessionId)?.authorityId;
			expect(initialAuthorityId).toBeDefined();
			expect(tokenAuthorityId).toBeDefined();
			expect(urlAuthorityId).toBeDefined();
			expect(tokenAuthorityId).not.toBe(initialAuthorityId);
			expect(urlAuthorityId).not.toBe(tokenAuthorityId);
			expect(urlAuthorityId).not.toBe(initialAuthorityId);
		} finally {
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

	test("periodic reconcile converges while a rehosted attachment's replay is wedged (#4527)", async () => {
		// Reproduces the production wedge: a session-host rehost bumps
		// endpointGeneration, and the periodic reconcile replaces the attachment
		// with one whose event_replay never settles. Before the fix, that replay
		// was awaited inside the serialized reconcile tail, so every later tick
		// froze until the replay budget expired; publications died while leases
		// and inbound stayed green (#4527).
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
			refreshIfChanged: async () => true,
			listSessions: () => ({
				indexSeq: generation,
				sessions: [
					{
						sessionId,
						locator: { cwd: repo, worktreeRoot: null, stateRoot },
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
					sendMaintenance: () => {},
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

			// Bump generation and rewrite the endpoint file: the periodic
			// reconcile must replace the attachment. After the replacement,
			// the new host's event_replay never settles.
			generation = 2;
			await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://wedge.test", token: "v2", pid: 42 }));
			wedgeReplay = true;

			// A publication-driven reconcile can observe the rehost before the
			// periodic timer. It must publish and dispatch without awaiting the
			// replacement attachment's wedged replay on the shared tail.
			const requestSettled = await Promise.race([
				Bun.sleep(500).then(() => false),
				router.request(sessionId, { type: "test" }).then(() => true),
			]);
			expect(requestSettled).toBe(true);
			expect(reconcileCount).toBeGreaterThan(baseline);

			// A later periodic tick must also converge: the reconcile tail is not
			// held by the wedged replay living on the attachment's ready tail.
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

			// Explicit reconciliation preserves its synchronous replay contract,
			// but joins the per-attachment tail outside the serialized reconcile
			// tail so periodic fleet convergence remains independent.
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
	test("startup replay carries a bounded budget a wedged host cannot outlast", async () => {
		// A session host whose listener accepts while its loop never serves answers
		// nothing. On the transport's 10s default this attach-path replay made
		// start() the sum of every such session's budget -- four 10s timeouts plus
		// backoff, measured at 40.7s of a 40.9s startup for ONE host -- so
		// `gjc sdk session list` died on its own 10s startup budget while the other
		// attachments were already live. `start()` must bound the initial pass and
		// leave the stragglers to the periodic tick.
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-start-wedge-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const wedged = "start-wedged";
		const healthy = "start-healthy";
		const endpointFiles = new Map<string, string>();
		for (const sessionId of [wedged, healthy]) {
			const endpointFile = path.join(endpointDir, `${sessionId}.json`);
			await Bun.write(
				endpointFile,
				JSON.stringify({ sessionId, url: `ws://${sessionId}.test`, token: "v1", pid: 42 }),
			);
			endpointFiles.set(sessionId, endpointFile);
		}
		const replayRequests: string[] = [];
		const wedgedGate = Promise.withResolvers<void>();
		const index = {
			open: async () => {},
			refresh: async () => {},
			refreshIfChanged: async () => true,
			get indexSeq() {
				return 1;
			},
			listSessions: () => ({
				indexSeq: 1,
				sessions: [wedged, healthy].map(sessionId => ({
					sessionId,
					locator: { cwd: repo, worktreeRoot: repo, stateRoot },
					endpointGeneration: 1,
					pid: 42,
					endpointMtimeMs: fs.statSync(endpointFiles.get(sessionId)!).mtimeMs,
					live: true,
					indexSeq: 1,
					ambiguous: false,
					terminal: false,
				})),
				warnings: [],
			}),
		} as unknown as SessionIndex;
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async authority => ({
					onFrame: () => () => {},
					request: async (frame: Record<string, unknown>) => {
						if (frame.type !== "event_replay") return { events: [] };
						replayRequests.push(authority.sessionId);
						// The wedged host took the frame and answers nothing at all.
						if (authority.sessionId === wedged) await wedgedGate.promise;
						return { events: [] };
					},
					close: async () => {},
					send: () => {},
					sendMaintenance: () => {},
				}),
				startupAttachBudgetMs: 250,
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});

		const warnings: string[] = [];
		const warn = spyOn(logger, "warn").mockImplementation(message => {
			warnings.push(String(message));
		});
		try {
			const startedAt = performance.now();
			await router.start();
			const startMs = performance.now() - startedAt;
			// Bounded by the startup budget, not by the wedged host's request budget.
			expect(startMs).toBeLessThan(2_000);
			// The host that answered is attached and usable.
			expect(router.attachment(healthy)?.isCurrent()).toBe(true);
			// The wedged replay was attempted, and its pass is still parked on it.
			expect(replayRequests).toContain(wedged);
			// The lapse names the session and pid to look at, and no endpoint secret.
			const lapse = warnings.find(message => message.includes("startup returned before"));
			expect(lapse).toContain(wedged);
			expect(lapse).toContain("pid 42");
			expect(lapse).not.toContain(healthy);
			expect(warnings.join("\n")).not.toContain("v1");
		} finally {
			warn.mockRestore();
			wedgedGate.resolve();
			await router.stop();
		}
	});
	test("attach replay does not retry a frame the host took and never answered", async () => {
		// `uncertain_after_send` means the frame reached the socket and the peer
		// never answered within its budget. The retry ladder used to multiply that
		// one budget by four against a host that cannot answer any of them. One
		// attempt fails the barrier; the periodic tick owns the retry.
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-replay-nodup-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "replay-unanswered";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://unanswered.test", token: "v1", pid: 42 }));
		let replayAttempts = 0;
		let transientAttempts = 0;
		const transient = "replay-transient";
		const transientEndpoint = path.join(endpointDir, `${transient}.json`);
		await Bun.write(
			transientEndpoint,
			JSON.stringify({ sessionId: transient, url: "ws://transient.test", token: "v1", pid: 43 }),
		);
		const index = {
			open: async () => {},
			refresh: async () => {},
			refreshIfChanged: async () => true,
			get indexSeq() {
				return 1;
			},
			listSessions: () => ({
				indexSeq: 1,
				sessions: [
					{
						sessionId,
						locator: { cwd: repo, worktreeRoot: repo, stateRoot },
						endpointGeneration: 1,
						pid: 42,
						endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
						live: true,
						indexSeq: 1,
						ambiguous: false,
						terminal: false,
					},
					{
						sessionId: transient,
						locator: { cwd: repo, worktreeRoot: repo, stateRoot },
						endpointGeneration: 1,
						pid: 43,
						endpointMtimeMs: fs.statSync(transientEndpoint).mtimeMs,
						live: true,
						indexSeq: 1,
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
				createClient: async authority => ({
					onFrame: () => () => {},
					request: async (frame: Record<string, unknown>) => {
						if (frame.type !== "event_replay") return { events: [] };
						if (authority.sessionId === sessionId) {
							replayAttempts++;
							throw new SdkClientError(
								"uncertain_after_send",
								"SDK request outcome is uncertain after the frame was sent.",
							);
						}
						transientAttempts++;
						if (transientAttempts === 1) throw new SdkClientError("connection_closed", "closed before dispatch");
						return { events: [] };
					},
					close: async () => {},
					send: () => {},
					sendMaintenance: () => {},
				}),
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});

		try {
			await router.start();
			// Startup replay runs on the ready tail; wait for it to be attempted.
			for (let i = 0; i < 500 && replayAttempts === 0; i++) await Bun.sleep(1);
			// One dispatched-and-unanswered replay for that pass: no ladder, and no
			// further attempts even after the backoff window the ladder would use.
			await Bun.sleep(REPLAY_LADDER_WINDOW_MS);
			expect(replayAttempts).toBe(1);
			// A pre-dispatch failure keeps the retry ladder and converges in one pass.
			expect(transientAttempts).toBe(2);
			// The retry belongs to the next reconcile pass, not to the failed one.
			await router.reconcile();
			expect(replayAttempts).toBe(2);
		} finally {
			await router.stop();
		}
	});
	test("periodic reconcile polls an unchanged index without re-opening it (#4689)", async () => {
		// Idle-spin regression: before the fix, every 2s reconcile tick ran
		// index.open() — a locked full re-parse of the session index — forever,
		// burning CPU proportional to total index history per live session. The
		// polling path now goes through refreshIfChanged and must leave open()
		// untouched across ticks, while prompts keep working.
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4689-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "idle-poll";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://idle.test", token: "v1", pid: 42 }));
		let reconcileCount = 0;
		let tick: (() => void) | undefined;
		const calls = { open: 0, refresh: 0, refreshIfChanged: 0, listSessions: 0 };
		const index = {
			open: async () => {
				calls.open++;
			},
			refresh: async () => {
				calls.refresh++;
			},
			refreshIfChanged: async () => {
				calls.refreshIfChanged++;
				return calls.refreshIfChanged === 1;
			},
			get indexSeq() {
				return 1;
			},
			listSessions: () => {
				calls.listSessions++;
				return {
					indexSeq: 1,
					sessions: [
						{
							sessionId,
							locator: { cwd: repo, worktreeRoot: null, stateRoot },
							endpointGeneration: 1,
							pid: 42,
							endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
							live: true,
							indexSeq: 1,
							ambiguous: false,
							terminal: false,
						},
					],
					warnings: [],
				};
			},
		} as unknown as SessionIndex;
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => ({
					onFrame: () => () => {},
					request: async () => ({ events: [] }),
					close: async () => {},
					send: () => {},
					sendMaintenance: () => {},
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
			const baseline = { ...calls };
			const baselineReconciles = reconcileCount;
			for (let i = 0; i < 3; i++) {
				const before = reconcileCount;
				tick!();
				for (let spins = 0; spins < 500 && reconcileCount <= before; spins++) await Bun.sleep(1);
				expect(reconcileCount).toBeGreaterThan(before);
			}
			expect(reconcileCount).toBe(baselineReconciles + 3);
			// The polling path must never re-open the index, and the idle gate must
			// skip the projection body on unchanged ticks: three ticks cost exactly
			// three stamp checks and no extra listSessions() projection. (The first
			// tick's stamp reports changed once, which legitimately runs one body.)
			expect(calls.open).toBe(baseline.open);
			expect(calls.refreshIfChanged).toBe(baseline.refreshIfChanged + 3);
			expect(calls.listSessions).toBe(baseline.listSessions + 2);
			// Now that the stamp reports unchanged, further ticks must add ZERO
			// locked reads and ZERO projections: the gated tick is stat-only.
			const gated = { ...calls };
			for (let i = 0; i < 3; i++) {
				const before = reconcileCount;
				tick!();
				for (let spins = 0; spins < 500 && reconcileCount <= before; spins++) await Bun.sleep(1);
			}
			expect(calls.refreshIfChanged).toBe(gated.refreshIfChanged + 3);
			expect(calls.open).toBe(gated.open);
			expect(calls.refresh).toBe(gated.refresh);
			expect(calls.listSessions).toBe(gated.listSessions);
			// Prompt dispatch forces the exact body even on an unchanged index
			// (authority revalidation is never gated), and still settles fast.
			const beforeRequest = { ...calls };
			const requestSettled = await Promise.race([
				Bun.sleep(500).then(() => false),
				router.request(sessionId, { type: "test" }).then(() => true),
			]);
			expect(requestSettled).toBe(true);
			expect(calls.listSessions).toBeGreaterThan(beforeRequest.listSessions);
		} finally {
			await router.stop();
		}
	});
	test("idle sweep reruns the reconcile body without an index change (#4689)", async () => {
		// The gate must not park time-driven work forever: with the sweep due,
		// a tick runs the full body again even though the index is unchanged.
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4689-sweep-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "sweep";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://sweep.test", token: "v1", pid: 42 }));
		let tick: (() => void) | undefined;
		let reconcileCount = 0;
		let listSessionsCalls = 0;
		const index = {
			open: async () => {},
			refresh: async () => {},
			refreshIfChanged: async () => false,
			get indexSeq() {
				return 1;
			},
			listSessions: () => {
				listSessionsCalls++;
				return {
					indexSeq: 1,
					sessions: [
						{
							sessionId,
							locator: { cwd: repo, worktreeRoot: null, stateRoot },
							endpointGeneration: 1,
							pid: 42,
							endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
							live: true,
							indexSeq: 1,
							ambiguous: false,
							terminal: false,
						},
					],
					warnings: [],
				};
			},
		} as unknown as SessionIndex;
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => ({
					onFrame: () => () => {},
					request: async () => ({ events: [] }),
					close: async () => {},
					send: () => {},
					sendMaintenance: () => {},
				}),
				onReconciled: () => {
					reconcileCount++;
				},
				setInterval: ((callback: () => void) => {
					tick = callback;
					return 0;
				}) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
				idleSweepMs: 0,
			},
		});
		try {
			await router.start();
			expect(router.attachment(sessionId)?.isCurrent()).toBe(true);
			const baseline = listSessionsCalls;
			for (let i = 0; i < 2; i++) {
				const before = reconcileCount;
				tick!();
				for (let spins = 0; spins < 500 && reconcileCount <= before; spins++) await Bun.sleep(1);
				expect(reconcileCount).toBeGreaterThan(before);
			}
			expect(listSessionsCalls).toBeGreaterThan(baseline);
		} finally {
			await router.stop();
		}
	});
	test("an identical-byte rename during the pre-publication hook is refused at the commit (#4730 review)", async () => {
		// onAttachment runs BEFORE #publishAttachment commits. Replacing the
		// endpoint with identical bytes in that window matches url/token/pid at the
		// commit point, so only the proven inode can reject it. This exercises the
		// validation-to-publication window specifically.
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4730-publishwin-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "publish-window";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		const body = JSON.stringify({ sessionId, url: "ws://publishwin.test", token: "v1", pid: 42 });
		await Bun.write(endpointFile, body);
		const originalStat = fs.statSync(endpointFile);
		// The indexed mtime is fixed for the whole test: the replacement must be
		// indistinguishable from the original on every field except the inode.
		const indexedMtimeMs = Math.floor(originalStat.mtimeMs);
		await fsPromises.utimes(endpointFile, new Date(indexedMtimeMs), new Date(indexedMtimeMs));
		let replaceInHook = false;
		let replacedIno: number | bigint = originalStat.ino;
		const index = {
			open: async () => {},
			refresh: async () => {},
			refreshIfChanged: async () => true,
			get indexSeq() {
				return 1;
			},
			listSessions: () => ({
				indexSeq: 1,
				sessions: [
					{
						sessionId,
						locator: { cwd: repo, worktreeRoot: null, stateRoot },
						endpointGeneration: 1,
						pid: 42,
						endpointMtimeMs: indexedMtimeMs,
						live: true,
						indexSeq: 1,
						ambiguous: false,
						terminal: false,
					},
				],
				warnings: [],
			}),
		} as unknown as SessionIndex;
		let closedClients = 0;
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => ({
					onFrame: () => () => {},
					request: async () => ({ events: [] }),
					close: async () => {
						closedClients++;
					},
					send: () => {},
					sendMaintenance: () => {},
				}),
				onAttachment: async () => {
					if (!replaceInHook) return;
					// Identical bytes, and the replacement's own mtime becomes the
					// indexed authority, so every field the commit compares still
					// matches and ONLY the inode differs.
					const staging = `${endpointFile}.pubwin.tmp`;
					await Bun.write(staging, body);
					await fsPromises.rename(staging, endpointFile);
					// PRESERVE the indexed mtime across the rename (#4730 review): if the
					// replacement carried a new mtime, #readProvenEndpoint would reject on
					// the mtime fence before reaching the inode comparison, and this pin
					// would pass for a reason adjacent to the one it names.
					await fsPromises.utimes(endpointFile, new Date(indexedMtimeMs), new Date(indexedMtimeMs));
					replacedIno = fs.statSync(endpointFile).ino;
				},
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});
		try {
			// Control: without the in-hook replacement this setup publishes.
			await router.start();
			expect(router.attachment(sessionId)?.isCurrent()).toBe(true);
			await router.stop();
			closedClients = 0;

			replaceInHook = true;
			await router.start();
			// The inode is what changed; mtime is preserved, so only identity rejects.
			expect(Math.floor(fs.statSync(endpointFile).mtimeMs)).toBe(indexedMtimeMs);
			expect(replacedIno).not.toBe(originalStat.ino);
			// The replacement is refused at the commit point, so nothing is published.
			expect(router.attachment(sessionId) ?? undefined).toBeUndefined();
			expect(closedClients).toBe(1);
		} finally {
			await router.stop();
		}
	});
	test("sendMaintenance fails closed when the endpoint file is replaced under it (#4730 review)", async () => {
		// A replacement that preserves sessionId/pid/url/token and even mtime must
		// not keep the old attachment authorized: mtime is not a replacement-safe
		// identity. The inode is, so a rename-replace under the heartbeat has to
		// fail closed rather than renew a lease against a superseded endpoint.
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4730-hbrepl-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "hb-replaced";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		const body = JSON.stringify({ sessionId, url: "ws://hbrepl.test", token: "v1", pid: 42 });
		await Bun.write(endpointFile, body);
		let indexedMtimeMs = fs.statSync(endpointFile).mtimeMs;
		const sent: Record<string, unknown>[] = [];
		const index = {
			open: async () => {},
			refresh: async () => {},
			refreshIfChanged: async () => true,
			get indexSeq() {
				return 1;
			},
			listSessions: () => ({
				indexSeq: 1,
				sessions: [
					{
						sessionId,
						locator: { cwd: repo, worktreeRoot: null, stateRoot },
						endpointGeneration: 1,
						pid: 42,
						endpointMtimeMs: indexedMtimeMs,
						live: true,
						indexSeq: 1,
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
					request: async () => ({ events: [] }),
					close: async () => {},
					send: (frame: Record<string, unknown>) => {
						sent.push(frame);
					},
				}),
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});
		try {
			await router.start();
			const attachment = router.attachment(sessionId);
			expect(attachment?.isCurrent()).toBe(true);
			// Control: renewal works against the original record.
			await attachment!.sendMaintenance?.("lease-ok");
			expect(sent).toHaveLength(1);

			// Rename-replace the endpoint with identical bytes, then declare the
			// replacement's own mtime as the indexed authority so the mtime fence
			// PASSES and ONLY the inode can distinguish the new file. That is the
			// case a same-tick rename-over produces on a coarse filesystem.
			const originalIno = fs.statSync(endpointFile).ino;
			const staging = `${endpointFile}.repl.tmp`;
			await Bun.write(staging, body);
			await fsPromises.rename(staging, endpointFile);
			indexedMtimeMs = fs.statSync(endpointFile).mtimeMs;
			// Assert the collision the test depends on: the mtime fence cannot
			// reject this replacement, and the inode is the only difference. Without
			// this the test could pass through the mtime fence and prove nothing.
			const replaced = fs.statSync(endpointFile);
			expect(replaced.mtimeMs).toBe(indexedMtimeMs);
			expect(replaced.ino).not.toBe(originalIno);

			await expect(attachment!.sendMaintenance?.("lease-after-replace")).rejects.toThrow(
				/endpoint authority changed/i,
			);
			// No heartbeat frame was emitted for the superseded endpoint.
			expect(sent).toHaveLength(1);
		} finally {
			await router.stop();
		}
	});
	test("sendMaintenance fails closed when the endpoint is substituted with a symlink", async () => {
		const fixture = await routerFixture();
		const attachment = fixture.router.attachment(fixture.sessionId);
		const sent = fixture.clients[0]?.sent;
		expect(attachment?.isCurrent()).toBe(true);
		const originalPath = `${fixture.endpointFile}.original`;
		fs.renameSync(fixture.endpointFile, originalPath);
		fs.symlinkSync(originalPath, fixture.endpointFile);
		try {
			await expect(attachment!.sendMaintenance?.("lease-after-symlink")).rejects.toThrow(
				/endpoint authority changed/i,
			);
			expect(sent).toHaveLength(0);
			expect(attachment!.isCurrent()).toBe(true);
		} finally {
			await fixture.router.stop();
		}
	});
	test("retires and recreates a same-generation attachment after an identical-byte inode replacement", async () => {
		const reasons: Array<"removed" | "replaced" | "replaced_same_generation" | undefined> = [];
		const fixture = await routerFixture({
			start: false,
			onSessionRemoved: (_attachment, reason) => {
				reasons.push(reason);
			},
		});
		const preservedTimestamp = new Date(1_700_000_000_000);
		fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
		fixture.authority.endpointMtimeMs = fs.statSync(fixture.endpointFile).mtimeMs;
		try {
			await fixture.router.start();
			const predecessor = fixture.router.attachment(fixture.sessionId)!;
			const originalIno = fs.lstatSync(fixture.endpointFile).ino;
			const staging = `${fixture.endpointFile}.same-byte.tmp`;
			fs.writeFileSync(staging, fs.readFileSync(fixture.endpointFile));
			fs.renameSync(staging, fixture.endpointFile);
			fs.utimesSync(fixture.endpointFile, preservedTimestamp, preservedTimestamp);
			const replacement = fs.lstatSync(fixture.endpointFile);
			expect(replacement.ino).not.toBe(originalIno);
			expect(replacement.mtimeMs).toBe(fixture.authority.endpointMtimeMs);

			await fixture.router.reconcile();
			const successor = fixture.router.attachment(fixture.sessionId);
			expect(predecessor.isCurrent()).toBe(false);
			expect(successor).not.toBeNull();
			expect(successor).not.toBe(predecessor);
			expect(successor?.isCurrent()).toBe(true);
			expect(successor?.authorityId).not.toBe(predecessor.authorityId);
			await waitFor(() => reasons.length > 0, "same-generation predecessor was not retired");
			expect(reasons).toContain("replaced_same_generation");
		} finally {
			await fixture.router.stop();
		}
	});
	test("idle sweep retires an attachment whose row goes dead or stale (#4689 review)", async () => {
		// The sweep exists so time-driven transitions are still detected once the
		// 2s tick stopped projecting. Proving the body ran is not enough: the row
		// must actually be retired. Drive dead-PID and not-live transitions on an
		// otherwise unchanged index and assert the attachment is dropped.
		for (const transition of ["dead-pid", "not-live"] as const) {
			const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4689-retire-"));
			tempDirs.push(repo);
			const agentDir = path.join(repo, ".gjc", "agent");
			const stateRoot = path.join(repo, ".gjc", "state");
			const endpointDir = path.join(stateRoot, "sdk");
			await fsPromises.mkdir(endpointDir, { recursive: true });
			const sessionId = "retire";
			const endpointFile = path.join(endpointDir, `${sessionId}.json`);
			await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://retire.test", token: "v1", pid: 42 }));
			let tick: (() => void) | undefined;
			let reconcileCount = 0;
			// An unchanged index: only the row's liveness/pid changes, exactly the
			// class of transition the removed per-tick projection used to catch.
			let degraded = false;
			const index = {
				open: async () => {},
				refresh: async () => {},
				refreshIfChanged: async () => false,
				get indexSeq() {
					return 1;
				},
				listSessions: () => ({
					indexSeq: 1,
					sessions: [
						{
							sessionId,
							locator: { cwd: repo, worktreeRoot: null, stateRoot },
							endpointGeneration: 1,
							// A pid that cannot be alive stands in for a dead host.
							pid: degraded && transition === "dead-pid" ? 0x7ffffffe : 42,
							endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
							live: !(degraded && transition === "not-live"),
							indexSeq: 1,
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
						request: async () => ({ events: [] }),
						close: async () => {},
						send: () => {},
						sendMaintenance: () => {},
					}),
					onReconciled: () => {
						reconcileCount++;
					},
					setInterval: ((callback: () => void) => {
						tick = callback;
						return 0;
					}) as unknown as typeof setInterval,
					clearInterval: (() => {}) as unknown as typeof clearInterval,
					// Sweep every tick so the transition is timer-driven, not change-driven.
					idleSweepMs: 0,
				},
			});
			try {
				await router.start();
				expect(router.attachment(sessionId)?.isCurrent()).toBe(true);
				degraded = true;
				for (let i = 0; i < 3 && router.attachment(sessionId) != null; i++) {
					const before = reconcileCount;
					tick!();
					for (let spins = 0; spins < 500 && reconcileCount <= before; spins++) await Bun.sleep(1);
				}
				// The sweep must have retired it, with the index never reporting a change.
				expect(router.attachment(sessionId) ?? undefined).toBeUndefined();
			} finally {
				await router.stop();
			}
		}
	});
	test("a dispatch queued behind an idle tick escalates it to the exact body (#4689 review)", async () => {
		// tick() queues an unforced timer pass; a request arriving before it
		// starts must escalate that pass instead of dispatching behind an
		// idle-gated one.
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4689-force-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "force-escalation";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://force.test", token: "v1", pid: 42 }));
		let tick: (() => void) | undefined;
		let listSessionsCalls = 0;
		const index = {
			open: async () => {},
			refresh: async () => {},
			refreshIfChanged: async () => false,
			get indexSeq() {
				return 1;
			},
			listSessions: () => {
				listSessionsCalls++;
				return {
					indexSeq: 1,
					sessions: [
						{
							sessionId,
							locator: { cwd: repo, worktreeRoot: null, stateRoot },
							endpointGeneration: 1,
							pid: 42,
							endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
							live: true,
							indexSeq: 1,
							ambiguous: false,
							terminal: false,
						},
					],
					warnings: [],
				};
			},
		} as unknown as SessionIndex;
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => ({
					onFrame: () => () => {},
					request: async () => ({ events: [] }),
					close: async () => {},
					send: () => {},
				}),
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
			const baseline = listSessionsCalls;
			// Queue the timer pass and the forced dispatch synchronously: the
			// queued pass must run the body (escalated), not the idle gate.
			tick!();
			const requestSettled = await Promise.race([
				Bun.sleep(500).then(() => false),
				router.request(sessionId, { type: "test" }).then(() => true),
			]);
			expect(requestSettled).toBe(true);
			expect(listSessionsCalls).toBeGreaterThan(baseline);
		} finally {
			await router.stop();
		}
	});
	test("a live session whose attach failed is retried on the next tick, not the sweep (#4689 review)", async () => {
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4689-retry-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "retry-latch";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://retry.test", token: "v1", pid: 42 }));
		let tick: (() => void) | undefined;
		let refreshIfChangedCalls = 0;
		let listSessionsCalls = 0;
		let connectAttempts = 0;
		const index = {
			open: async () => {},
			refresh: async () => {},
			refreshIfChanged: async () => {
				refreshIfChangedCalls++;
				return refreshIfChangedCalls === 1;
			},
			get indexSeq() {
				return 1;
			},
			listSessions: () => {
				listSessionsCalls++;
				return {
					indexSeq: 1,
					sessions: [
						{
							sessionId,
							locator: { cwd: repo, worktreeRoot: null, stateRoot },
							endpointGeneration: 1,
							pid: 42,
							endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
							live: true,
							indexSeq: 1,
							ambiguous: false,
							terminal: false,
						},
					],
					warnings: [],
				};
			},
		} as unknown as SessionIndex;
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => {
					connectAttempts++;
					if (connectAttempts === 1) throw new Error("endpoint not reachable yet");
					return {
						onFrame: () => () => {},
						request: async () => ({ events: [] }),
						close: async () => {},
						send: () => {},
					};
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
			expect(router.attachment(sessionId)).toBeNull();
			expect(connectAttempts).toBe(1);
			const baselineListings = listSessionsCalls;
			// The index never changed, but the retry latch must bypass the idle
			// gate: the very next tick reruns the body and attaches.
			tick!();
			for (let spins = 0; spins < 500 && router.attachment(sessionId)?.isCurrent() !== true; spins++)
				await Bun.sleep(1);
			expect(router.attachment(sessionId)?.isCurrent()).toBe(true);
			expect(connectAttempts).toBe(2);
			expect(listSessionsCalls).toBeGreaterThan(baselineListings);
		} finally {
			await router.stop();
		}
	});
	test("sendMaintenance emits exactly a provider heartbeat without reconciling (#4689 review)", async () => {
		const repo = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-router-4689-hb-"));
		tempDirs.push(repo);
		const agentDir = path.join(repo, ".gjc", "agent");
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointDir = path.join(stateRoot, "sdk");
		await fsPromises.mkdir(endpointDir, { recursive: true });
		const sessionId = "heartbeat-shape";
		const endpointFile = path.join(endpointDir, `${sessionId}.json`);
		await Bun.write(endpointFile, JSON.stringify({ sessionId, url: "ws://hb.test", token: "v1", pid: 42 }));
		let refreshIfChangedCalls = 0;
		let openCalls = 0;
		let refreshCalls = 0;
		let listSessionsCalls = 0;
		const sent: Record<string, unknown>[] = [];
		const index = {
			open: async () => {
				openCalls++;
			},
			refresh: async () => {
				refreshCalls++;
			},
			refreshIfChanged: async () => {
				refreshIfChangedCalls++;
				return true;
			},
			get indexSeq() {
				return 1;
			},
			listSessions: () => {
				listSessionsCalls++;
				return {
					indexSeq: 1,
					sessions: [
						{
							sessionId,
							locator: { cwd: repo, worktreeRoot: null, stateRoot },
							endpointGeneration: 1,
							pid: 42,
							endpointMtimeMs: fs.statSync(endpointFile).mtimeMs,
							live: true,
							indexSeq: 1,
							ambiguous: false,
							terminal: false,
						},
					],
					warnings: [],
				};
			},
		} as unknown as SessionIndex;
		const router = new SessionRouter({
			agentDir,
			deps: {
				createIndex: () => index,
				createClient: async () => ({
					onFrame: () => () => {},
					request: async () => ({ events: [] }),
					close: async () => {},
					send: (frame: Record<string, unknown>) => {
						sent.push(frame);
					},
				}),
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		});
		try {
			await router.start();
			const attachment = router.attachment(sessionId);
			expect(attachment?.isCurrent()).toBe(true);
			const baseline = refreshIfChangedCalls;
			const lockedBaseline = { open: openCalls, refresh: refreshCalls, listSessions: listSessionsCalls };
			await attachment!.sendMaintenance?.("lease-9");
			// Exactly the heartbeat frame shape — no command traffic can take this
			// path — and no reconcile was triggered.
			expect(sent).toEqual([
				{
					type: "provider_heartbeat",
					leaseId: "lease-9",
				},
			]);
			expect(refreshIfChangedCalls).toBe(baseline);
			// The 5s heartbeat must never re-enter the LOCKED index path (#4730
			// review): its authority check reads only the endpoint record, so a
			// regression that routes it back through #readEndpoint (which ends in a
			// locked index refresh) restores the exact per-session cost #4689 removed.
			expect(openCalls).toBe(lockedBaseline.open);
			expect(refreshCalls).toBe(lockedBaseline.refresh);
			expect(listSessionsCalls).toBe(lockedBaseline.listSessions);
		} finally {
			await router.stop();
		}
	});
});
