import { afterEach, describe, expect, it } from "bun:test";
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

		// The superseded proof no longer speaks for the identity.
		expect(await index.relocateIfCurrent(registration, await resolveSessionLocator(ws, stateRoot))).toBeUndefined();
		expect(await index.unregisterIfCurrent(relocated)).toBe(true);
		// A released registration is never resurrected by a late move.
		expect(await index.relocateIfCurrent(relocated, await resolveSessionLocator(ws, stateRoot))).toBeUndefined();
		expect(index.indexSeq).toBe(relocated.indexSeq + 1);
		expect(await liveSessionsInScope(agentDir, ws, "pwd")).toEqual([]);
		expect(await liveSessionsInScope(agentDir, repo, "pwd")).toEqual([]);
	});

	it("keeps the identity tuple: a state root change is not a relocation", async () => {
		const { repo, index, registration } = await registered();
		await expect(
			index.relocateIfCurrent(registration, await resolveSessionLocator(repo, path.join(repo, ".gjc", "state"))),
		).rejects.toThrow("A session relocation must keep its registered state root.");
		expect(index.indexSeq).toBe(registration.indexSeq);
	});
});

describe("committed session move relocates the broker registration", () => {
	it("SDK session runtime host: pwd scope follows the move", async () => {
		const layout = await workspaceWithNestedRepo();
		const agentDir = path.join(layout.root, "agent");
		const manager = SessionManager.create(layout.ws, SessionManager.managedDestination(layout.ws, layout.root));
		const sessionId = manager.getSessionId();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
		const api = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const timer = { unref() {} } as NodeJS.Timeout;
		createSdkSessionRuntimeExtension(api, {
			agentDir,
			ensureBrokerImpl: async () => testBrokerDiscovery,
			setIntervalImpl: (() => timer) as unknown as typeof setInterval,
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
		const ctx = hostContext(manager, layout.ws);
		try {
			await handlers.get("session_start")?.({}, ctx);
			await expectRegistryFollowsMove(agentDir, sessionId, manager, layout);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
		}
	}, 30_000);

	it("notifications bus host: pwd scope follows the move", async () => {
		const layout = await workspaceWithNestedRepo();
		const agentDir = path.join(layout.root, "agent");
		const cleanup = await createNotificationFixtureRoot(layout.root, agentDir);
		const manager = SessionManager.create(layout.ws, SessionManager.managedDestination(layout.ws, layout.root));
		const sessionId = manager.getSessionId();
		const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
		const api = {
			on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
			registerCommand: () => {},
			sendUserMessage: async () => {},
		} as never;
		const ctx = hostContext(manager, layout.ws);
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
			await expectRegistryFollowsMove(agentDir, sessionId, manager, layout);
		} finally {
			try {
				await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
			} finally {
				await cleanupFixtureRoot(cleanup);
			}
		}
	}, 30_000);
});
