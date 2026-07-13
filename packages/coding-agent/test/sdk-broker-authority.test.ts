import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
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

/** Reference formula: sorted-key JSON.stringify over the authority tuple. */
const incarnation = (sessionId: string, generation: number, mtimeMs: number, pid: number) =>
	createHash("sha256")
		.update(JSON.stringify({ endpointGeneration: generation, endpointMtimeMs: mtimeMs, pid, sessionId }))
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
	locator: { repo: overrides.repo ?? "repo", stateRoot: overrides.stateRoot ?? "root" },
	endpointGeneration: overrides.endpointGeneration,
	pid: overrides.pid,
	...(overrides.endpointMtimeMs === undefined ? {} : { endpointMtimeMs: overrides.endpointMtimeMs }),
});

test("production index preserves cross-workspace duplicate session ids as distinct evidence", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(
		registered({ sessionId: "shared", repo: "/ws-a", endpointGeneration: 1, pid: 111_111, endpointMtimeMs: 1000 }),
	);
	await index.append(
		registered({ sessionId: "shared", repo: "/ws-b", endpointGeneration: 1, pid: 222_222, endpointMtimeMs: 2000 }),
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
		registered({ sessionId: "successor", endpointGeneration: 1, pid: 111_111, endpointMtimeMs: 1000 }),
	);
	await index.append(
		registered({ sessionId: "successor", endpointGeneration: 2, pid: 111_111, endpointMtimeMs: 2000 }),
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
		registered({ sessionId: "successor", endpointGeneration: 1, pid: 111_111, endpointMtimeMs: 1000 }),
	);
	await index.append(
		registered({ sessionId: "successor", endpointGeneration: 2, pid: 111_111, endpointMtimeMs: 2000 }),
	);
	const sessions = index.listSessions().sessions.filter(session => session.sessionId === "successor");
	expect(sessions).toHaveLength(1);
	expect(sessions[0]?.endpointGeneration).toBe(2);
});

test("production index exposes a stable endpointIncarnation matching the authority formula", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(registered({ sessionId: "ep", endpointGeneration: 5, pid: 333_333, endpointMtimeMs: 5000 }));
	const [session] = index.listSessions().sessions;
	expect(session.endpointIncarnation).toBe(incarnation("ep", 5, 5000, 333_333));
	expect(session.endpointIncarnation).toBe(endpointIncarnation(session, "ep"));
	expect(session.endpointIncarnation).toMatch(/^[a-f0-9]{64}$/);
});

test("production index omits endpointIncarnation when endpoint authority is incomplete", async () => {
	const dir = await temp();
	const index = await new SessionIndex(dir).open();
	await index.append(registered({ sessionId: "incomplete", endpointGeneration: 5, pid: 333_333 }));
	expect(index.listSessions().sessions[0]?.endpointIncarnation).toBeUndefined();
});

test("scoped session.list issues a realpath canonicalCwd resolving lexical aliases", async () => {
	const dir = await temp();
	const workspace = path.join(dir, "workspace");
	await fs.mkdir(workspace, { recursive: true });
	const broker = new Broker({ agentDir: dir });
	await broker.index.open();
	try {
		const aliased = await broker.handleRequest("session.list", { cwd: path.join(workspace, ".") });
		expect(aliased.ok).toBe(true);
		if (!aliased.ok) throw new Error("expected ok");
		const aliasedResult = aliased.result as { canonicalCwd?: string };
		const real = await fs.realpath(workspace);
		expect(aliasedResult.canonicalCwd).toBe(real);
		const direct = await broker.handleRequest("session.list", { cwd: workspace });
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
		const response = await broker.handleRequest("session.list", {});
		expect(response.ok).toBe(true);
		if (!response.ok) throw new Error("expected ok");
		expect((response.result as { canonicalCwd?: string }).canonicalCwd).toBeUndefined();
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
		const response = await broker.handleRequest("session.list", { cwd: workspace, resolveSessionId: sessionId });
		expect(response.ok).toBe(true);
		if (!response.ok) throw new Error("expected ok");
		const result = response.result as {
			canonicalCwd?: string;
			savedSession?: {
				id: string;
				path: string;
				sessionIdentity?: { dev: string; ino: string; size: number; mtimeMs: number; mtimeNs: string };
			};
		};
		expect(result.canonicalCwd).toBe(await fs.realpath(workspace));
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
	const response = await broker.handleRequest("session.list", { cwd: workspaceA });
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

test("close idempotency identities are scoped to endpoint incarnation", async () => {
	const root = await temp();
	const broker = new Broker({ agentDir: root });
	await Promise.all([broker.index.open(), broker.ledger.open()]);
	const firstIncarnation = "a".repeat(64);
	const secondIncarnation = "b".repeat(64);
	await broker.handleRequest(
		"session.close",
		{ sessionId: "successor", endpointGeneration: 1, endpointIncarnation: firstIncarnation },
		"same-key",
	);
	await broker.handleRequest(
		"session.close",
		{ sessionId: "successor", endpointGeneration: 2, endpointIncarnation: secondIncarnation },
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
	const response = await broker.handleRequest(
		"session.delete",
		{
			sessionId,
			sessionPath,
			sessionIdentity: staleIdentity,
			cwd: workspace,
			target: { path: workspace },
		},
		"delete-stale-transcript",
	);
	expect(response).toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
	expect(await fs.stat(sessionPath)).toBeDefined();
});
