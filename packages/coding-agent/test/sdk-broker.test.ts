import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { getSessionsDir } from "@gajae-code/utils";
import { lifecycleArgs } from "../src/commands/sdk";
import { Broker } from "../src/sdk/broker/broker";
import {
	brokerDiscoveryPath,
	readBrokerDiscovery,
	redactBrokerDiscovery,
	writeBrokerDiscovery,
} from "../src/sdk/broker/discovery";
import { ensureBroker } from "../src/sdk/broker/ensure";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { readSessionLifecycleLaunchRequest } from "../src/sdk/broker/lifecycle";
import { resolveSdkInternalSpawnCommand } from "../src/sdk/broker/runtime";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage, isCanonicalSessionDeletedTombstone } from "../src/session/session-storage";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-"));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const brokerEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
/**
 * Interns a broker workspace grant for cwd via a scoped session.list and returns
 * the broker-issued grant id + {dev,ino} identity to inject into cwd-bearing
 * create/fork/resume/delete requests. Grant ids are boot-transient and stripped
 * from durable idempotency hashes by the broker, so acquiring a fresh grant per
 * request keeps lifecycle replays stable across transient grant ids.
 */
const workspaceGrantOf = async (broker: Broker, cwd: string) => {
	const response = await broker.handleRequest("session.list", { brokerOwnerId: broker.ownerId, cwd });
	if (!response.ok) throw new Error("Expected scoped session.list to issue a workspace grant.");
	const result = response.result as { workspaceGrantId?: unknown; workspaceIdentity?: unknown };
	if (typeof result.workspaceGrantId !== "string" || typeof result.workspaceIdentity !== "object")
		throw new Error("Scoped session.list did not issue a complete workspace grant.");
	return { workspaceGrantId: result.workspaceGrantId, workspaceIdentity: result.workspaceIdentity };
};
const transcriptIdentityOf = (filePath: string) => {
	const snapshot = new FileSessionStorage().readSnapshotSync(filePath);
	return {
		dev: snapshot.stat.dev.toString(),
		ino: snapshot.stat.ino.toString(),
		size: snapshot.stat.size,
		mtimeMs: snapshot.stat.mtimeMs,
		mtimeNs: snapshot.stat.mtimeNs.toString(),
		sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
	};
};

it("SDK internal commands self-spawn compiled binaries without source entrypoints", () => {
	const compiled = {
		execPath: "/opt/gjc/gjc",
		mode: "compiled" as const,
		argsPrefix: [],
		reloadPicksUpSourceEdits: false,
		warning: "Rebuild",
	};
	expect(resolveSdkInternalSpawnCommand("broker-internal", compiled)).toEqual({
		file: "/opt/gjc/gjc",
		args: ["sdk", "broker-internal"],
	});
	expect(resolveSdkInternalSpawnCommand("session-host-internal", compiled)).toEqual({
		file: "/opt/gjc/gjc",
		args: ["sdk", "session-host-internal"],
	});
});

it("SDK lifecycle model presets reach the session host parser", () => {
	const request = readSessionLifecycleLaunchRequest(
		JSON.stringify({
			operation: "session.create",
			sessionId: "session-1",
			stateRoot: "/repo/.gjc/state",

			cwd: "/repo",
			modelPreset: "codex-eco",
			workspaceIdentity: { dev: "1", ino: "2" },
		}),
	);
	expect(lifecycleArgs(request, "/repo", "/agent").mpreset).toBe("codex-eco");
});

it("SDK lifecycle launch requests require a worktree identity", () => {
	expect(() =>
		readSessionLifecycleLaunchRequest(
			JSON.stringify({ operation: "session.create", sessionId: "session-1", stateRoot: "/state" }),
		),
	).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
});
async function waitForDiscovery(agentDir: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const discovery = await readBrokerDiscovery(agentDir);
		if (discovery) return discovery;
		await sleep(20);
	}
	throw new Error("Timed out waiting for broker discovery.");
}
describe("SDK broker identity and discovery", () => {
	it("persists identity and writes a redacted private discovery record", async () => {
		const dir = await temp();
		const a = await getBrokerIdentityKey(dir);
		expect(await getBrokerIdentityKey(dir)).toBe(a);
		const d = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "test",
			ownerId: "x",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: 1,
			heartbeatAt: Date.now(),
		};
		await writeBrokerDiscovery(dir, d);
		expect(redactBrokerDiscovery(d).token).toBe("[redacted]");
		if (process.platform !== "win32")
			expect((await fs.stat(path.join(dir, "sdk", "broker.json"))).mode & 0o777).toBe(0o600);
	});
	it("publishes one complete broker identity atomically under concurrent first use", async () => {
		const dir = await temp();
		const keys = await Promise.all(Array.from({ length: 32 }, () => getBrokerIdentityKey(dir)));
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
		expect((await fs.readFile(path.join(dir, "sdk", "broker.identity"), "utf8")).trim()).toBe(keys[0]);
	});
	it("refreshes discovery heartbeat, removes it on stop, and can restart", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, heartbeatTtlMs: 45 });
		const first = await broker.start();
		const deadline = Date.now() + 5_000;
		let refreshed = await readBrokerDiscovery(dir);
		while ((!refreshed || refreshed.heartbeatAt <= first.heartbeatAt) && Date.now() < deadline) {
			await sleep(10);
			refreshed = await readBrokerDiscovery(dir);
		}
		expect(refreshed?.heartbeatAt).toBeGreaterThan(first.heartbeatAt);
		await broker.stop();
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		const restarted = await ensureBroker({ agentDir: dir });
		expect(restarted.token).not.toBe(first.token);
		const owner = (await import("../src/sdk/broker/ensure")).brokerOwnerForTest(dir);
		await owner?.stop();
	}, 15_000);
	it("leaves exactly one live detached broker after concurrent process startup", async () => {
		const dir = await temp();
		const children = [0, 1].map(() =>
			Bun.spawn([process.execPath, "run", brokerEntrypoint, "sdk", "broker-internal", "--agent-dir", dir], {
				stdout: "ignore",
				stderr: "ignore",
			}),
		);
		try {
			const discovery = await waitForDiscovery(dir);
			// The losing broker exits once it observes the winner's discovery record.
			// Poll instead of a fixed delay so the assertion is robust to CI scheduling
			// (the loser's exit can lag the discovery write under load).
			for (let attempt = 0; attempt < 200 && children.every(child => child.exitCode === null); attempt++)
				await sleep(25);
			const exited = children.filter(child => child.exitCode !== null);
			expect(exited).toHaveLength(1);
			const owner = children.find(child => child.exitCode === null);
			expect(owner).toBeDefined();
			expect(discovery.pid).toBe(owner!.pid!);
			process.kill(discovery.pid, "SIGTERM");
			await Promise.all(children.map(child => child.exited));
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("returns only an endpoint bound to the indexed incarnation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, "state");
		const endpointPath = path.join(stateRoot, "sdk", "s.json");
		const broker = new Broker({ agentDir: dir });
		await broker.index.open();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "s", pid: process.pid, token: "session-secret" }));
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 3,
			pid: process.pid,
			endpointMtimeMs,
		});
		const endpointIncarnation = createHash("sha256")
			.update(JSON.stringify({ endpointGeneration: 3, endpointMtimeMs, pid: process.pid, sessionId: "s" }))
			.digest("hex");
		expect(
			await broker.handleRequest("session.get_endpoint", {
				brokerOwnerId: broker.ownerId,
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation,
			}),
		).toEqual({
			ok: true,
			result: {
				sessionId: "s",
				pid: process.pid,
				token: "session-secret",
				endpointGeneration: 3,
				endpointIncarnation,
			},
		});
		expect(
			await broker.handleRequest("session.get_endpoint", {
				brokerOwnerId: broker.ownerId,
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation: "0".repeat(64),
			}),
		).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		expect(
			await broker.handleRequest("session.get_endpoint", {
				brokerOwnerId: broker.ownerId,
				sessionId: "s",
				endpointGeneration: 2,
			}),
		).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 4,
			pid: process.pid,
			endpointMtimeMs: endpointMtimeMs + 1,
		});
		expect(
			await broker.handleRequest("session.get_endpoint", {
				brokerOwnerId: broker.ownerId,
				sessionId: "s",
				endpointGeneration: 4,
			}),
		).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
	});
	it("rejects a cross-scope live resume without returning the indexed endpoint", async () => {
		const dir = await temp();
		const liveCwd = path.join(dir, "live-workspace");
		const requestedCwd = path.join(dir, "requested-workspace");
		const stateRoot = path.join(liveCwd, ".gjc", "state");
		const sessionId = "shared-live-session";
		const sessionDir = SessionManager.getDefaultSessionDir(liveCwd, dir);
		const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(requestedCwd, { recursive: true });
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd: liveCwd })}\n`,
		);
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, token: "foreign-workspace-token" }),
		);
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: liveCwd, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			const grant = await workspaceGrantOf(broker, requestedCwd);
			const result = await broker.handleRequest(
				"session.resume",
				{
					brokerOwnerId: broker.ownerId,
					cwd: requestedCwd,
					target: { path: requestedCwd },
					sessionId,
					sessionPath,
					...grant,
				},
				"cross-scope-resume",
			);
			expect(result).toEqual({
				ok: false,
				error: {
					code: "endpoint_stale",
					message: "Live session does not match the requested resume scope.",
				},
			});
			expect(JSON.stringify(result)).not.toContain("foreign-workspace-token");
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("replays only the same lifecycle body and conflicts when a caller reuses its key for the same target", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const input = {
				brokerOwnerId: broker.ownerId,
				sessionId: "saved",
				sessionPath: path.join(dir, "missing.json"),
				trace: "first",
			};
			const first = await broker.handleRequest("session.delete", input, "caller-key");
			expect(await broker.handleRequest("session.delete", input, "caller-key")).toEqual(first);
			expect(await broker.handleRequest("session.delete", { ...input, trace: "changed" }, "caller-key")).toEqual({
				ok: false,
				error: { code: "idempotency_conflict", message: "idempotency key was used with a different request" },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("binds session.delete to the requested session header and configured storage root", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "repo");
		const sessions = path.join(getSessionsDir(dir), "project");
		const requested = path.join(sessions, "requested.jsonl");
		const other = path.join(sessions, "other.jsonl");
		await fs.mkdir(sessions, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(requested, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
		await fs.writeFile(other, `${JSON.stringify({ type: "session", id: "other" })}\n`);
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const grant = await workspaceGrantOf(broker, cwd);
			const otherIdentity = transcriptIdentityOf(other);
			expect(
				await broker.handleRequest(
					"session.delete",
					{
						brokerOwnerId: broker.ownerId,
						sessionId: "requested",
						sessionPath: other,
						sessionIdentity: otherIdentity,
						cwd,
						...grant,
					},
					"delete-cross-session",
				),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "session.delete path does not contain the requested session." },
			});
			expect(await fs.readFile(other, "utf8")).toContain('"other"');
			expect(
				await broker.handleRequest(
					"session.delete",
					{
						brokerOwnerId: broker.ownerId,
						sessionId: "requested",
						sessionPath: path.join(dir, "outside.jsonl"),
						cwd,
						...grant,
					},
					"delete-outside-root",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is outside the configured session storage root.",
				},
			});
			expect(await fs.readFile(requested, "utf8")).toContain('"requested"');
			const external = path.join(dir, "external.jsonl");
			const externalArtifacts = external.slice(0, -6);
			const linked = path.join(sessions, "linked.jsonl");
			await fs.writeFile(external, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
			await fs.mkdir(externalArtifacts);
			await fs.symlink(external, linked);
			expect(
				await broker.handleRequest(
					"session.delete",
					{ brokerOwnerId: broker.ownerId, sessionId: "requested", sessionPath: linked, cwd, ...grant },
					"delete-symlink-escape",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is a symlink.",
				},
			});
			expect(await fs.readFile(external, "utf8")).toContain('"requested"');
			expect((await fs.stat(externalArtifacts)).isDirectory()).toBe(true);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects traversal and conflicting session-id aliases before lifecycle state access", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(
				await broker.handleRequest("session.get_endpoint", {
					brokerOwnerId: broker.ownerId,
					sessionId: "../escape",
				}),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "sessionId must be a canonical safe identifier" },
			});
			expect(
				await broker.handleRequest(
					"session.close",
					{ brokerOwnerId: broker.ownerId, sessionId: "session-a", id: "session-b" },
					"alias-conflict",
				),
			).toEqual({ ok: false, error: { code: "invalid_input", message: "sessionId aliases conflict" } });
			await expect(fs.stat(path.join(dir, "sdk", "escape.json"))).rejects.toThrow();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replays id and sessionId lifecycle aliases under one caller idempotency key", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const first = await broker.handleRequest(
				"session.close",
				{ brokerOwnerId: broker.ownerId, sessionId: "missing" },
				"same-close",
			);
			expect(
				await broker.handleRequest("session.close", { brokerOwnerId: broker.ownerId, id: "missing" }, "same-close"),
			).toEqual(first);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a non-default lifecycle state root at broker ingress", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(
				await broker.handleRequest(
					"session.create",
					{ brokerOwnerId: broker.ownerId, cwd: dir, stateRoot: path.join(dir, "alternate-state") },
					"alternate-state-root",
				),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "stateRoot must be the default .gjc/state for cwd." },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("uses verified deletion to remove the exact transcript, artifacts, and indexed authority", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "verified-delete";
		const sessionPath = path.join(getSessionsDir(dir), "project", `${sessionId}.jsonl`);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await fs.writeFile(path.join(artifactsDir, "artifact.txt"), "artifact");
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			const grant = await workspaceGrantOf(broker, cwd);
			const sessionIdentity = transcriptIdentityOf(sessionPath);
			expect(
				await broker.handleRequest(
					"session.delete",
					{ brokerOwnerId: broker.ownerId, sessionId, sessionPath, sessionIdentity, cwd, ...grant },
					"verified-delete-key",
				),
			).toEqual({ ok: true, result: { sessionId } });
			// Verified delete tombstones the transcript in place as a canonical
			// session_deleted descriptor (the pathname is never unlinked); the
			// artifacts directory is still removed and a scoped list omits it.
			const tombstone = JSON.parse((await fs.readFile(sessionPath, "utf8")).trim());
			expect(isCanonicalSessionDeletedTombstone(tombstone)).toBe(true);
			expect(tombstone.id).toBe(sessionId);
			await expect(fs.stat(artifactsDir)).rejects.toThrow();
			expect(await broker.handleRequest("session.list", { brokerOwnerId: broker.ownerId, cwd })).toMatchObject({
				ok: true,
				result: { sessions: [] },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves typed verified-delete partial-cleanup evidence", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "pending-delete";
		const sessionPath = path.join(getSessionsDir(dir), `${sessionId}.jsonl`);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async () => ({
			kind: "cleanup_pending" as const,

			phase: "artifacts" as const,
			error: new Error("artifact cleanup denied"),
			artifactsIdentity: { dev: 7n, ino: 8n },
			transcriptIdentity: { dev: 5n, ino: 6n },
		});
		try {
			const grant = await workspaceGrantOf(broker, cwd);
			const sessionIdentity = transcriptIdentityOf(sessionPath);
			const pending = await broker.handleRequest(
				"session.delete",
				{ brokerOwnerId: broker.ownerId, sessionId, sessionPath, sessionIdentity, cwd, ...grant },
				"pending-delete-key",
			);
			expect(pending).toEqual({
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Saved session cleanup is pending in artifacts: artifact cleanup denied",
					cleanup: {
						phase: "artifacts",
						artifactsIdentity: { dev: "7", ino: "8" },
						transcriptIdentity: { dev: "5", ino: "6" },
					},
				},
			});
			expect(
				await broker.handleRequest(
					"session.delete",
					{ brokerOwnerId: broker.ownerId, sessionId, sessionPath, sessionIdentity, cwd, ...grant },
					"pending-delete-key",
				),
			).toEqual(pending);
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns endpoint_stale without dispatching close after endpoint generation rotation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "rotating";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		let controlRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					void (async () => {
						await fs.writeFile(
							endpointPath,
							JSON.stringify({
								sessionId,
								pid: process.pid,
								url: `ws://127.0.0.1:${server.port}`,
								token: "replacement-token",
							}),
						);
						await broker.index.append({
							type: "host_registered",
							sessionId,
							locator: { repo: dir, stateRoot },
							endpointGeneration: 2,
							pid: process.pid,
							endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
						});
						ws.send(JSON.stringify({ type: "hello" }));
					})();
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string; type?: string };
					if (frame.type === "control_request") controlRequests++;
					if (frame.id) ws.send(JSON.stringify({ id: frame.id, ok: true }));
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "initial-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			expect(
				await broker.handleRequest("session.close", { brokerOwnerId: broker.ownerId, sessionId }, "rotating-close"),
			).toEqual({
				ok: false,
				error: { code: "endpoint_stale", message: "session endpoint is stale" },
			});
			expect(controlRequests).toBe(0);
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves a typed session-host close failure without signal fallback", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "flush-failure";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					ws.send(JSON.stringify({ type: "hello" }));
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string };
					if (frame.id)
						ws.send(
							JSON.stringify({
								id: frame.id,
								ok: false,
								error: { code: "flush_failed", message: "session flush failed" },
							}),
						);
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "flush-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			expect(
				await broker.handleRequest("session.close", { brokerOwnerId: broker.ownerId, sessionId }, "flush-close"),
			).toEqual({
				ok: false,
				error: { code: "flush_failed", message: "session flush failed" },
			});
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
