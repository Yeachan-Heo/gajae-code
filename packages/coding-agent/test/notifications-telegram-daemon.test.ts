import { describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import { exactUnlinkNotificationFile, readNotificationEndpointFile } from "../src/sdk/bus/notification-service";
import type { NotificationOperatorRuntime } from "../src/sdk/bus/operator-runtime";
import {
	acquireDaemonOwnership,
	type BotApi,
	DAEMON_GENERATION,
	DAEMON_VERSION,
	type DaemonState,
	ensureTelegramDaemonRunningDetailed,
	hasSafeDaemonStateShape,
	readDaemonState,
	readOwnerFreshnessSnapshot,
	reclaimDeadDaemonOwner,
	renewDaemonHeartbeat,
	renewOwnerHeartbeatSidecar,
	SERVING_EPOCH,
	spawnTelegramDaemonOwner,
	type TelegramDaemonFs,
	TelegramNotificationDaemon,
	TelegramUpdatePoller,
	waitForTelegramDaemonReady,
} from "../src/sdk/bus/telegram-daemon";
import type { AgentDirSessionLifecycleService } from "../src/sdk/lifecycle/client";

const BOT_TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-supervisor-test-"));
}

function settings(agentDir: string): Settings {
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.enabled": true,
		"notifications.telegram.botToken": BOT_TOKEN,
		"notifications.telegram.chatId": "42",
	}) as Settings;
	return new Proxy(isolated, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function lifecycleSpy() {
	const calls: string[] = [];
	const service = {
		createExternal: async () => {
			calls.push("create");
			throw new Error("unexpected lifecycle create");
		},
		close: async () => {
			calls.push("close");
			throw new Error("unexpected lifecycle close");
		},
		resumeExternal: async () => {
			calls.push("resume");
			throw new Error("unexpected lifecycle resume");
		},
		listRecent: async () => ({ kind: "complete", entries: [], warnings: [] }),
	} as unknown as AgentDirSessionLifecycleService;
	return { calls, service };
}

async function writeDaemonOwner(agentDir: string, state: DaemonState): Promise<void> {
	const paths = daemonPaths(agentDir);
	await fs.promises.mkdir(paths.dir, { recursive: true });
	await Bun.write(paths.state, `${JSON.stringify(state)}\n`);
	await Bun.write(
		paths.lock,
		`${JSON.stringify({
			pid: state.pid,
			incarnation: state.incarnation,
			ownerId: state.ownerId,
			acquisitionId: state.acquisitionId,
			startedAt: state.startedAt,
		})}\n`,
	);
}

describe("Telegram provider supervisor ownership", () => {
	test("provider owner state contains transport authority but no session roots or credentials", () => {
		const state = {
			pid: 42,
			incarnation: "linux:100",
			ownerId: "owner",
			acquisitionId: "acquisition",
			ownershipPhase: "ready",
			tokenFingerprint: "account-fingerprint",
			chatId: "42",
			startedAt: 1,
			heartbeatAt: 2,
			version: 1,
			generation: DAEMON_GENERATION,
		};
		expect(hasSafeDaemonStateShape(state)).toBe(true);
		expect(state).not.toHaveProperty("roots");
		expect(JSON.stringify(state)).not.toContain(BOT_TOKEN);
	});

	test("constructing or restarting provider transport cannot mutate session lifecycle without an intent", () => {
		const agentDir = tempAgentDir();
		const lifecycle = lifecycleSpy();
		try {
			new TelegramNotificationDaemon({
				settings: settings(agentDir),
				ownerId: "provider-owner",
				botToken: BOT_TOKEN,
				chatId: "42",
				createLifecycleService: () => lifecycle.service,
			});
			expect(lifecycle.calls).toEqual([]);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("durably suppresses ambiguous publication claims after provider restart", async () => {
		const agentDir = tempAgentDir();
		const makeHarness = () =>
			new TelegramNotificationDaemon({
				settings: settings(agentDir),
				ownerId: "provider-owner",
				botToken: BOT_TOKEN,
				chatId: "42",
			}).publicationReceiptHarnessForTest();
		try {
			const first = makeHarness();
			await first.claimPublication("session:60:1");
			expect(first.publicationShouldSuppress("session:60:1")).toBe(false);

			const restartedWithClaim = makeHarness();
			await restartedWithClaim.loadPresentationState();
			expect(restartedWithClaim.publicationShouldSuppress("session:60:1")).toBe(false);

			let attemptedSettlementResolved = false;
			const attemptedSettlement = first.publicationSettlement("session:60:1").promise.then(() => {
				attemptedSettlementResolved = true;
			});
			await first.markPublicationAttempted("session:60:1");
			await Bun.sleep(0);
			expect(attemptedSettlementResolved).toBe(false);
			first.settlePublication("session:60:1");
			await attemptedSettlement;
			const restartedAmbiguous = makeHarness();
			await restartedAmbiguous.loadPresentationState();
			expect(restartedAmbiguous.publicationShouldSuppress("session:60:1")).toBe(true);

			await first.markPublicationDelivered("session:60:1");
			const restartedDelivered = makeHarness();
			await restartedDelivered.loadPresentationState();
			expect(restartedDelivered.publicationShouldSuppress("session:60:1")).toBe(true);

			await first.claimPublication("session:60:2");
			await first.markPublicationRejected("session:60:2");
			const restartedRejected = makeHarness();
			await restartedRejected.loadPresentationState();
			expect(restartedRejected.publicationShouldSuppress("session:60:2")).toBe(true);

			fs.writeFileSync(
				path.join(daemonPaths(agentDir).dir, "telegram-presentation-state.json"),
				`${JSON.stringify({ version: 1, delivered: { "legacy:60:1": Date.now() } })}\n`,
			);
			const restartedLegacy = makeHarness();
			await restartedLegacy.loadPresentationState();
			expect(restartedLegacy.publicationShouldSuppress("legacy:60:1")).toBe(false);

			fs.writeFileSync(
				path.join(daemonPaths(agentDir).dir, "telegram-presentation-state.json"),
				`${JSON.stringify({ version: 3, delivered: { "legacy-v3:delivered": Date.now() }, claimed: {}, ambiguous: { "legacy-v3:ambiguous": Date.now() } })}\n`,
			);
			const restartedV3 = makeHarness();
			await restartedV3.loadPresentationState();
			expect(restartedV3.publicationShouldSuppress("legacy-v3:delivered")).toBe(true);
			expect(restartedV3.publicationShouldSuppress("legacy-v3:ambiguous")).toBe(true);

			const oversizedClaims = Object.fromEntries(
				Array.from({ length: 4_097 }, (_, index) => [`oversized:67:${index}`, Date.now() + index]),
			);
			fs.writeFileSync(
				path.join(daemonPaths(agentDir).dir, "telegram-presentation-state.json"),
				`${JSON.stringify({ version: 4, delivered: {}, claimed: oversizedClaims, ambiguous: {}, rejected: {} })}\n`,
			);
			const restartedOversized = makeHarness();
			await restartedOversized.loadPresentationState();
			expect(restartedOversized.publicationShouldSuppress("oversized:67:0")).toBe(false);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("replays an explicitly rejected publication after rejection persistence failure", async () => {
		const agentDir = tempAgentDir();
		let persistenceFailures = 0;
		const durableFs = {
			...fs.promises,
			writeFile: async (file: string, data: string, options?: fs.WriteFileOptions): Promise<void> => {
				if (persistenceFailures > 0 && file.includes("telegram-presentation-state.json.")) {
					persistenceFailures -= 1;
					throw new Error("injected presentation persistence failure");
				}
				await fs.promises.writeFile(file, data, options);
			},
		} as unknown as TelegramDaemonFs;
		type PublicationReceiptHarness = {
			claimPublication(publicationId: string): Promise<void>;
			markPublicationAttempted(publicationId: string): Promise<void>;
			markPublicationRejected(publicationId: string, definitiveProviderRejection?: boolean): Promise<void>;
			loadPresentationState(): Promise<void>;
			publicationShouldSuppress(publicationId: string): boolean;
		};
		const makeHarness = (): PublicationReceiptHarness =>
			new TelegramNotificationDaemon({
				settings: settings(agentDir),
				ownerId: "provider-owner",
				botToken: BOT_TOKEN,
				chatId: "42",
				fs: durableFs,
			}).publicationReceiptHarnessForTest();
		const publicationId = "session:61:1";
		let providerAttempts = 0;
		const attempt = async (daemon: PublicationReceiptHarness): Promise<void> => {
			providerAttempts += 1;
			await daemon.markPublicationAttempted(publicationId);
		};
		try {
			const first = makeHarness();
			await first.claimPublication(publicationId);
			await attempt(first);
			persistenceFailures = 1;
			await expect(first.markPublicationRejected(publicationId, true)).rejects.toThrow(
				"injected presentation persistence failure",
			);

			const persisted = JSON.parse(
				fs.readFileSync(path.join(daemonPaths(agentDir).dir, "telegram-presentation-state.json"), "utf8"),
			) as {
				claimed?: Record<string, number>;
				ambiguous?: Record<string, number>;
				rejected?: Record<string, number>;
			};
			expect(persisted.claimed?.[publicationId]).toBeDefined();
			expect(persisted.ambiguous?.[publicationId]).toBeUndefined();
			expect(persisted.rejected?.[publicationId]).toBeUndefined();
			expect(providerAttempts).toBe(1);

			const restarted = makeHarness();
			await restarted.loadPresentationState();
			expect(restarted.publicationShouldSuppress(publicationId)).toBe(false);
			await restarted.claimPublication(publicationId);
			expect(providerAttempts).toBe(1);
			await attempt(restarted);
			expect(providerAttempts).toBe(2);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
	test("drops logical-session ownership when a router replacement retires its predecessor", async () => {
		const agentDir = tempAgentDir();
		try {
			const daemon = new TelegramNotificationDaemon({
				settings: settings(agentDir),
				ownerId: "provider-owner",
				botToken: BOT_TOKEN,
				chatId: "42",
			});
			const routing = daemon.attachmentRoutingHarnessForTest();
			const attachment = {
				sessionId: "session",
				generation: 1,
				isCurrent: () => true,
				send: () => {},
			};
			routing.attach(attachment);
			const session = daemon.sessions.get(attachment.sessionId);
			if (!session) throw new Error("Expected a routed Telegram attachment session.");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [],
			});
			expect(routing.ownsLogicalSession(attachment.sessionId)).toBe(true);

			await routing.remove(attachment, "replaced");

			expect(routing.ownsLogicalSession(attachment.sessionId)).toBe(false);
			expect(daemon.sessions.has(attachment.sessionId)).toBe(false);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
	test("strict topic admission quarantines ordinary endpoints and archives their orphaned topic", async () => {
		const agentDir = tempAgentDir();
		let now = 1_000;
		const calls: string[] = [];
		let scheduledCleanup: (() => void) | undefined;
		const botApi: BotApi = {
			call: async method => {
				calls.push(method);
				if (method === "closeForumTopic") return { ok: true, result: true };
				return { ok: true, result: { id: 42, type: "private", message_thread_id: 100 } };
			},
		};
		const statePath = path.join(daemonPaths(agentDir).dir, "telegram-topics.json");
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "provider-owner",
			botToken: BOT_TOKEN,
			chatId: "42",
			botApi,
			now: () => now,
			installationHostId: "provider-owner",
			requireTelegramTopicEligibility: true,
			setTimeoutImpl: callback => {
				scheduledCleanup = () => callback();
				return setTimeout(() => {}, 0);
			},
		});
		try {
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			fs.writeFileSync(
				statePath,
				`${JSON.stringify({
					version: 2,
					installationHostId: "provider-owner",
					topics: {
						ordinary: {
							topicId: "100",
							topicOrigin: "daemon_created",
							sessionUuid: "ordinary-topic",
							identitySent: true,
							createdAt: now,
							authorityState: "active",
							chatId: "42",
							endpointKey: "ordinary-endpoint",
							endpointDigest: "ordinary-digest",
							endpointGeneration: 1,
							endpointIncarnation: 0,
							leaseOwner: "provider-owner",
							leaseHeartbeatAt: now,
							leaseExpiresAt: now + 60_000,
						},
					},
				})}\n`,
			);
			await daemon.loadTopics();
			const routing = daemon.attachmentRoutingHarnessForTest();
			let retired = 0;
			const attachment = {
				sessionId: "ordinary",
				authorityId: "ordinary-endpoint-a",
				generation: 1,
				isCurrent: () => true,
				send: () => {},
				retire: async () => {
					retired += 1;
				},
			};
			routing.attach(attachment);
			const session = daemon.sessions.get(attachment.sessionId);
			if (!session) throw new Error("Expected a routed Telegram attachment session.");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [{ payload: { type: "identity_header", sessionId: "ordinary", telegramTopicsEnabled: false } }],
			});
			expect(retired).toBe(1);
			expect(daemon.sessions.has("ordinary")).toBe(false);
			expect(calls).toEqual([]);
			const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
				topics: { ordinary: { authorityState: string; orphanedAt?: number } };
			};
			expect(persisted.topics.ordinary).toMatchObject({ authorityState: "disconnect_grace", orphanedAt: now });

			routing.attach({ ...attachment });
			const quarantined = daemon.sessions.get(attachment.sessionId);
			if (!quarantined) throw new Error("Expected a quarantined Telegram attachment session.");
			await daemon.handleSessionMessage(quarantined, {
				type: "identity_header",
				sessionId: "ordinary",
				telegramTopicsEnabled: true,
			});
			expect(calls).toEqual([]);
			if (!scheduledCleanup) throw new Error("Expected rejected topic cleanup to be scheduled.");
			now += 60_001;
			scheduledCleanup();
			// The grace archival settles asynchronously; poll bounded instead of a
			// fixed sleep so heavy parallel suite load cannot flake this assertion.
			const deadline = Date.now() + 5_000;
			let archived: { topics: { ordinary: { authorityState: string } } };
			do {
				await Bun.sleep(25);
				archived = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
					topics: { ordinary: { authorityState: string } };
				};
			} while (archived.topics.ordinary.authorityState !== "inactive" && Date.now() < deadline);
			expect(calls).toContain("closeForumTopic");
			expect(archived.topics.ordinary.authorityState).toBe("inactive");
		} finally {
			daemon.requestStop();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("strict topic admission requires a loaded registry and an eligible replay identity", async () => {
		const agentDir = tempAgentDir();
		const calls: string[] = [];
		const botApi: BotApi = {
			call: async method => {
				calls.push(method);
				return { ok: true, result: { id: 42, type: "private", message_thread_id: 100 } };
			},
		};
		const daemon = new TelegramNotificationDaemon({
			settings: settings(agentDir),
			ownerId: "provider-owner",
			botToken: BOT_TOKEN,
			chatId: "42",
			botApi,
			requireTelegramTopicEligibility: true,
		});
		try {
			const routing = daemon.attachmentRoutingHarnessForTest();
			const unloadedAttachment = {
				sessionId: "eligible",
				authorityId: "eligible-unloaded",
				generation: 1,
				isCurrent: () => true,
				send: () => {},
			};
			routing.attach(unloadedAttachment);
			const unloaded = daemon.sessions.get(unloadedAttachment.sessionId);
			if (!unloaded) throw new Error("Expected a routed Telegram attachment session.");
			unloaded.replayPending = false;
			await daemon.handleSessionMessage(unloaded, {
				type: "identity_header",
				sessionId: "eligible",
				telegramTopicsEnabled: true,
			});
			expect(calls).toEqual([]);

			await daemon.loadTopics();
			const attachment = {
				...unloadedAttachment,
				authorityId: "eligible-loaded",
			};
			routing.attach(attachment);
			const session = daemon.sessions.get(attachment.sessionId);
			if (!session) throw new Error("Expected a routed Telegram attachment session.");
			await daemon.handleSessionMessage(session, {
				type: "event_replay_result",
				id: session.replayId,
				ok: true,
				generation: 1,
				lastSeq: 0,
				events: [{ payload: { type: "identity_header", sessionId: "eligible", telegramTopicsEnabled: true } }],
			});
			expect(calls.filter(method => method === "createForumTopic")).toHaveLength(1);
		} finally {
			daemon.requestStop();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("Telegram daemon retained owner lifecycle", () => {
	test("owner freshness accepts only a matching steady heartbeat sidecar", async () => {
		const agentDir = tempAgentDir();
		try {
			const daemonSettings = settings(agentDir);
			const pid = 701;
			let now = 1_000;
			const pidIncarnation = (value: number): string | undefined =>
				value === pid || value === process.pid ? `linux:${value}` : undefined;
			expect(
				await acquireDaemonOwnership({
					settings: daemonSettings,
					tokenFingerprint: "owner-fingerprint",
					chatId: "42",
					pid,
					pidIncarnation,
					now: () => now,
					randomId: () => "owner-a",
				}),
			).toMatchObject({ acquired: true, ownerId: "owner-a" });
			expect(
				await renewDaemonHeartbeat({
					settings: daemonSettings,
					ownerId: "owner-a",
					acquisitionId: "owner-a",
					pid,
					pidIncarnation,
					now: () => now,
				}),
			).toBe(true);

			now = 1_001;
			expect(
				await renewOwnerHeartbeatSidecar({
					settings: daemonSettings,
					ownerId: "owner-a",
					acquisitionId: "owner-a",
					pid,
					pidIncarnation,
					now: () => now,
				}),
			).toBe("renewed");
			expect((await readDaemonState(daemonSettings))?.heartbeatAt).toBe(1_000);
			expect((await readOwnerFreshnessSnapshot({ settings: daemonSettings })).effectiveHeartbeatAt).toBe(1_001);
			expect(
				await renewOwnerHeartbeatSidecar({
					settings: daemonSettings,
					ownerId: "other-owner",
					acquisitionId: "other-owner",
					pid,
					pidIncarnation,
				}),
			).toBe("not_owner");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("waits for a provisional owner to publish a ready heartbeat", async () => {
		const agentDir = tempAgentDir();
		try {
			const daemonSettings = settings(agentDir);
			const pid = 702;
			const pidIncarnation = (value: number): string | undefined =>
				value === pid || value === process.pid ? `linux:${value}` : undefined;
			expect(
				await acquireDaemonOwnership({
					settings: daemonSettings,
					tokenFingerprint: "readiness-fingerprint",
					chatId: "42",
					pid,
					pidIncarnation,
					now: () => 2_000,
					randomId: () => "ready-owner",
				}),
			).toMatchObject({ acquired: true });

			let published = false;
			expect(
				await waitForTelegramDaemonReady({
					settings: daemonSettings,
					ownerId: "ready-owner",
					acquisitionId: "ready-owner",
					pid,
					tokenFingerprint: "readiness-fingerprint",
					chatId: "42",
					pidAlive: value => value === pid,
					pidIncarnation,
					now: () => 2_000,
					waitStepMs: 1,
					timeoutMs: 10,
					sleep: async () => {
						if (published) return;
						published = true;
						expect(
							await renewDaemonHeartbeat({
								settings: daemonSettings,
								ownerId: "ready-owner",
								acquisitionId: "ready-owner",
								pid,
								pidIncarnation,
								now: () => 2_000,
							}),
						).toBe(true);
					},
				}),
			).toBe(true);
			expect(published).toBe(true);
			expect((await readDaemonState(daemonSettings))?.ownershipPhase).toBe("ready");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("reclaims only a confirmed-dead owner lock", async () => {
		const agentDir = tempAgentDir();
		try {
			const daemonSettings = settings(agentDir);
			const pid = 703;
			await writeDaemonOwner(agentDir, {
				pid,
				incarnation: "linux:703",
				ownerId: "dead-owner",
				acquisitionId: "dead-owner",
				ownershipPhase: "ready",
				tokenFingerprint: "dead-owner-fingerprint",
				chatId: "42",
				startedAt: 3_000,
				heartbeatAt: 3_000,
				version: DAEMON_VERSION,
				generation: DAEMON_GENERATION,
				servingEpoch: 1,
			});

			expect(
				await reclaimDeadDaemonOwner({
					settings: daemonSettings,
					now: () => 4_000,
					pidAlive: () => false,
					pidIncarnation: () => "linux:703",
				}),
			).toEqual({ recovered: true, reason: "cleared" });
			expect(await Bun.file(daemonPaths(agentDir).lock).exists()).toBe(false);
			expect((await readDaemonState(daemonSettings))?.ownerId).toBe("dead-owner");
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("reload handoff signals an incompatible live owner before spawning its replacement", async () => {
		const agentDir = tempAgentDir();
		try {
			const daemonSettings = settings(agentDir);
			const predecessorPid = 704;
			const launcherPid = 705;
			const successorPid = 706;
			const alive = new Set([predecessorPid]);
			const signals: Array<[number, NodeJS.Signals]> = [];
			let successorOwnerId: string | undefined;
			await writeDaemonOwner(agentDir, {
				pid: predecessorPid,
				incarnation: "linux:704",
				ownerId: "predecessor",
				acquisitionId: "predecessor",
				ownershipPhase: "ready",
				tokenFingerprint: tokenFingerprint(BOT_TOKEN),
				chatId: "42",
				startedAt: 5_000,
				heartbeatAt: 5_000,
				version: DAEMON_VERSION,
				generation: DAEMON_GENERATION - 1,
				servingEpoch: 1,
			});

			expect(
				await ensureTelegramDaemonRunningDetailed(
					{ settings: daemonSettings },
					{
						pid: launcherPid,
						now: () => 5_000,
						pidAlive: value => alive.has(value),
						pidIncarnation: value => `linux:${value}`,
						sendSignal: (pid, signal) => {
							signals.push([pid, signal]);
							if (signal === "SIGTERM") alive.delete(pid);
						},
						spawn: (_command, args) => {
							successorOwnerId = args[args.indexOf("--owner-id") + 1];
							alive.add(successorPid);
							return { pid: successorPid, unref: () => {} };
						},
						sleep: async () => {
							const ownerId = successorOwnerId;
							if (!ownerId) return;
							await renewDaemonHeartbeat({
								settings: daemonSettings,
								ownerId,
								acquisitionId: ownerId,
								pid: successorPid,
								pidIncarnation: value => `linux:${value}`,
								now: () => 5_000,
							});
						},
						waitStepMs: 1,
						readinessTimeoutMs: 10,
					},
				),
			).toBe("reloaded");
			expect(signals).toEqual([[predecessorPid, "SIGTERM"]]);
			expect(await readDaemonState(daemonSettings)).toMatchObject({
				pid: successorPid,
				ownerId: successorOwnerId,
				ownershipPhase: "ready",
				generation: DAEMON_GENERATION,
			});
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("spawn selection uses an opaque owner for detached launches", async () => {
		const sourceAgentDir = tempAgentDir();
		const compiledAgentDir = tempAgentDir();
		try {
			let sourceArgs: string[] | undefined;
			const source = await spawnTelegramDaemonOwner(
				{ settings: settings(sourceAgentDir), tokenFingerprint: "source-fingerprint", chatId: "42" },
				{
					execPath: "/usr/local/bin/bun",
					platform: "win32",
					pid: 707,
					pidIncarnation: () => "linux:707",
					randomId: () => "source-nonce",
					spawn: (_command, args) => {
						sourceArgs = args;
						return { unref: () => {} };
					},
				},
			);
			const compiled = await spawnTelegramDaemonOwner(
				{ settings: settings(compiledAgentDir), tokenFingerprint: "compiled-fingerprint", chatId: "42" },
				{
					execPath: "/opt/gjc/gjc",
					platform: "win32",
					pid: 708,
					pidIncarnation: () => "linux:708",
					randomId: () => "compiled-nonce",
					spawn: () => ({ unref: () => {} }),
				},
			);

			expect(source).toMatchObject({
				result: "owner_spawned",
				acquisition: { ownerId: "daemon-source-nonce", launcherPid: 707 },
				runtime: { mode: "source", reloadPicksUpSourceEdits: true },
			});
			expect(sourceArgs).toEqual(expect.arrayContaining(["--owner-id", "daemon-source-nonce"]));
			expect(compiled).toMatchObject({
				result: "owner_spawned",
				acquisition: { ownerId: "daemon-compiled-nonce", launcherPid: 708 },
				runtime: { mode: "compiled", reloadPicksUpSourceEdits: false },
			});
		} finally {
			fs.rmSync(sourceAgentDir, { recursive: true, force: true });
			fs.rmSync(compiledAgentDir, { recursive: true, force: true });
		}
	});
});

test("advances past a malformed-only getUpdates batch", async () => {
	const offsets: number[] = [];
	let calls = 0;
	const botApi: BotApi = {
		call: async (_method, body) => {
			offsets.push((body as { offset: number }).offset);
			calls++;
			return calls === 1 ? { ok: true, result: [{}] } : { ok: true, result: [{ update_id: 1 }] };
		},
	};
	const poller = new TelegramUpdatePoller({
		botApi,
		runtime: { sleep: async () => {} } as unknown as NotificationOperatorRuntime,
		backoff: { next: () => 1, reset: () => {} },
		processUpdate: async () => "consumed",
	});
	expect((await poller.pollOnceResult()).kind).toBe("api_failure");
	expect((await poller.pollOnceResult()).kind).toBe("success");
	expect(offsets).toEqual([0, 1]);
});
test("a throwing run-loop heartbeat renewal is contained and the daemon keeps serving (#4200)", async () => {
	const runScenario = async (throwPath: "state" | "lock"): Promise<void> => {
		const agentDir = tempAgentDir();
		const daemonSettings = settings(agentDir);
		const paths = daemonPaths(agentDir);
		const now = 0;
		// The refactored daemon renews a ready ownership state in-process: write
		// the exact ready state + lock and inject the same fixed pid/incarnation
		// into the daemon so its startup ownership proof matches.
		const pid = process.pid;
		const incarnation = "linux:4241";
		await writeDaemonOwner(agentDir, {
			pid,
			incarnation,
			ownerId: "owner",
			acquisitionId: "owner",
			ownershipPhase: "ready",
			tokenFingerprint: tokenFingerprint(BOT_TOKEN),
			chatId: "42",
			startedAt: now,
			heartbeatAt: now,
			version: DAEMON_VERSION,
			generation: DAEMON_GENERATION,
			servingEpoch: SERVING_EPOCH,
		});

		const timers = new Map<number, { ms: number; callback: () => void }>();
		let nextTimerId = 1;
		let pollCount = 0;
		const pollGate = Promise.withResolvers<void>();
		const firstPollEntered = Promise.withResolvers<void>();
		const thirdPollEntered = Promise.withResolvers<void>();
		const thirdPollParked = Promise.withResolvers<void>();

		// Simulate a transient Windows EPERM on the ownership-state or
		// ownership-lock read: the renewal throws instead of returning
		// publish_failed, and the run loop's containment must keep the daemon
		// alive and serving.
		let armedRead = false;
		const failingPath = throwPath === "state" ? paths.state : paths.lock;
		const flakyFs: TelegramDaemonFs = {
			...(fs.promises as unknown as TelegramDaemonFs),
			// The daemon's startup ownership proof and the transition lock need the
			// identity-stable endpoint read/exact-unlink seams (same as nodeFs).
			readEndpointFile: readNotificationEndpointFile,
			exactUnlink: async (file, identity) =>
				exactUnlinkNotificationFile(file, identity, `transition-test-${crypto.randomUUID()}`),
			readFile: async (file, encoding) => {
				if (armedRead && String(file) === failingPath) {
					const error = new Error("EPERM: operation not permitted, read") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return await fs.promises.readFile(file as string, encoding as BufferEncoding);
			},
		};

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const escaped: unknown[] = [];
		const onEscape = (reason: unknown): void => void escaped.push(reason);
		process.on("unhandledRejection", onEscape);
		try {
			const daemon = new TelegramNotificationDaemon({
				settings: daemonSettings,
				ownerId: "owner",
				botToken: BOT_TOKEN,
				chatId: "42",
				fs: flakyFs,
				now: () => now,
				pid,
				pidIncarnation: () => incarnation,
				idleTimeoutMs: 60_000,
				createLifecycleService: () => lifecycleSpy().service,
				botApi: {
					async call(method: string): Promise<unknown> {
						if (method === "getUpdates") {
							pollCount += 1;
							if (pollCount === 1) {
								// Synchronize on the first gated poll instead of sleeping: on
								// a slow or loaded runner daemon startup can outlast any fixed
								// delay, which would arm the read failure on the startup path
								// rather than the steady-state renewal under test.
								firstPollEntered.resolve();
								await pollGate.promise;
							} else if (pollCount === 3) {
								thirdPollEntered.resolve();
								// Park the loop between renewals so the staging-file assertion
								// below cannot race an in-flight renewal.
								await thirdPollParked.promise;
							}
						}
						return { ok: true, result: [] };
					},
				},
				setIntervalImpl: ((callback: () => void, ms: number) => {
					const id = nextTimerId++;
					timers.set(id, { ms, callback });
					return id as unknown as NodeJS.Timeout;
				}) as typeof setInterval,
				clearIntervalImpl: ((id: number) => {
					timers.delete(id);
				}) as unknown as typeof clearInterval,
			});

			const runPromise = daemon.run();
			// The daemon is now inside its first gated getUpdates; the startup
			// renewal already completed unarmed.
			await firstPollEntered.promise;

			// Arm the read EPERM and release the poll: the loop re-enters its
			// top, the renewal throws, and the containment must log + continue.
			armedRead = true;
			pollGate.resolve();
			for (let attempts = 0; attempts < 100; attempts++) {
				if (warn.mock.calls.some(call => String(call[0]).includes("ownership heartbeat renewal threw"))) break;
				await Bun.sleep(10);
			}
			expect(warn.mock.calls.some(call => String(call[0]).includes("ownership heartbeat renewal threw"))).toBe(true);
			expect((daemon as unknown as { running: boolean }).running).toBe(true);
			expect(escaped).toEqual([]);

			// Park at the third poll: the previous thrown renewals have fully
			// unwound, so any surviving staging file proves a leak. A thrown
			// ownership-lock read after the staging write must be unlinked by
			// the renewal helper; a thrown state read never writes a staging
			// file at all.
			await thirdPollEntered.promise;
			expect(fs.readdirSync(path.dirname(paths.heartbeat)).filter(name => name.endsWith(".tmp"))).toEqual([]);

			// The transient condition clears and the daemon is still serving.
			armedRead = false;
			thirdPollParked.resolve();
			expect((daemon as unknown as { running: boolean }).running).toBe(true);
			expect(escaped).toEqual([]);

			daemon.requestStop();
			await runPromise;
			expect(timers.size).toBe(0);
			if (fs.existsSync(paths.lock)) {
				expect(
					warn.mock.calls.some(
						call =>
							String(call[0]).includes("shutdown was not durably quiesced") ||
							String(call[0]).includes("heartbeat join timed out"),
					),
				).toBe(true);
			} else {
				expect(escaped).toEqual([]);
			}
		} finally {
			process.off("unhandledRejection", onEscape);
			warn.mockRestore();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	};
	await runScenario("state");
	await runScenario("lock");
});
