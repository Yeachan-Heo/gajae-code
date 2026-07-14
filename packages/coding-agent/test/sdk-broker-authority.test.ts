import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceCapability } from "../src/sdk/broker/authority";
import { Broker, type BrokerResponse } from "../src/sdk/broker/broker";
import { endpointIncarnation, SessionIndex } from "../src/sdk/broker/session-index";
import { SessionManager } from "../src/session/session-manager";

const directories: string[] = [];
const temp = async () => {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-authority-"));
	directories.push(dir);
	return dir;
};

afterEach(async () => {
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
/** Bigint {dev,ino} identity of a workspace directory, matching the broker contract. */
const workspaceIdentity = async (dir: string) => {
	const stat = await fs.stat(dir, { bigint: true });
	return { dev: stat.dev.toString(), ino: stat.ino.toString() };
};
/** Interns a workspace grant for cwd via session.list and returns its id + identity. */
const listWorkspaceGrant = async (
	broker: Broker,
	cwd: string,
): Promise<{ grantId: string; identity: { dev: string; ino: string } }> => {
	const response = await broker.handleRequest("session.list", { brokerOwnerId: broker.ownerId, cwd });
	if (!response.ok) throw new Error("expected session.list to succeed");
	const result = response.result as {
		workspaceGrantId?: string;
		workspaceIdentity?: { dev: string; ino: string };
	};
	if (!result.workspaceGrantId || !result.workspaceIdentity)
		throw new Error("expected broker to issue a workspace grant");
	return { grantId: result.workspaceGrantId, identity: result.workspaceIdentity };
};

/** Reference formula: sorted-key JSON.stringify over the authority tuple. */
const incarnation = (sessionId: string, generation: number, mtimeMs: number, pid: number) =>
	createHash("sha256")
		.update(
			JSON.stringify({
				endpointGeneration: generation,
				endpointMtimeMs: mtimeMs,
				pid,
				sessionId,
			}),
		)
		.digest("hex");

const registered = (overrides: {
	sessionId: string;
	repo?: string;
	stateRoot?: string;
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
}) => ({
	type: "host_registered" as const,
	sessionId: overrides.sessionId,
	locator: {
		repo: overrides.repo ?? "repo",
		stateRoot: overrides.stateRoot ?? "root",
	},
	endpointGeneration: overrides.endpointGeneration,
	pid: overrides.pid,
	...(overrides.endpointMtimeMs === undefined ? {} : { endpointMtimeMs: overrides.endpointMtimeMs }),
});

test("production index preserves cross-workspace duplicate session ids as distinct evidence", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(
		registered({
			sessionId: "shared",
			repo: "/ws-a",
			endpointGeneration: 1,
			pid: 111_111,
			endpointMtimeMs: 1000,
		}),
	);
	await index.append(
		registered({
			sessionId: "shared",
			repo: "/ws-b",
			endpointGeneration: 1,
			pid: 222_222,
			endpointMtimeMs: 2000,
		}),
	);
	const shared = index.listProductionSessions().sessions.filter(session => session.sessionId === "shared");
	expect(shared).toHaveLength(2);
	expect(new Set(shared.map(session => session.pid))).toEqual(new Set([111_111, 222_222]));
	expect(new Set(shared.map(session => session.locator.repo))).toEqual(new Set(["/ws-a", "/ws-b"]));
});

test("production index preserves same-id successor generations as distinct evidence", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(
		registered({
			sessionId: "successor",
			endpointGeneration: 1,
			pid: 111_111,
			endpointMtimeMs: 1000,
		}),
	);
	await index.append(
		registered({
			sessionId: "successor",
			endpointGeneration: 2,
			pid: 111_111,
			endpointMtimeMs: 2000,
		}),
	);
	const sessions = index.listProductionSessions().sessions.filter(session => session.sessionId === "successor");
	expect(sessions).toHaveLength(2);
	expect(new Set(sessions.map(session => session.endpointGeneration))).toEqual(new Set([1, 2]));
	expect(new Set(sessions.map(session => session.endpointIncarnation))).toEqual(
		new Set([incarnation("successor", 1, 1000, 111_111), incarnation("successor", 2, 2000, 111_111)]),
	);
});

test("internal listSessions still folds to the latest record per session id (backward compatible)", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(
		registered({
			sessionId: "successor",
			endpointGeneration: 1,
			pid: 111_111,
			endpointMtimeMs: 1000,
		}),
	);
	await index.append(
		registered({
			sessionId: "successor",
			endpointGeneration: 2,
			pid: 111_111,
			endpointMtimeMs: 2000,
		}),
	);
	const sessions = index.listSessions().sessions.filter(session => session.sessionId === "successor");
	expect(sessions).toHaveLength(1);
	expect(sessions[0]?.endpointGeneration).toBe(2);
});

test("production index exposes a stable endpointIncarnation matching the authority formula", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(
		registered({
			sessionId: "ep",
			endpointGeneration: 5,
			pid: 333_333,
			endpointMtimeMs: 5000,
		}),
	);
	const [session] = index.listSessions().sessions;
	expect(session.endpointIncarnation).toBe(incarnation("ep", 5, 5000, 333_333));
	expect(session.endpointIncarnation).toBe(endpointIncarnation(session, "ep"));
	expect(session.endpointIncarnation).toMatch(/^[a-f0-9]{64}$/);
});

test("production index omits endpointIncarnation when endpoint authority is incomplete", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(
		registered({
			sessionId: "incomplete",
			endpointGeneration: 5,
			pid: 333_333,
		}),
	);
	expect(index.listSessions().sessions[0]?.endpointIncarnation).toBeUndefined();
});

test("scoped session.list issues a realpath canonicalCwd resolving lexical aliases", async () => {
	const dir = await temp();
	const workspace = path.join(dir, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: dir });
	await broker.index.open();
	try {
		const aliased = await broker.handleRequest("session.list", {
			brokerOwnerId: broker.ownerId,
			cwd: path.join(workspace, "."),
		});
		expect(aliased.ok).toBe(true);
		if (!aliased.ok) throw new Error("expected ok");
		const aliasedResult = aliased.result as { canonicalCwd?: string };
		const real = await fs.realpath(workspace);
		expect(aliasedResult.canonicalCwd).toBe(real);
		expect((aliased.result as { workspaceIdentity?: { dev: string; ino: string } }).workspaceIdentity).toEqual(
			await workspaceIdentity(workspace),
		);
		const direct = await broker.handleRequest("session.list", {
			brokerOwnerId: broker.ownerId,
			cwd: workspace,
		});
		expect(direct.ok).toBe(true);
		if (!direct.ok) throw new Error("expected ok");
		expect((direct.result as { canonicalCwd?: string }).canonicalCwd).toBe(real);
	} finally {
		await broker.stop();
	}
});

test("scoped session.list omits canonicalCwd when cwd is absent (wire compatibility)", async () => {
	const dir = await temp();
	const broker = new Broker({ agentDir: dir });
	await broker.index.open();
	try {
		const response = await broker.handleRequest("session.list", { brokerOwnerId: broker.ownerId });
		expect(response.ok).toBe(true);
		if (!response.ok) throw new Error("expected ok");
		expect((response.result as { canonicalCwd?: string }).canonicalCwd).toBeUndefined();
		expect((response.result as { workspaceIdentity?: unknown }).workspaceIdentity).toBeUndefined();
	} finally {
		await broker.stop();
	}
});

test("scoped session.list exposes immutable transcript identity for a saved session", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(workspace, { recursive: true });
	const saved = SessionManager.create(workspace, SessionManager.getDefaultSessionDir(workspace, agentDir));
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionPath = saved.getSessionFile();
	if (!sessionPath) throw new Error("expected saved session file");
	const broker = new Broker({ agentDir });
	await broker.index.open();
	try {
		const response = await broker.handleRequest("session.list", {
			brokerOwnerId: broker.ownerId,
			cwd: workspace,
			resolveSessionId: sessionId,
		});
		expect(response.ok).toBe(true);
		if (!response.ok) throw new Error("expected ok");
		const result = response.result as {
			canonicalCwd?: string;
			workspaceIdentity?: { dev: string; ino: string };
			savedSession?: {
				id: string;
				path: string;
				sessionIdentity?: {
					dev: string;
					ino: string;
					size: number;
					mtimeMs: number;
					mtimeNs: string;
					sha256: string;
				};
			};
		};
		expect(result.canonicalCwd).toBe(await fs.realpath(workspace));
		expect(result.workspaceIdentity).toEqual(await workspaceIdentity(workspace));
		expect(result.savedSession?.id).toBe(sessionId);
		expect(result.savedSession?.path).toBe(sessionPath);
		const identity = result.savedSession?.sessionIdentity;
		expect(identity).toBeDefined();
		const stat = await fs.stat(sessionPath, { bigint: true });
		expect(identity).toEqual({
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			size: Number(stat.size),
			mtimeMs: Number(stat.mtimeMs),
			mtimeNs: stat.mtimeNs.toString(),
			sha256: createHash("sha256")
				.update(await fs.readFile(sessionPath))
				.digest("hex"),
		});
	} finally {
		await broker.stop();
	}
});

test("broker session.list exposes live duplicate observations without destabilizing folded sessions", async () => {
	const root = await temp();
	const workspaceA = path.join(root, "workspace-a");
	const workspaceB = path.join(root, "workspace-b");
	await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB)]);
	const broker = new Broker({ agentDir: root });
	await broker.index.open();
	await broker.index.append(
		registered({
			sessionId: "shared",
			repo: workspaceA,
			stateRoot: path.join(workspaceA, ".gjc", "state"),
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: 1000,
		}),
	);
	await broker.index.append(
		registered({
			sessionId: "shared",
			repo: workspaceB,
			stateRoot: path.join(workspaceB, ".gjc", "state"),
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: 2000,
		}),
	);
	const response = await broker.handleRequest("session.list", {
		brokerOwnerId: broker.ownerId,
		cwd: workspaceA,
	});
	expect(response.ok).toBe(true);
	if (!response.ok) throw new Error("expected ok");
	const result = response.result as {
		sessions: Array<{ sessionId: string; canonicalCwd: string }>;
		observations: Array<{ sessionId: string; canonicalCwd: string }>;
	};
	expect(result.sessions.filter(session => session.sessionId === "shared")).toHaveLength(1);
	expect(result.observations.filter(session => session.sessionId === "shared")).toHaveLength(2);
	expect(new Set(result.observations.map(session => session.canonicalCwd))).toEqual(
		new Set([await fs.realpath(workspaceA), await fs.realpath(workspaceB)]),
	);
});

test("foreign workspace observations never inherit requested-workspace saved authority", async () => {
	const root = await temp();
	const agentDir = path.join(root, "agent");
	const workspaceA = path.join(root, "workspace-a");
	const workspaceB = path.join(root, "workspace-b");
	await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB)]);
	const saved = SessionManager.create(workspaceA, SessionManager.getDefaultSessionDir(workspaceA, agentDir));
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionPath = saved.getSessionFile();
	if (!sessionPath) throw new Error("expected saved session path");
	await saved.close();

	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		await broker.index.append(
			registered({
				sessionId,
				repo: workspaceA,
				stateRoot: path.join(workspaceA, ".gjc", "state"),
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: 1000,
			}),
		);
		const foreignResponse = await broker.handleRequest("session.list", {
			brokerOwnerId: broker.ownerId,
			cwd: workspaceB,
		});
		if (!foreignResponse.ok) throw new Error("expected foreign observation list");
		const foreignResult = foreignResponse.result as {
			observations: Array<{
				sessionId: string;
				canonicalCwd: string;
				path?: string;
				sessionIdentity?: unknown;
			}>;
		};
		const foreign = foreignResult.observations.find(session => session.sessionId === sessionId);
		expect(foreign).toMatchObject({ sessionId, canonicalCwd: await fs.realpath(workspaceA) });
		expect(foreign?.path).toBeUndefined();
		expect(foreign?.sessionIdentity).toBeUndefined();

		const foreignResolve = await broker.handleRequest("session.list", {
			brokerOwnerId: broker.ownerId,
			cwd: workspaceB,
			resolveSessionId: sessionId,
		});
		if (!foreignResolve.ok) throw new Error("expected foreign resolve list");
		expect((foreignResolve.result as { savedSession?: unknown }).savedSession).toBeUndefined();

		const ownedResolve = await broker.handleRequest("session.list", {
			brokerOwnerId: broker.ownerId,
			cwd: workspaceA,
			resolveSessionId: sessionId,
		});
		if (!ownedResolve.ok) throw new Error("expected owned resolve list");
		expect((ownedResolve.result as { savedSession?: { path?: string } }).savedSession?.path).toBe(sessionPath);
	} finally {
		await broker.stop();
	}
});

test("close idempotency identities are scoped to endpoint incarnation", async () => {
	const root = await temp();
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	const firstIncarnation = "a".repeat(64);
	const secondIncarnation = "b".repeat(64);
	await broker.handleRequest(
		"session.close",
		{
			brokerOwnerId: broker.ownerId,
			sessionId: "successor",
			endpointGeneration: 1,
			endpointIncarnation: firstIncarnation,
		},
		"same-key",
	);
	await broker.handleRequest(
		"session.close",
		{
			sessionId: "successor",
			brokerOwnerId: broker.ownerId,
			endpointGeneration: 2,
			endpointIncarnation: secondIncarnation,
		},
		"same-key",
	);
	const entries = (await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { identity: string; state: string });
	const accepted = entries.filter(entry => entry.state === "accepted");
	expect(accepted).toHaveLength(2);
	expect(new Set(accepted.map(entry => entry.identity)).size).toBe(2);
});

test("saved lifecycle idempotency identities are scoped to full transcript identity", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const transcriptPath = path.join(workspace, "saved.jsonl");
	await fs.mkdir(workspace, { recursive: true });
	const wsIdentity = await workspaceIdentity(workspace);
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	const grant = await listWorkspaceGrant(broker, workspace);
	const first = { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5" };
	const second = { ...first, size: 6, mtimeMs: 7, mtimeNs: "8" };
	const requests: Array<[string, Record<string, unknown>]> = [
		[
			"session.resume",
			{
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: first,
				cwd: workspace,
				target: { path: workspace },
			},
		],
		[
			"session.fork",
			{
				sourceSessionId: "saved",
				sourceSessionPath: transcriptPath,
				sourceSessionIdentity: first,
				cwd: workspace,
				target: { path: workspace },
			},
		],
		[
			"session.delete",
			{
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: first,
				cwd: workspace,
				target: { path: workspace },
			},
		],
	];
	for (const [operation, input] of requests) {
		const owned = {
			...input,
			brokerOwnerId: broker.ownerId,
			workspaceIdentity: wsIdentity,
			workspaceGrantId: grant.grantId,
		};
		await broker.handleRequest(operation, owned, "same-key");
		const identityField = operation === "session.fork" ? "sourceSessionIdentity" : "sessionIdentity";
		await broker.handleRequest(operation, { ...owned, [identityField]: second }, "same-key");
	}
	const entries = (await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { identity: string; state: string });
	const accepted = entries.filter(entry => entry.state === "accepted");
	expect(accepted).toHaveLength(6);
	expect(new Set(accepted.map(entry => entry.identity)).size).toBe(6);
});

test("broker boot authority is revalidated before endpoint or lifecycle effects", async () => {
	const root = await temp();
	const broker = new Broker({ agentDir: root, packageGeneration: "test" });
	const discovery = await broker.start();
	try {
		await expect(
			broker.handleRequest("session.get_endpoint", {
				sessionId: "missing",
				brokerOwnerId: "stale-owner",
			}),
		).resolves.toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "broker boot authority is stale" },
		});
		await expect(
			broker.handleRequest(
				"session.close",
				{ sessionId: "missing", brokerOwnerId: "stale-owner" },
				"stale-owner-close",
			),
		).resolves.toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "broker boot authority is stale" },
		});
		await expect(
			broker.handleRequest("session.get_endpoint", {
				sessionId: "missing",
				brokerOwnerId: discovery.ownerId,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "resource_gone" } });
		const ledgerPath = path.join(root, "sdk", "lifecycle-ledger.jsonl");
		const ledger = await fs.readFile(ledgerPath, "utf8").catch(() => "");
		expect(ledger.trim()).toBe("");
	} finally {
		await broker.stop();
	}
});

test("delete rejects a recreated transcript before any deletion effect", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(workspace, { recursive: true });
	const saved = SessionManager.create(workspace, SessionManager.getDefaultSessionDir(workspace, agentDir));
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionPath = saved.getSessionFile();
	if (!sessionPath) throw new Error("expected saved session file");
	const stat = await fs.stat(sessionPath, { bigint: true });
	const staleIdentity = {
		dev: stat.dev.toString(),
		ino: stat.ino.toString(),
		size: Number(stat.size),
		mtimeMs: Number(stat.mtimeMs),
		mtimeNs: stat.mtimeNs.toString(),
	};
	await fs.appendFile(sessionPath, "\n");
	const broker = new Broker({ agentDir });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	const grant = await listWorkspaceGrant(broker, workspace);
	const response = await broker.handleRequest(
		"session.delete",
		{
			brokerOwnerId: broker.ownerId,
			sessionId,
			sessionPath,
			sessionIdentity: staleIdentity,
			cwd: workspace,
			workspaceGrantId: grant.grantId,
			workspaceIdentity: grant.identity,
			target: { path: workspace },
		},
		"delete-stale-transcript",
	);
	expect(response).toMatchObject({
		ok: false,
		error: { code: "endpoint_stale" },
	});
	expect(await fs.stat(sessionPath)).toBeDefined();
});

test("session.list exposes immutable broker identity from the running discovery", async () => {
	const dir = await temp();
	const broker = new Broker({
		agentDir: dir,
		packageGeneration: "test-generation",
	});
	await broker.index.open();
	broker.discovery = {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test-generation",
		ownerId: "owner-abc",
		pid: process.pid,
		incarnation: "test-incarnation",
		host: "127.0.0.1",
		port: 9,
		url: "ws://127.0.0.1:9",
		token: "discovery-token",
		startedAt: 42_000,
		heartbeatAt: 42_000,
	};
	try {
		const response = await broker.handleRequest("session.list", { brokerOwnerId: "owner-abc" });
		expect(response.ok).toBe(true);
		if (!response.ok) throw new Error("expected ok");
		const result = response.result as {
			brokerIdentity?: {
				ownerId: string;
				packageGeneration: string;
				startedAt: number;
			};
		};
		expect(result.brokerIdentity).toEqual({
			ownerId: "owner-abc",
			packageGeneration: "test-generation",
			startedAt: 42_000,
		});
	} finally {
		broker.discovery = null;
		await broker.stop();
	}
});

test("resume rejects a stale saved-session identity before any launch effect", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(workspace, { recursive: true });
	const saved = SessionManager.create(workspace, SessionManager.getDefaultSessionDir(workspace, agentDir));
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionPath = saved.getSessionFile();
	if (!sessionPath) throw new Error("expected saved session file");
	const stat = await fs.stat(sessionPath, { bigint: true });
	const staleIdentity = {
		dev: stat.dev.toString(),
		ino: stat.ino.toString(),
		size: Number(stat.size),
		mtimeMs: Number(stat.mtimeMs),
		mtimeNs: stat.mtimeNs.toString(),
	};
	const broker = new Broker({ agentDir });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	const grant = await listWorkspaceGrant(broker, workspace);
	// In-place modification after grant issuance: same dev/ino, changed size/mtime.
	await fs.appendFile(sessionPath, `${JSON.stringify({ type: "user", content: "tamper" })}\n`);
	try {
		const response = await broker.handleRequest(
			"session.resume",
			{
				sessionId,
				brokerOwnerId: broker.ownerId,
				sessionPath,
				sessionIdentity: staleIdentity,
				cwd: workspace,
				workspaceGrantId: grant.grantId,
				workspaceIdentity: grant.identity,
				target: { path: workspace },
			},
			"resume-stale-identity",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "endpoint_stale" },
		});
		expect(await fs.stat(sessionPath)).toBeDefined();
	} finally {
		await broker.stop();
	}
});

test("fork rejects a stale source-session identity before any launch effect", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(workspace, { recursive: true });
	const saved = SessionManager.create(workspace, SessionManager.getDefaultSessionDir(workspace, agentDir));
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionPath = saved.getSessionFile();
	if (!sessionPath) throw new Error("expected saved session file");
	const stat = await fs.stat(sessionPath, { bigint: true });
	const staleIdentity = {
		dev: stat.dev.toString(),
		ino: stat.ino.toString(),
		size: Number(stat.size),
		mtimeMs: Number(stat.mtimeMs),
		mtimeNs: stat.mtimeNs.toString(),
	};
	const broker = new Broker({ agentDir });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	const grant = await listWorkspaceGrant(broker, workspace);
	await fs.appendFile(sessionPath, `${JSON.stringify({ type: "user", content: "tamper" })}\n`);
	try {
		const response = await broker.handleRequest(
			"session.fork",
			{
				sourceSessionId: sessionId,
				brokerOwnerId: broker.ownerId,
				sourceSessionPath: sessionPath,
				sourceSessionIdentity: staleIdentity,
				cwd: workspace,
				workspaceGrantId: grant.grantId,
				workspaceIdentity: grant.identity,
				target: { path: workspace },
			},
			"fork-stale-identity",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "endpoint_stale" },
		});
		expect(await fs.stat(sessionPath)).toBeDefined();
	} finally {
		await broker.stop();
	}
});

test("missing brokerOwnerId is rejected before any side effect", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	try {
		expect(await broker.handleRequest("session.list", { cwd: workspace })).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "brokerOwnerId must be a non-empty string" },
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "missing" })).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "brokerOwnerId must be a non-empty string" },
		});
		expect(await broker.handleRequest("session.create", { cwd: workspace }, "missing-owner-create")).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "brokerOwnerId must be a non-empty string" },
		});
		const ledger = await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "");
		expect(ledger.trim()).toBe("");
	} finally {
		await broker.stop();
	}
});

test("wrong brokerOwnerId is rejected before any index, endpoint, or ledger effect", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: root, packageGeneration: "test" });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	try {
		for (const [operation, input, key] of [
			["session.list", { cwd: workspace }, undefined],
			["session.get_endpoint", { sessionId: "missing" }, undefined],
			["session.create", { cwd: workspace }, "wrong-owner-create"],
		] as Array<[string, Record<string, unknown>, string | undefined]>) {
			expect(await broker.handleRequest(operation, { ...input, brokerOwnerId: "wrong-owner" }, key)).toEqual({
				ok: false,
				error: { code: "endpoint_stale", message: "broker boot authority is stale" },
			});
		}
		const ledger = await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "");
		expect(ledger.trim()).toBe("");
	} finally {
		await broker.stop();
	}
});

test("lifecycle workspace grant admission rejects a missing grant id before the ledger", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const transcriptPath = path.join(workspace, "saved.jsonl");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	try {
		const response = await broker.handleRequest(
			"session.delete",
			{
				brokerOwnerId: broker.ownerId,
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5" },
				cwd: workspace,
				workspaceIdentity: await workspaceIdentity(workspace),
				target: { path: workspace },
			},
			"missing-workspace-grant",
		);
		expect(response).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "workspace grant id is stale or missing" },
		});
		const ledger = await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "");
		expect(ledger.trim()).toBe("");
	} finally {
		await broker.stop();
	}
});

test("lifecycle workspace grant admission rejects an unknown grant id before the ledger", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const transcriptPath = path.join(workspace, "saved.jsonl");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	try {
		const response = await broker.handleRequest(
			"session.delete",
			{
				brokerOwnerId: broker.ownerId,
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5" },
				cwd: workspace,
				workspaceGrantId: "not-a-realized-grant",
				workspaceIdentity: await workspaceIdentity(workspace),
				target: { path: workspace },
			},
			"unknown-workspace-grant",
		);
		expect(response).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "workspace grant id is stale or missing" },
		});
		const ledger = await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "");
		expect(ledger.trim()).toBe("");
	} finally {
		await broker.stop();
	}
});

test("lifecycle workspace grant admission revokes a mismatched identity before the ledger", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const transcriptPath = path.join(workspace, "saved.jsonl");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	try {
		const grant = await listWorkspaceGrant(broker, workspace);
		expect(broker.workspaceGrantsForTest()).toHaveLength(1);
		const response = await broker.handleRequest(
			"session.delete",
			{
				brokerOwnerId: broker.ownerId,
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5" },
				cwd: workspace,
				workspaceGrantId: grant.grantId,
				workspaceIdentity: { dev: "stale-dev", ino: "stale-ino" },
				target: { path: workspace },
			},
			"mismatched-workspace-identity",
		);
		expect(response).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "workspace identity is stale or missing" },
		});
		// The mismatched identity revoked the drifted grant before any ledger row.
		expect(broker.workspaceGrantsForTest()).toHaveLength(0);
		const ledger = await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "");
		expect(ledger.trim()).toBe("");
	} finally {
		await broker.stop();
	}
});

test("a workspace root swap revokes the retained grant before any lifecycle effect", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const transcriptPath = path.join(workspace, "saved.jsonl");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	try {
		// Intern a grant against the original root, then swap the directory entirely.
		const grant = await listWorkspaceGrant(broker, workspace);
		expect(broker.workspaceGrantsForTest()).toHaveLength(1);
		const retained = broker.workspaceGrantsForTest()[0]!;
		await fs.rm(workspace, { recursive: true, force: true });
		await fs.mkdir(workspace, { recursive: true });
		const response = await broker.handleRequest(
			"session.delete",
			{
				brokerOwnerId: broker.ownerId,
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5" },
				cwd: workspace,
				workspaceGrantId: grant.grantId,
				workspaceIdentity: grant.identity,
				target: { path: workspace },
			},
			"root-swap",
		);
		expect(response).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "workspace root no longer binds to its grant" },
		});
		// The drifted grant was revoked before any ledger row, and its handle closed.
		expect(broker.workspaceGrantsForTest()).toHaveLength(0);
		expect(retained.capability.closed).toBe(true);
		const ledger = await fs.readFile(path.join(root, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "");
		expect(ledger.trim()).toBe("");
	} finally {
		await broker.stop();
	}
});

test("WorkspaceCapability retains its opened-directory identity and closes deterministically", async () => {
	const root = await temp();
	const workspace = path.join(root, "ws");
	await fs.mkdir(workspace, { recursive: true });
	const capability = await WorkspaceCapability.open(workspace);
	try {
		expect(capability.canonicalCwd).toBe(await fs.realpath(workspace));
		expect(capability.identity).toEqual(await workspaceIdentity(workspace));
		expect(capability.closed).toBe(false);
		// The retained handle still proves the original binding is live.
		await capability.assertPathStillBound(workspace);
	} finally {
		await capability.close();
	}
	expect(capability.closed).toBe(true);
	// A second close is a deterministic no-op.
	await expect(capability.close()).resolves.toBeUndefined();
});

test("WorkspaceCapability rejects a path that no longer binds to the opened root", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const other = path.join(root, "other");
	await Promise.all([fs.mkdir(workspace), fs.mkdir(other)]);
	const capability = await WorkspaceCapability.open(workspace);
	try {
		await expect(capability.assertPathStillBound(other)).rejects.toThrow();
	} finally {
		await capability.close();
	}
});
test("scoped session.list retains and reuses one workspace grant per bound root", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const other = path.join(root, "other");
	await Promise.all([fs.mkdir(workspace), fs.mkdir(other)]);
	const broker = new Broker({ agentDir: root });
	await broker.index.open();
	try {
		const first = await listWorkspaceGrant(broker, workspace);
		expect(broker.workspaceGrantsForTest()).toHaveLength(1);
		expect(first.identity).toEqual(await workspaceIdentity(workspace));
		// A repeated list for the same still-bound workspace reuses the grant; no
		// redundant handle is retained (no per-list FD leak).
		const second = await listWorkspaceGrant(broker, workspace);
		expect(second.grantId).toBe(first.grantId);
		expect(second.identity).toEqual(first.identity);
		expect(broker.workspaceGrantsForTest()).toHaveLength(1);
		expect(broker.workspaceGrantsForTest()[0]!.capability.closed).toBe(false);
		// A distinct workspace interns a second, independent grant.
		const foreign = await listWorkspaceGrant(broker, other);
		expect(foreign.grantId).not.toBe(first.grantId);
		expect(broker.workspaceGrantsForTest()).toHaveLength(2);
	} finally {
		await broker.stop();
	}
});

test("broker stop closes all retained workspace grant handles", async () => {
	const root = await temp();
	const workspaceA = path.join(root, "workspace-a");
	const workspaceB = path.join(root, "workspace-b");
	await Promise.all([fs.mkdir(workspaceA), fs.mkdir(workspaceB)]);
	const broker = new Broker({ agentDir: root });
	await broker.index.open();
	let grants: ReturnType<typeof broker.workspaceGrantsForTest>;
	try {
		await listWorkspaceGrant(broker, workspaceA);
		await listWorkspaceGrant(broker, workspaceB);
		grants = broker.workspaceGrantsForTest();
		expect(grants).toHaveLength(2);
		expect(grants.every(grant => !grant.capability.closed)).toBe(true);
	} finally {
		await broker.stop();
	}
	// After stop, the grant registry is cleared and every retained handle is closed.
	expect(broker.workspaceGrantsForTest()).toHaveLength(0);
	expect(grants.every(grant => grant.capability.closed)).toBe(true);
});

test("owner rotation keeps durable hashes reachable despite a new grant id", async () => {
	const root = await temp();
	const workspace = path.join(root, "workspace");
	const transcriptPath = path.join(workspace, "saved.jsonl");
	await fs.mkdir(workspace, { recursive: true });
	const ledgerPath = path.join(root, "sdk", "lifecycle-ledger.jsonl");
	const acceptedLedgerEntries = async () =>
		(await fs.readFile(ledgerPath, "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { state: string })
			.filter(entry => entry.state === "accepted");
	// First boot: intern a grant and attempt a delete that fails inside the
	// lifecycle effect (the transcript does not exist) but records a ledger row.
	const brokerA = new Broker({ agentDir: root });
	await Promise.all([brokerA.index.open(), brokerA.ledger.open()]);
	let firstResponse: BrokerResponse;
	let grantAId: string;
	try {
		const grantA = await listWorkspaceGrant(brokerA, workspace);
		grantAId = grantA.grantId;
		firstResponse = await brokerA.handleRequest(
			"session.delete",
			{
				brokerOwnerId: brokerA.ownerId,
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5" },
				cwd: workspace,
				workspaceGrantId: grantA.grantId,
				workspaceIdentity: grantA.identity,
				target: { path: workspace },
			},
			"rotation-replay",
		);
	} finally {
		await brokerA.stop();
	}
	expect((firstResponse as { ok: boolean }).ok).toBe(false);
	expect(await acceptedLedgerEntries()).toHaveLength(1);
	// Second boot (new owner): list issues a brand-new grant id, but the durable
	// request hash excludes the transient grant id and broker owner, so the same
	// idempotency key replays the recorded outcome without re-executing the effect.
	const brokerB = new Broker({ agentDir: root });
	await Promise.all([brokerB.index.open(), brokerB.ledger.open()]);
	try {
		const grantB = await listWorkspaceGrant(brokerB, workspace);
		expect(grantB.grantId).not.toBe(grantAId);
		expect(brokerB.workspaceGrantsForTest()).toHaveLength(1);
		const replay = await brokerB.handleRequest(
			"session.delete",
			{
				brokerOwnerId: brokerB.ownerId,
				sessionId: "saved",
				sessionPath: transcriptPath,
				sessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5" },
				cwd: workspace,
				workspaceGrantId: grantB.grantId,
				workspaceIdentity: grantB.identity,
				target: { path: workspace },
			},
			"rotation-replay",
		);
		expect(replay).toEqual(firstResponse);
		// No second ledger row: the durable hash matched across the owner rotation.
		expect(await acceptedLedgerEntries()).toHaveLength(1);
	} finally {
		await brokerB.stop();
	}
});
