import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache, getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { assertMasterLaunchDisposition, createMasterModeContext } from "@gajae-code/coding-agent/master-mode/context";
import {
	createMasterPeerSnapshotContributor,
	MASTER_PEER_SNAPSHOT_CUSTOM_TYPE,
} from "@gajae-code/coding-agent/master-mode/first-request";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import type { SessionListOutcome } from "@gajae-code/coding-agent/sdk/lifecycle/service";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import { createMasterCapabilityVerifier, readEndpoint } from "../src/sdk/broker/master-capability";
import { type IndexedSession, SessionIndex } from "../src/sdk/broker/session-index";
import { createNotificationsExtension } from "../src/sdk/bus";
import { SessionSdkSessionRuntime } from "../src/sdk/host/session-runtime";
import {
	cleanupFixtureRoot,
	createNotificationFixtureRoot,
	isolatedNotificationSettings,
} from "./helpers/notification-settings";

const authStorages: AuthStorage[] = [];
const tempDirs: string[] = [];

async function createSession(master: boolean) {
	const tempDir = path.join(os.tmpdir(), `gjc-master-mode-${Snowflake.next()}`);
	tempDirs.push(tempDir);
	fs.mkdirSync(tempDir, { recursive: true });
	const settings = Settings.isolated({});
	settings.override("recipe.enabled", false);
	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorages.push(authStorage);
	return createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.inMemory(),
		authStorage,
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		...(master ? { masterModeContext: createMasterModeContext("repo", "master-owner", "epoch-test") } : {}),
	});
}

afterEach(() => {
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}

function hasMasterAttestation(
	rows: readonly IndexedSession[],
	sessionId: string,
	epoch: string,
	ownerSessionId = sessionId,
): boolean {
	const matches = (row: IndexedSession | undefined): boolean =>
		row?.masterRole?.version === 2 &&
		row.masterRole.ownerSessionId === ownerSessionId &&
		row.masterRole.launchPid === process.pid &&
		row.masterRole.role === "master" &&
		row.masterRole.attestationEpoch === epoch;
	return (
		matches(rows.find(row => row.sessionId === sessionId && row.endpointGeneration === 0)) &&
		matches(rows.find(row => row.sessionId === sessionId && row.endpointGeneration > 0))
	);
}

async function waitForMasterAttestation(
	agentDir: string,
	sessionId: string,
	epoch: string,
	ownerSessionId = sessionId,
): Promise<void> {
	await waitFor(async () => {
		const index = await new SessionIndex(agentDir).open();
		return hasMasterAttestation(index.listSessionIdentities(), sessionId, epoch, ownerSessionId);
	}, `master attestation for ${sessionId}`);
}

async function assertVerifiableMasterAttachment(
	agentDir: string,
	sessionId: string,
	epoch: string,
	ownerSessionId = sessionId,
): Promise<SessionIndex> {
	const index = await new SessionIndex(agentDir).open();
	await index.refresh();
	const rows = index.listSessionIdentities();
	const direct = rows.find(row => row.sessionId === sessionId && row.endpointGeneration === 0);
	const effective = rows.find(row => row.sessionId === sessionId && row.endpointGeneration > 0);
	expect(hasMasterAttestation(rows, sessionId, epoch, ownerSessionId)).toBe(true);
	expect(direct?.hostIncarnation ?? direct?.processIncarnation).toBe(direct?.masterRole?.launchProcessIncarnation);
	expect(effective).toMatchObject({ live: true, terminal: false, ambiguous: false });
	expect(effective?.hostIncarnation ?? effective?.processIncarnation).toBe(
		effective?.masterRole?.launchProcessIncarnation,
	);
	if (!effective) throw new Error("Expected effective master host");
	const endpointPath = path.join(effective.locator.stateRoot, "sdk", `${effective.sessionId}.json`);
	const [endpointStat, endpointIdentity] = await Promise.all([
		fs.promises.stat(endpointPath),
		fs.promises.stat(endpointPath, { bigint: true }),
	]);
	const endpointFileId = effective.endpointFileId;
	const endpointMtimeMs = effective.endpointMtimeMs;
	if (endpointFileId === undefined || endpointMtimeMs === undefined)
		throw new Error("Expected effective master host endpoint identity");
	expect(`${endpointIdentity.dev}:${endpointIdentity.ino}`).toBe(endpointFileId);
	expect(endpointStat.mtimeMs).toBe(endpointMtimeMs);
	expect(await readEndpoint(effective)).toBeDefined();
	return index;
}

function configuredNotificationSettings(agentDir: string): Settings {
	return isolatedNotificationSettings(agentDir, {
		"notifications.enabled": true,
		"notifications.discord.botToken": "discord-token",
		"notifications.discord.applicationId": "discord-app",
		"notifications.discord.guildId": "discord-guild",
		"notifications.discord.parentChannelId": "discord-parent",
	});
}

describe("master launch admission", () => {
	// Every noninteractive master route must fail admission. The prepared-input
	// non-TTY case is the dangerous one: it resolves to autoPrint with NO
	// nonInteractiveError, so a guard nested under that error is skipped.
	const routes = [
		{ name: "non-TTY with prepared input (autoPrint, no error)", isInteractive: false, autoPrint: true },
		{ name: "non-TTY with no input", isInteractive: false, autoPrint: false, nonInteractiveError: "no input" },
		{ name: "auto-print while a TTY is attached", isInteractive: true, autoPrint: true },
	];
	for (const route of routes) {
		it(`refuses --master on a ${route.name}`, () => {
			expect(() =>
				assertMasterLaunchDisposition({
					master: true,
					isInteractive: route.isInteractive,
					autoPrint: route.autoPrint,
					...(route.nonInteractiveError === undefined ? {} : { nonInteractiveError: route.nonInteractiveError }),
				}),
			).toThrow("--master requires an interactive TTY launch");
		});
	}

	it("admits an interactive master launch and ignores non-master routes", () => {
		expect(() =>
			assertMasterLaunchDisposition({ master: true, isInteractive: true, autoPrint: false }),
		).not.toThrow();
		expect(() =>
			assertMasterLaunchDisposition({ master: undefined, isInteractive: false, autoPrint: true }),
		).not.toThrow();
	});
});

describe("master mode prompt integration", () => {
	it("appends the master guidance block exactly once for master sessions", async () => {
		const { session } = await createSession(true);
		try {
			const prompt = session.systemPrompt.join("\n\n");
			expect(countOccurrences(prompt, "# Master Mode")).toBe(1);
			expect(prompt).toContain("gjc sdk spawn --cwd");
			expect(prompt).toContain("--idempotency-key <key>");
			expect(prompt).toContain("gjc sdk session raw global --op session.close");
			expect(prompt).not.toContain("gjc sdk session close");
			// The guidance block is the LAST segment: appended after every other
			// prompt transformation.
			expect(session.systemPrompt.at(-1)).toContain("# Master Mode");
		} finally {
			await session.dispose();
		}
	});

	it("gives non-master sessions neither guidance nor peer data", async () => {
		const { session } = await createSession(false);
		try {
			const prompt = session.systemPrompt.join("\n\n");
			expect(prompt).not.toContain("# Master Mode");
			expect(prompt).not.toContain("gjc-master-peer-snapshot");
		} finally {
			await session.dispose();
		}
	});
});

describe("master peer snapshot contributor", () => {
	const resultFor = (cwd: string, worktreeRoot: string | null): SessionListOutcome =>
		({
			ok: true as const,
			operation: "session.list",
			result: {
				version: 1,
				scope: {
					version: 1,
					requested: "repo",
					requestAnchor: { cwd, worktreeRoot },
					resolved: worktreeRoot === null ? null : { kind: "repo", worktreeRoot },
					resolution: worktreeRoot === null ? "not-in-git-worktree" : "resolved",
				},
				status: worktreeRoot === null ? "not-in-git-worktree" : "populated",
				observedAt: "2026-08-23T00:00:00.000Z",
				indexSeq: 3,
				rows:
					worktreeRoot === null
						? []
						: [
								{ id: "peer-b", locator: { cwd, worktreeRoot, stateRoot: `${cwd}/.gjc/state` }, live: true },
								{
									id: "master-owner",
									locator: { cwd, worktreeRoot, stateRoot: `${cwd}/.gjc/state` },
									live: true,
								},
								{ id: "peer-a", locator: { cwd, worktreeRoot, stateRoot: `${cwd}/.gjc/state` }, live: false },
							],
				warnings: [],
			},
		}) as unknown as SessionListOutcome;

	it("collects once, excludes self, and skips after a persisted injection", async () => {
		const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-master-contrib-")));
		tempDirs.push(cwd);
		let listCalls = 0;
		let persisted = false;
		const contributor = createMasterPeerSnapshotContributor({
			lifecycle: {
				list: async request => {
					listCalls += 1;
					const scope = (
						request.target as { scope?: { requestAnchor?: { cwd: string; worktreeRoot: string | null } } }
					).scope;
					return resultFor(scope?.requestAnchor?.cwd ?? cwd, scope?.requestAnchor?.worktreeRoot ?? null);
				},
			},
			ownerSessionId: "master-owner",
			scope: "repo",
			getCwd: () => cwd,
			hasPersistedInjection: () => persisted,
		});
		const first = await contributor();
		expect(listCalls).toBe(1);
		expect(first?.customType).toBe(MASTER_PEER_SNAPSHOT_CUSTOM_TYPE);
		expect(first?.content.startsWith("<gjc-master-peer-snapshot>")).toBe(true);
		expect(first?.content.endsWith("</gjc-master-peer-snapshot>")).toBe(true);
		expect(first?.content).not.toContain('"master-owner"');
		// Pre-accept cancellation persists nothing: the next attempt re-collects.
		const retry = await contributor();
		expect(listCalls).toBe(2);
		expect(retry).toBeDefined();
		// A persisted injection proves an accepted first request: later turns skip.
		persisted = true;
		expect(await contributor()).toBeUndefined();
		expect(listCalls).toBe(2);
	});

	it("degrades to undefined on lifecycle failure without throwing", async () => {
		const errors: unknown[] = [];
		const contributor = createMasterPeerSnapshotContributor({
			lifecycle: {
				list: async () => {
					throw new Error("broker unavailable");
				},
			},
			ownerSessionId: "master-owner",
			scope: "repo",
			getCwd: () => "/nonexistent-master-cwd",
			hasPersistedInjection: () => false,
		});
		// collectMasterPeerSnapshot converts list failures into an unavailable
		// snapshot; the contributor still renders it truthfully.
		const message = await contributor();
		expect(message === undefined || message.content.includes("unavailable")).toBe(true);
		expect(errors).toHaveLength(0);
	});
});

describe("master SDK host composition", () => {
	it("keeps configured notification adapters on one attested master runtime", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-master-notifications-"));
		const agentDir = path.join(cwd, ".gjc", "agent");
		const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const sessionManager = SessionManager.inMemory(cwd);
		const epoch = "master-notifications-epoch";
		const masterModeContext = createMasterModeContext("repo", sessionManager.getSessionId(), epoch);
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled model");
		let providerDaemonEnsures = 0;
		let shutdown: (() => Promise<void>) | undefined;
		let dispose: (() => Promise<void>) | undefined;
		const startHost = spyOn(SessionSdkSessionRuntime.prototype, "startHost");
		try {
			const created = await createAgentSession({
				cwd,
				agentDir,
				sessionManager,
				authStorage,
				settings: configuredNotificationSettings(agentDir),
				model,
				disableExtensionDiscovery: true,
				ensureNotificationProviderDaemon: async () => {
					providerDaemonEnsures++;
					return "attached";
				},
				extensions: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				masterModeContext,
			});
			shutdown = async () => {
				await created.session.extensionRunner?.emit({ type: "session_shutdown" });
			};
			dispose = async () => await created.session.dispose();
			const sessionId = sessionManager.getSessionId();
			await created.session.extensionRunner?.emit({ type: "session_start" });
			const endpointDir = path.join(cwd, ".gjc", "state", "sdk");
			const endpoint = path.join(endpointDir, `${sessionId}.json`);
			await waitFor(async () => await Bun.file(endpoint).exists(), "master SDK endpoint");
			await waitFor(() => providerDaemonEnsures > 0, "configured notification provider startup");
			await waitForMasterAttestation(agentDir, sessionId, epoch);

			expect(startHost).toHaveBeenCalledTimes(1);
			expect(await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: endpointDir, onlyFiles: true }))).toEqual([
				`${sessionId}.json`,
			]);
			const verifier = createMasterCapabilityVerifier(
				await assertVerifiableMasterAttachment(agentDir, sessionId, epoch),
			);
			expect(await verifier.verifyMasterCapability(sessionId, masterModeContext.getCapability(), epoch)).toEqual({
				allowed: true,
			});
		} finally {
			try {
				await shutdown?.();
			} finally {
				try {
					await dispose?.();
				} finally {
					authStorage.close();
					closeModelCache(path.join(cwd, "models.db"));
					startHost.mockRestore();
					await cleanupFixtureRoot(cleanup);
				}
			}
		}
	});

	it("re-attests a successor identity after a notification session switch", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-master-notification-switch-"));
		const agentDir = path.join(cwd, ".gjc", "agent");
		const cleanup = await createNotificationFixtureRoot(cwd, agentDir);
		const capability = "master-capability-switch";
		const epoch = "master-switch-epoch";
		const initialSessionId = `master-switch-initial-${Snowflake.next()}`;
		const successorSessionId = `master-switch-successor-${Snowflake.next()}`;
		let activeSessionId = initialSessionId;
		const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
		const api = {
			on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
			registerCommand: () => {},
			sendUserMessage: async () => {},
		} as never;
		const ctx = {
			cwd,
			sessionManager: {
				getSessionId: () => activeSessionId,
				getSessionName: () => "Master notification session",
				getArtifactsDir: () => cwd,
				getCwd: () => cwd,
				getSessionFile: () => path.join(cwd, "sessions", `${activeSessionId}.jsonl`),
			},
		} as never;
		const startHost = spyOn(SessionSdkSessionRuntime.prototype, "startHost");
		createNotificationsExtension(api, {
			settings: configuredNotificationSettings(agentDir),
			masterCapability: capability,
			masterAttestationEpoch: epoch,
			ensureProviderDaemon: async () => "attached",
		});
		try {
			const start = handlers.get("session_start");
			if (!start) throw new Error("Expected session_start handler");
			await start({ type: "session_start" }, ctx);
			await waitForMasterAttestation(agentDir, initialSessionId, epoch);
			expect(startHost).toHaveBeenCalledTimes(1);

			activeSessionId = successorSessionId;
			const sessionSwitch = handlers.get("session_switch");
			if (!sessionSwitch) throw new Error("Expected session_switch handler");
			await sessionSwitch(
				{
					type: "session_switch",
					previousSessionFile: path.join(cwd, "sessions", `${initialSessionId}.jsonl`),
				},
				ctx,
			);
			await waitForMasterAttestation(agentDir, successorSessionId, epoch);
			expect(startHost).toHaveBeenCalledTimes(2);
			const verifier = createMasterCapabilityVerifier(
				await assertVerifiableMasterAttachment(agentDir, successorSessionId, epoch),
			);
			expect(await verifier.verifyMasterCapability(successorSessionId, capability, epoch)).toEqual({
				allowed: true,
			});
		} finally {
			try {
				await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
			} finally {
				startHost.mockRestore();
				await cleanupFixtureRoot(cleanup);
			}
		}
	});
});
