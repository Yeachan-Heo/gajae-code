import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startFixtureBrokerWithLeaseForTest } from "../../src/sdk/broker/ensure";
import { SdkClient } from "../../src/sdk/client";
import {
	listManagedSessionCandidates,
	type ManagedSessionScope,
	resolveManagedSessionScope,
} from "../../src/sdk/session-directory";
import { SessionManager } from "../../src/session/session-manager";
import { cleanupFixtureRoot, createFixtureBrokerEnvironment, createFixtureRootCleanup } from "./fixture-broker-cleanup";

type BrokerResult = { ok: boolean; result?: Record<string, unknown>; error?: { code?: string } };
export type LifecycleGlobal = (
	operation: "session.create" | "session.fork" | "session.resume" | "session.close" | "session.delete",
	input: Record<string, unknown>,
	idempotencyKey: string,
) => Promise<BrokerResult>;

export type LifecycleFixture = {
	repo: string;
	agentDir: string;
	stateRoot: string;
	invokeScenario: (global: LifecycleGlobal) => Promise<void>;
	cleanup: () => Promise<void>;
};

export type SharedLifecycleWorkspace = {
	cwd: string;
	stateRoot: string;
	scope: ManagedSessionScope;
	source: { id: string; path: string; bytes: Uint8Array };
};

export type SharedLifecycleFixture = {
	root: string;
	agentDir: string;
	environment: NodeJS.ProcessEnv;
	workspaces: Record<"A" | "B", SharedLifecycleWorkspace>;
	createBarrier: () => () => Promise<void>;
	cleanup: () => Promise<void>;
};

async function managedWorkspace(
	root: string,
	agentDir: string,
	name: "A" | "B",
	sessionId: string,
): Promise<SharedLifecycleWorkspace> {
	const cwd = path.join(root, `workspace-${name.toLowerCase()}`);
	await fs.mkdir(cwd, { recursive: true });
	const resolved = await resolveManagedSessionScope({ cwd, agentDir });
	expect(resolved.kind).toBe("resolved");
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const scopeDir = SessionManager.getDefaultSessionDir(cwd, agentDir);
	expect(scopeDir).toBe(resolved.scope.directoryPath);
	const previousRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	const previousSessionId = process.env.GJC_SESSION_ID;
	try {
		// This is setup only: parallel ingress requests never inherit these variables.
		process.env.GJC_LIFECYCLE_REQUEST_ID = `prepare-${name.toLowerCase()}-${sessionId}`;
		process.env.GJC_SESSION_ID = sessionId;
		const session = SessionManager.create(cwd, scopeDir);
		await session.ensureOnDisk();
		const sourcePath = session.getSessionFile();
		if (!sourcePath) throw new Error("Product session API did not create a saved session path.");
		expect(session.getSessionId()).toBe(sessionId);
		expect(path.dirname(sourcePath)).toBe(resolved.scope.directoryPath);
		await expect(
			fs.access(path.join(resolved.scope.directoryPath, ".gjc-managed-session-scope.v2.json")),
		).resolves.toBeNull();
		const inventory = await listManagedSessionCandidates({ scope: resolved.scope });
		expect(inventory.kind).toBe("complete");
		if (inventory.kind !== "complete") throw new Error(inventory.message);
		const candidates = inventory.owned.filter(
			candidate => candidate.sessionId === sessionId && candidate.path === sourcePath,
		);
		expect(candidates).toHaveLength(1);
		return {
			cwd,
			stateRoot: path.join(cwd, ".gjc", "state"),
			scope: resolved.scope,
			source: { id: sessionId, path: sourcePath, bytes: await fs.readFile(sourcePath) },
		};
	} finally {
		if (previousRequestId === undefined) delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		else process.env.GJC_LIFECYCLE_REQUEST_ID = previousRequestId;
		if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = previousSessionId;
	}
}

/** Owns one external agent directory, broker lease, environment, and cleanup for two sibling workspaces. */
export async function createSharedLifecycleFixture(
	sourceIds: Record<"A" | "B", string> = {
		A: "shared-a-source",
		B: "shared-b-source",
	},
): Promise<SharedLifecycleFixture> {
	const root = await fs.mkdtemp(path.join(tmpdir(), "gjc-sdk-shared-lifecycle-"));
	const agentDir = path.join(root, "agent");
	const environment = createFixtureBrokerEnvironment(root, agentDir);
	const started = await startFixtureBrokerWithLeaseForTest({ agentDir, env: environment });
	const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
	let workspaces: Record<"A" | "B", SharedLifecycleWorkspace>;
	try {
		workspaces = {
			A: await managedWorkspace(root, agentDir, "A", sourceIds.A),
			B: await managedWorkspace(root, agentDir, "B", sourceIds.B),
		};
	} catch (error) {
		await cleanupFixtureRoot(cleanup);
		throw error;
	}
	expect(workspaces.A.scope.directoryPath).not.toBe(workspaces.B.scope.directoryPath);
	return {
		root,
		agentDir,
		environment,
		workspaces,
		createBarrier() {
			let arrivals = 0;
			const release = Promise.withResolvers<void>();
			return async () => {
				arrivals += 1;
				if (arrivals > 2) throw new Error("Shared lifecycle barrier accepts exactly two requests.");
				if (arrivals === 2) release.resolve();
				await release.promise;
			};
		},
		async cleanup() {
			await cleanupFixtureRoot(cleanup);
		},
	};
}

async function eventually<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

async function assertReady(
	stateRoot: string,
	sessionId: string,
): Promise<{ url: string; token: string; pid: number; generation: number }> {
	const endpoint = await eventually(async () => {
		try {
			const value = JSON.parse(await fs.readFile(path.join(stateRoot, "sdk", `${sessionId}.json`), "utf8")) as {
				url?: string;
				token?: string;
				pid?: number;
			};
			return typeof value.url === "string" && typeof value.token === "string" && typeof value.pid === "number"
				? (value as { url: string; token: string; pid: number })
				: undefined;
		} catch {
			return undefined;
		}
	}, `endpoint for ${sessionId}`);
	const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
	try {
		const replay = await client.request({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 });
		const ready = (replay.events as unknown[]).find(event => {
			const frame = event as { type?: string; name?: string; sessionId?: string; generation?: unknown };
			return (
				frame.type === "event" &&
				frame.name === "session_ready" &&
				frame.sessionId === sessionId &&
				typeof frame.generation === "number"
			);
		}) as { generation: number } | undefined;
		expect(ready).toBeDefined();
		return { ...endpoint, generation: ready!.generation };
	} finally {
		await client.close();
	}
}

async function assertClosed(
	agentDir: string,
	stateRoot: string,
	sessionId: string,
	endpoint: { pid: number; generation: number },
): Promise<void> {
	await eventually(async () => {
		const endpointGone = await fs.access(path.join(stateRoot, "sdk", `${sessionId}.json`)).then(
			() => false,
			() => true,
		);
		let exited = false;
		try {
			process.kill(endpoint.pid, 0);
		} catch {
			exited = true;
		}
		const index = await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8").catch(() => "");
		const unregistered = index.split("\n").some(line => {
			try {
				const event = JSON.parse(line) as {
					type?: string;
					sessionId?: string;
					pid?: unknown;
					endpointGeneration?: unknown;
				};
				return (
					event.type === "host_unregistered" &&
					event.sessionId === sessionId &&
					event.pid === endpoint.pid &&
					event.endpointGeneration === endpoint.generation
				);
			} catch {
				return false;
			}
		});
		return endpointGone && exited && unregistered ? true : undefined;
	}, `terminal close of ${sessionId}`);
}

function success(result: BrokerResult): Record<string, unknown> {
	expect(result).toMatchObject({ ok: true });
	if (!result.ok || !result.result) throw new Error(`Lifecycle operation failed: ${JSON.stringify(result)}`);
	return result.result;
}

/** Exercises G03-G07 through a supplied shipped-interface invocation, never a direct adapter. */
export async function createLifecycleFixture(): Promise<LifecycleFixture> {
	const repo = await fs.mkdtemp(path.join(tmpdir(), "gjc-sdk-machine-lifecycle-"));
	const agentDir = path.join(repo, ".gjc", "agent");
	const stateRoot = path.join(repo, ".gjc", "state");
	const environment = createFixtureBrokerEnvironment(repo, agentDir);
	const fixtureSessionDir = SessionManager.getDefaultSessionDir(repo, agentDir);
	const started = await startFixtureBrokerWithLeaseForTest({ agentDir, env: environment });
	const cleanup = createFixtureRootCleanup(repo, agentDir, started.lease);
	return {
		repo,
		agentDir,
		stateRoot,
		async invokeScenario(global) {
			const created = success(
				await global(
					"session.create",
					{ cwd: repo, target: { path: repo }, stateRoot, body: "create" },
					"create-key",
				),
			);
			const createdId = String(created.sessionId);
			expect(
				success(
					await global(
						"session.create",
						{ cwd: repo, target: { path: repo }, stateRoot, body: "create" },
						"create-key",
					),
				),
			).toEqual(created);
			expect(
				await global(
					"session.create",
					{ cwd: repo, target: { path: repo }, stateRoot, body: "changed" },
					"create-key",
				),
			).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
			const createdEndpoint = await assertReady(stateRoot, createdId);

			const createdClosed = success(await global("session.close", { sessionId: createdId }, "close-created-key"));
			await assertClosed(agentDir, stateRoot, createdId, createdEndpoint);
			expect(
				await global("session.close", { sessionId: createdId, body: "changed" }, "close-created-key"),
			).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
			expect(success(await global("session.close", { sessionId: createdId }, "close-created-key"))).toEqual(
				createdClosed,
			);

			const resolved = await resolveManagedSessionScope({ cwd: repo, agentDir });
			expect(resolved.kind).toBe("resolved");
			if (resolved.kind !== "resolved") throw new Error(resolved.message);
			expect(fixtureSessionDir).toBe(resolved.scope.directoryPath);
			const savedSession = SessionManager.create(repo, fixtureSessionDir);
			await savedSession.ensureOnDisk();
			const sourceId = savedSession.getSessionId();
			const sourcePath = savedSession.getSessionFile();
			if (!sourcePath) throw new Error("Product session API did not create a saved session path.");
			expect(path.dirname(sourcePath)).toBe(resolved.scope.directoryPath);
			await expect(
				fs.access(path.join(resolved.scope.directoryPath, ".gjc-managed-session-scope.v2.json")),
			).resolves.toBeNull();
			const inventory = await listManagedSessionCandidates({ scope: resolved.scope });
			expect(inventory.kind).toBe("complete");
			if (inventory.kind !== "complete") throw new Error(inventory.message);
			expect(inventory.scope.directoryPath).toBe(resolved.scope.directoryPath);
			const sourceCandidates = inventory.owned.filter(
				candidate => candidate.sessionId === sourceId && candidate.path === sourcePath,
			);
			expect(sourceCandidates).toHaveLength(1);
			const sourceIdentity = sourceCandidates[0]!.identity;

			const resumed = success(
				await global(
					"session.resume",
					{ cwd: repo, target: { path: repo }, stateRoot, sessionId: sourceId, sessionPath: sourcePath },
					"resume-key",
				),
			);
			expect(resumed.sessionId).toBe(sourceId);
			const resumedEndpoint = await assertReady(stateRoot, sourceId);
			expect(
				success(
					await global(
						"session.resume",
						{ cwd: repo, target: { path: repo }, stateRoot, sessionId: sourceId, sessionPath: sourcePath },
						"resume-key",
					),
				),
			).toEqual(resumed);
			expect(
				await global(
					"session.resume",
					{
						cwd: repo,
						target: { path: repo },
						stateRoot,
						sessionId: sourceId,
						sessionPath: sourcePath,
						body: "changed",
					},
					"resume-key",
				),
			).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
			success(await global("session.close", { sessionId: sourceId }, "close-resumed-key"));
			await assertClosed(agentDir, stateRoot, sourceId, resumedEndpoint);

			const forked = success(
				await global(
					"session.fork",
					{
						cwd: repo,
						target: { path: repo },
						stateRoot,
						sourceSessionId: sourceId,
						sourceSessionPath: sourcePath,
					},
					"fork-key",
				),
			);
			const forkId = String(forked.sessionId);
			const forkEndpoint = await assertReady(stateRoot, forkId);
			expect(
				success(
					await global(
						"session.fork",
						{
							cwd: repo,
							target: { path: repo },
							stateRoot,
							sourceSessionId: sourceId,
							sourceSessionPath: sourcePath,
						},
						"fork-key",
					),
				),
			).toEqual(forked);
			expect(
				await global(
					"session.fork",
					{
						cwd: repo,
						target: { path: repo },
						stateRoot,
						sourceSessionId: sourceId,
						sourceSessionPath: sourcePath,
						body: "changed",
					},
					"fork-key",
				),
			).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
			const forkPath = await eventually(async () => {
				const candidates = await listManagedSessionCandidates({ scope: resolved.scope });
				return candidates.kind === "complete"
					? candidates.owned.find(session => session.sessionId === forkId)?.path
					: undefined;
			}, `saved fork session ${forkId}`);
			expect(path.dirname(forkPath)).toBe(resolved.scope.directoryPath);
			const forkInventory = await listManagedSessionCandidates({ scope: resolved.scope });
			expect(forkInventory.kind).toBe("complete");
			if (forkInventory.kind !== "complete") throw new Error(forkInventory.message);
			const forkCandidates = forkInventory.owned.filter(
				candidate => candidate.sessionId === forkId && candidate.path === forkPath,
			);
			expect(forkCandidates).toHaveLength(1);
			expect(forkCandidates[0]!.identity.sessionId).toBe(forkId);
			expect(sourceIdentity.sessionId).toBe(sourceId);
			success(await global("session.close", { sessionId: forkId }, "close-fork-key"));
			await assertClosed(agentDir, stateRoot, forkId, forkEndpoint);

			const deleted = success(
				await global(
					"session.delete",
					{ sessionId: forkId, stateRoot, cwd: repo, sessionPath: forkPath },
					"delete-key",
				),
			);
			expect(deleted).toMatchObject({ sessionId: forkId });
			expect(
				await fs.access(forkPath).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				success(
					await global(
						"session.delete",
						{ sessionId: forkId, stateRoot, cwd: repo, sessionPath: forkPath },
						"delete-key",
					),
				),
			).toEqual(deleted);
			expect(
				await global(
					"session.delete",
					{ sessionId: forkId, stateRoot, cwd: repo, sessionPath: sourcePath },
					"delete-key",
				),
			).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		},
		async cleanup() {
			await cleanupFixtureRoot(cleanup);
		},
	};
}
