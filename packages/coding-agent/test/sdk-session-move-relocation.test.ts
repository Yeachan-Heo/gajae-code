import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, Snowflake, setProjectDir } from "@gajae-code/utils";
import type { ExtensionAPI, ExtensionContext, SessionMoveListener } from "../src/extensibility/extensions";
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import {
	canonicalSessionCwd,
	resolveSessionLocator,
	SessionIndex,
	sessionWorktreeRoot,
} from "../src/sdk/broker/session-index";
import { resolveScopeRequest, scopeMatchesLocator } from "../src/sdk/broker/session-scope";
import { createNotificationsExtension } from "../src/sdk/bus";
import { createSdkSessionRuntimeExtension } from "../src/sdk/host/session-runtime";
import { createReadonlySessionManager, SessionManager } from "../src/session/session-manager";
import {
	cleanupFixtureRoot,
	createNotificationFixtureRoot,
	isolatedNotificationSettings,
} from "./helpers/notification-settings";

const processCwdAtStart = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
	// SessionManager.moveTo follows the session with the process cwd.
	if (process.cwd() !== processCwdAtStart || getProjectDir() !== processCwdAtStart) setProjectDir(processCwdAtStart);
	for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

const testBrokerDiscovery: BrokerDiscovery = {
	version: 1,
	protocolVersion: 3,
	packageGeneration: "test",
	ownerId: "test-broker",
	pid: process.pid,
	incarnation: "test-incarnation",
	host: "127.0.0.1",
	port: 1,
	url: "ws://127.0.0.1:1",
	token: "test-token",
	startedAt: 0,
	heartbeatAt: 0,
};

/** `<root>/ws` (not a repository) containing `<root>/ws/repo` (a git repository). */
async function workspaceWithNestedRepo(): Promise<{ root: string; ws: string; repo: string }> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-relocation-${Snowflake.next()}-`)));
	tempDirs.push(root);
	const ws = path.join(root, "ws");
	const repo = path.join(ws, "repo");
	fs.mkdirSync(repo, { recursive: true });
	// Explicit cwd: an earlier test file in the same process may leave process.cwd() deleted.
	const init = Bun.spawnSync(["git", "init", "-q", repo], { cwd: root, stdout: "ignore", stderr: "pipe" });
	if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
	return { root, ws, repo };
}

/** Live session ids the real SessionIndex projects into `requested` scope at `cwd`. */
async function liveSessionsInScope(agentDir: string, cwd: string, requested: "pwd" | "repo"): Promise<string[]> {
	const anchor = await canonicalSessionCwd(cwd);
	const scope = await resolveScopeRequest({
		version: 1,
		requested,
		requestAnchor: { cwd: anchor, worktreeRoot: await sessionWorktreeRoot(anchor) },
	});
	const index = await new SessionIndex(agentDir).open();
	await index.refresh();
	return index
		.listSessions()
		.sessions.filter(session => session.live && !session.terminal && scopeMatchesLocator(scope, session.locator))
		.map(session => session.sessionId);
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}

function hostContext(manager: SessionManager, cwd: string): ExtensionContext {
	return {
		cwd,
		workflowGate: undefined,
		sdkBindings: () => [],
		sessionManager: createReadonlySessionManager(manager),
		onSessionMove: (listener: SessionMoveListener) => manager.registerAfterMoveListener(listener),
		getTranscript: () => [],
		getGoalState: () => undefined,
	} as unknown as ExtensionContext;
}

async function expectRegistryFollowsMove(
	agentDir: string,
	sessionId: string,
	manager: SessionManager,
	layout: { ws: string; repo: string },
): Promise<void> {
	await waitFor(
		async () => (await liveSessionsInScope(agentDir, layout.ws, "pwd")).includes(sessionId),
		"registration at the launch cwd",
	);
	expect(await liveSessionsInScope(agentDir, layout.repo, "pwd")).not.toContain(sessionId);

	await manager.moveTo(layout.repo);
	expect(manager.getCwd()).toBe(layout.repo);

	// The relocation is appended before the committed move returns: no heartbeat wait.
	expect(await liveSessionsInScope(agentDir, layout.repo, "pwd")).toContain(sessionId);
	expect(await liveSessionsInScope(agentDir, layout.repo, "repo")).toContain(sessionId);
	expect(await liveSessionsInScope(agentDir, layout.ws, "pwd")).not.toContain(sessionId);

	// Same composite identity: one public row, nothing superseded or fenced.
	const index = await new SessionIndex(agentDir).open();
	const rows = index.listSessionIdentities().filter(row => row.sessionId === sessionId && row.endpointGeneration > 0);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		live: true,
		ambiguous: false,
		terminal: false,
		locator: await resolveSessionLocator(layout.repo, rows[0]!.locator.stateRoot),
	});
}

describe("SessionIndex.relocateIfCurrent", () => {
	async function registered() {
		const layout = await workspaceWithNestedRepo();
		const agentDir = path.join(layout.root, "agent");
		const stateRoot = path.join(layout.ws, ".gjc", "state");
		const index = await new SessionIndex(agentDir).open();
		const registration = await index.append({
			type: "host_registered",
			sessionId: `relocate-${Snowflake.next()}`,
			locator: await resolveSessionLocator(layout.ws, stateRoot),
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: 1,
			endpointFileId: "1:1",
		});
		return { ...layout, agentDir, stateRoot, index, registration };
	}

	it("republishes the same identity and refuses a registration that is no longer current", async () => {
		const { agentDir, repo, ws, stateRoot, index, registration } = await registered();
		const moved = await resolveSessionLocator(repo, stateRoot);
		const relocated = await index.relocateIfCurrent(registration, moved);
		if (!relocated) throw new Error("Expected a relocated registration");
		expect(relocated).toMatchObject({
			type: "host_registered",
			sessionId: registration.sessionId,
			endpointGeneration: registration.endpointGeneration,
			pid: registration.pid,
			hostIncarnation: registration.hostIncarnation,
			endpointFileId: registration.endpointFileId,
			locator: moved,
		});
		expect(relocated.indexSeq).toBe(registration.indexSeq + 1);
		expect(await liveSessionsInScope(agentDir, repo, "pwd")).toEqual([registration.sessionId]);
		expect(await liveSessionsInScope(agentDir, ws, "pwd")).toEqual([]);

		expect(await index.unregisterIfCurrent(relocated)).toBe(true);
		// A released registration is never resurrected by a late move.
		expect(await index.relocateIfCurrent(relocated, await resolveSessionLocator(ws, stateRoot))).toBeUndefined();
		expect(index.indexSeq).toBe(relocated.indexSeq + 1);
		expect(await liveSessionsInScope(agentDir, ws, "pwd")).toEqual([]);
		expect(await liveSessionsInScope(agentDir, repo, "pwd")).toEqual([]);
	});

	it("adopts a durable relocation whose proof the caller never received", async () => {
		const { agentDir, repo, ws, stateRoot, index, registration } = await registered();
		const durable = await index.relocateIfCurrent(registration, await resolveSessionLocator(repo, stateRoot));
		if (!durable) throw new Error("Expected a relocated registration");

		// The caller retries with the pre-move proof: the durable relocation is adopted, not duplicated.
		expect(await index.relocateIfCurrent(registration, await resolveSessionLocator(repo, stateRoot))).toEqual(
			durable,
		);
		expect(index.indexSeq).toBe(durable.indexSeq);

		// A later move presenting the same lost proof still converges on the new cwd.
		const back = await index.relocateIfCurrent(registration, await resolveSessionLocator(ws, stateRoot));
		if (!back) throw new Error("Expected the lost proof to be adopted and relocated");
		expect(back.indexSeq).toBe(durable.indexSeq + 1);
		expect(await liveSessionsInScope(agentDir, ws, "pwd")).toEqual([registration.sessionId]);
		expect(await liveSessionsInScope(agentDir, repo, "pwd")).toEqual([]);

		// A different publication of the same identity is never adopted.
		const foreign = { ...registration, endpointFileId: "2:2" };
		expect(await index.relocateIfCurrent(foreign, await resolveSessionLocator(repo, stateRoot))).toBeUndefined();
		expect(index.indexSeq).toBe(back.indexSeq);
	});

	it("repairs a corrupt suffix under the lock instead of failing the relocation", async () => {
		const { agentDir, repo, ws, stateRoot, registration } = await registered();
		await fs.promises.appendFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), '{"partial":');
		const corrupt = await new SessionIndex(agentDir).open();
		const relocated = await corrupt.relocateIfCurrent(registration, await resolveSessionLocator(repo, stateRoot));
		if (!relocated) throw new Error("Expected a relocated registration after repair");
		expect(relocated.indexSeq).toBe(registration.indexSeq + 1);
		const replay = await new SessionIndex(agentDir).open();
		expect(replay.listSessions().warnings).toEqual([]);
		expect(await liveSessionsInScope(agentDir, repo, "pwd")).toEqual([registration.sessionId]);
		expect(await liveSessionsInScope(agentDir, ws, "pwd")).toEqual([]);
	});

	it("keeps the identity tuple: a state root change is not a relocation", async () => {
		const { repo, index, registration } = await registered();
		await expect(
			index.relocateIfCurrent(registration, await resolveSessionLocator(repo, path.join(repo, ".gjc", "state"))),
		).rejects.toThrow("A session relocation must keep its registered state root.");
		expect(index.indexSeq).toBe(registration.indexSeq);
	});
});

interface StartedHost {
	ctx: ExtensionContext;
	shutdown(): Promise<void>;
	/** Fires the host's periodic broker-recovery tick; absent for hosts without one. */
	recoveryTick?: () => void;
}

async function startSdkRuntimeHost(agentDir: string, manager: SessionManager, launchCwd: string): Promise<StartedHost> {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const timer = { unref() {} } as NodeJS.Timeout;
	let recoveryTick: (() => void) | undefined;
	createSdkSessionRuntimeExtension(api, {
		agentDir,
		ensureBrokerImpl: async () => testBrokerDiscovery,
		setIntervalImpl: ((callback: () => void) => {
			recoveryTick = callback;
			return timer;
		}) as unknown as typeof setInterval,
		clearIntervalImpl: (() => {}) as typeof clearInterval,
		createTransport: async ({ sessionId: id, stateRoot, token }) => ({
			sessionId: id,
			stateRoot,
			token,
			onFrame: () => () => {},
			sendFrame: () => {},
			broadcastFrame: () => {},
			start: async () => {
				const url = "ws://127.0.0.1:1";
				await Bun.write(
					path.join(stateRoot, "sdk", `${id}.json`),
					JSON.stringify({ sessionId: id, token, pid: process.pid, url }),
				);
				return { url };
			},
			stop: async () => {},
		}),
	});
	const ctx = hostContext(manager, launchCwd);
	await handlers.get("session_start")?.({}, ctx);
	return {
		ctx,
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
		recoveryTick: () => recoveryTick?.(),
	};
}

async function startNotificationsBusHost(
	layout: { root: string },
	agentDir: string,
	manager: SessionManager,
	launchCwd: string,
): Promise<StartedHost> {
	const cleanup = await createNotificationFixtureRoot(layout.root, agentDir);
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: async () => {},
	} as never;
	const ctx = hostContext(manager, launchCwd);
	createNotificationsExtension(api, {
		settings: isolatedNotificationSettings(agentDir, {
			"notifications.enabled": true,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "discord-app",
			"notifications.discord.guildId": "discord-guild",
			"notifications.discord.parentChannelId": "discord-parent",
		}),
		ensureProviderDaemon: async () => "attached",
	});
	try {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
	} catch (error) {
		await cleanupFixtureRoot(cleanup);
		throw error;
	}
	return {
		ctx,
		shutdown: async () => {
			try {
				await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
			} finally {
				await cleanupFixtureRoot(cleanup);
			}
		},
	};
}

const HOSTS = [
	{
		name: "SDK session runtime host",
		start: (_layout: { root: string }, agentDir: string, manager: SessionManager, launchCwd: string) =>
			startSdkRuntimeHost(agentDir, manager, launchCwd),
	},
	{ name: "notifications bus host", start: startNotificationsBusHost },
] as const;

async function hostFixture() {
	const layout = await workspaceWithNestedRepo();
	const agentDir = path.join(layout.root, "agent");
	const manager = SessionManager.create(layout.ws, SessionManager.managedDestination(layout.ws, layout.root));
	return { layout, agentDir, manager, sessionId: manager.getSessionId() };
}

/** Ids of every live, non-terminal session row in the index, regardless of scope. */
async function liveSessionIds(agentDir: string): Promise<string[]> {
	const index = await new SessionIndex(agentDir).open();
	await index.refresh();
	return index
		.listSessions()
		.sessions.filter(session => session.live && !session.terminal)
		.map(session => session.sessionId);
}

describe("committed session move relocates the broker registration", () => {
	for (const host of HOSTS) {
		it(`${host.name}: pwd scope follows the move`, async () => {
			const { layout, agentDir, manager, sessionId } = await hostFixture();
			const started = await host.start(layout, agentDir, manager, layout.ws);
			try {
				await expectRegistryFollowsMove(agentDir, sessionId, manager, layout);
			} finally {
				await started.shutdown();
			}
		}, 30_000);

		it(`${host.name}: a move committed before startup registers at the committed cwd`, async () => {
			const { layout, agentDir, manager, sessionId } = await hostFixture();
			// The move lands before the host subscribes; its extension context still
			// carries the launch cwd, as a runner built before the move does.
			await manager.moveTo(layout.repo);
			const started = await host.start(layout, agentDir, manager, layout.ws);
			try {
				await waitFor(
					async () => (await liveSessionsInScope(agentDir, layout.repo, "pwd")).includes(sessionId),
					"registration at the committed cwd",
				);
				expect(await liveSessionsInScope(agentDir, layout.ws, "pwd")).not.toContain(sessionId);
				// The endpoint state root stays the launch workspace's.
				const index = await new SessionIndex(agentDir).open();
				const row = index.listSessionIdentities().find(identity => identity.sessionId === sessionId);
				expect(row?.locator).toEqual(
					await resolveSessionLocator(layout.repo, path.join(layout.ws, ".gjc", "state")),
				);
			} finally {
				await started.shutdown();
			}
		}, 30_000);

		it(`${host.name}: a relocation that failed after its append is adopted, so later moves and release converge`, async () => {
			const { layout, agentDir, manager, sessionId } = await hostFixture();
			const started = await host.start(layout, agentDir, manager, layout.ws);
			const original = SessionIndex.prototype.relocateIfCurrent;
			let failures = 1;
			const relocate = spyOn(SessionIndex.prototype, "relocateIfCurrent").mockImplementation(async function (
				this: SessionIndex,
				...args: Parameters<typeof original>
			) {
				const result = await original.apply(this, args);
				if (failures-- > 0) throw new Error("post-append maintenance failed");
				return result;
			});
			try {
				await waitFor(
					async () => (await liveSessionsInScope(agentDir, layout.ws, "pwd")).includes(sessionId),
					"registration at the launch cwd",
				);
				await manager.moveTo(layout.repo);
				// The relocation is durable even though the host never received its proof.
				expect(await liveSessionsInScope(agentDir, layout.repo, "pwd")).toContain(sessionId);

				await manager.moveTo(layout.ws);
				expect(await liveSessionsInScope(agentDir, layout.ws, "pwd")).toContain(sessionId);
				expect(await liveSessionsInScope(agentDir, layout.repo, "pwd")).not.toContain(sessionId);
			} finally {
				relocate.mockRestore();
				await started.shutdown();
			}
			// Release presented the proof the index holds, so the live row is gone.
			expect(await liveSessionIds(agentDir)).not.toContain(sessionId);
		}, 30_000);
	}

	it("notifications bus host: a move committed while broker setup is in flight relocates the registration", async () => {
		const { layout, agentDir, manager, sessionId } = await hostFixture();
		// The transport is already published when the broker index opens, so an SDK
		// `session.cwd.move` can commit in exactly this window.
		const originalOpen = SessionIndex.prototype.open;
		let moved = false;
		const open = spyOn(SessionIndex.prototype, "open").mockImplementation(async function (
			this: SessionIndex,
			...args: Parameters<typeof originalOpen>
		) {
			if (!moved) {
				moved = true;
				await manager.moveTo(layout.repo);
			}
			return await originalOpen.apply(this, args);
		});
		let started: StartedHost | undefined;
		try {
			started = await startNotificationsBusHost(layout, agentDir, manager, layout.ws);
			open.mockRestore();
			expect(moved).toBe(true);
			await waitFor(
				async () => (await liveSessionsInScope(agentDir, layout.repo, "pwd")).includes(sessionId),
				"registration at the committed cwd",
			);
			expect(await liveSessionsInScope(agentDir, layout.ws, "pwd")).not.toContain(sessionId);
		} finally {
			open.mockRestore();
			await started?.shutdown();
		}
	}, 30_000);

	it("notifications bus host: a move committed while the registration append is in flight is reconciled after it lands", async () => {
		const { layout, agentDir, manager, sessionId } = await hostFixture();
		const originalAppend = SessionIndex.prototype.append;
		let moved = false;
		const append = spyOn(SessionIndex.prototype, "append").mockImplementation(async function (
			this: SessionIndex,
			...args: Parameters<typeof originalAppend>
		) {
			if (!moved && args[0].type === "host_registered") {
				moved = true;
				await manager.moveTo(layout.repo);
			}
			return await originalAppend.apply(this, args);
		});
		let started: StartedHost | undefined;
		try {
			started = await startNotificationsBusHost(layout, agentDir, manager, layout.ws);
			append.mockRestore();
			expect(moved).toBe(true);
			expect(await liveSessionsInScope(agentDir, layout.repo, "pwd")).toContain(sessionId);
			expect(await liveSessionsInScope(agentDir, layout.ws, "pwd")).not.toContain(sessionId);
		} finally {
			append.mockRestore();
			await started?.shutdown();
		}
		expect(await liveSessionIds(agentDir)).not.toContain(sessionId);
	}, 30_000);

	it("SDK session runtime host: a relocation that failed before its append is retried by the recovery tick", async () => {
		const { layout, agentDir, manager, sessionId } = await hostFixture();
		const started = await startSdkRuntimeHost(agentDir, manager, layout.ws);
		let failures = 1;
		const original = SessionIndex.prototype.relocateIfCurrent;
		const relocate = spyOn(SessionIndex.prototype, "relocateIfCurrent").mockImplementation(async function (
			this: SessionIndex,
			...args: Parameters<typeof original>
		) {
			if (failures-- > 0) throw new Error("session index lock unavailable");
			return await original.apply(this, args);
		});
		try {
			await waitFor(
				async () => (await liveSessionsInScope(agentDir, layout.ws, "pwd")).includes(sessionId),
				"registration at the launch cwd",
			);
			await manager.moveTo(layout.repo);
			expect(await liveSessionsInScope(agentDir, layout.repo, "pwd")).not.toContain(sessionId);

			started.recoveryTick?.();
			await waitFor(
				async () => (await liveSessionsInScope(agentDir, layout.repo, "pwd")).includes(sessionId),
				"retried relocation at the committed cwd",
			);
			expect(await liveSessionsInScope(agentDir, layout.ws, "pwd")).not.toContain(sessionId);
		} finally {
			relocate.mockRestore();
			await started.shutdown();
		}
		expect(await liveSessionIds(agentDir)).not.toContain(sessionId);
	}, 30_000);
});
