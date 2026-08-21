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
			expect(fixture.attachments).toHaveLength(1);
			expect(fixture.attachments[0]?.isCurrent()).toBe(false);
			expect(fixture.clients[0]?.requests).toEqual([]);
			expect(fixture.router.attachment(fixture.sessionId)).toBeNull();
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
		const realStat = fsPromises.stat;
		let blockedValidation = false;
		const statSpy = spyOn(fsPromises, "stat").mockImplementation((async (file, options) => {
			const stat = await realStat(file, options);
			if (!blockedValidation && file === fixture.endpointFile) {
				blockedValidation = true;
				endpointValidationEntered.resolve();
				await releaseEndpointValidation.promise;
			}
			return stat;
		}) as typeof fsPromises.stat);
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
});
