import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { RuntimeOwner, resolveOwner } from "../../src/harness-control-plane/owner";
import { acquireLease, readLease } from "../../src/harness-control-plane/session-lease";
import type { HarnessSessionTransport } from "../../src/harness-control-plane/session-transport";
import { controlSocketPath, sessionPaths, writeSessionState } from "../../src/harness-control-plane/storage";
import { SESSION_SCHEMA_VERSION, type SessionHandle, type SessionState } from "../../src/harness-control-plane/types";
import { createHarnessCliEnv, type HarnessCliEnv } from "./cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const SID = "h-route";
const SECRET = "planted-prompt-secret";
const FORGED = "forged-owner-marker";
const ALLOWED = "canonical-owner-marker";

function symlinkSupported(): boolean {
	const windows = process.platform === "win32";
	if (windows) {
		return false;
	}
	const dir = fsSync.mkdtempSync(path.join(tmpdir(), "sy"));
	try {
		fsSync.symlinkSync(path.join(dir, "t"), path.join(dir, "l"));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM") {
			return false;
		}
		throw error;
	} finally {
		fsSync.rmSync(dir, { recursive: true, force: true });
	}
}

const canSymlink = symlinkSupported();

function privatePrefixAlias(canonical: string): string | null {
	if (process.platform !== "darwin") {
		return null;
	}
	if (canonical.startsWith("/private/")) {
		const rest = canonical.slice("/private".length);
		if (rest.startsWith("/var/") || rest.startsWith("/tmp/")) return rest;
		return null;
	}
	if (canonical.startsWith("/var/") || canonical.startsWith("/tmp/")) return `/private${canonical}`;
	return null;
}

const privatePrefixAliasAvailable = privatePrefixAlias(path.join(tmpdir(), "c.sock")) !== null;

let root: string;
let cliEnv: HarnessCliEnv;
const extraDirs: string[] = [];

function seed(): SessionState {
	const now = new Date().toISOString();
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId: SID,
		lifecycle: "started",
		harness: "gajae-code",
		handle: { sessionId: SID, harness: "gajae-code", workspace: root, branch: "feat/x" } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

async function plantLease(endpointPath: string): Promise<void> {
	const now = Date.now();
	const lease = {
		ownerId: "owner-planted",
		sessionId: SID,
		pid: process.pid,
		leaseTokenHash: "ab".repeat(32),
		endpoint: { kind: "unix-socket", path: endpointPath },
		eventsPath: sessionPaths(root, SID).events,
		heartbeatAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 60_000).toISOString(),
		leaseEpoch: 1,
		writer: { ownerId: "owner-planted", leaseEpoch: 1 },
	};
	await writeFile(sessionPaths(root, SID).lease, `${JSON.stringify(lease)}\n`, "utf8");
}

function listen(socketPath: string, marker: string): Promise<{ received: string[]; close: () => Promise<void> }> {
	const received: string[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buf = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			received.push(buf.slice(0, nl));
			socket.write(`${JSON.stringify({ ok: true, evidence: { marker } })}\n`);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			resolve({
				received,
				close: () =>
					new Promise(done => {
						for (const socket of sockets) socket.destroy();
						server.close(() => done());
					}),
			});
		});
	});
}

class IdleTransport implements HarnessSessionTransport {
	async getState() {
		return { isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 };
	}
	eventCursor(): number {
		return 0;
	}
	async sendPrompt() {
		return { commandId: "route", ack: true };
	}
	async waitForAgentStart() {
		return null;
	}
	async close(): Promise<void> {}
}

async function withSocketEnv(
	overrides: Record<string, string | undefined>,
	fn: (owner: RuntimeOwner) => Promise<void>,
): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(overrides)) {
		saved[key] = process.env[key];
		const value = overrides[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	let owner: RuntimeOwner | null = null;
	try {
		owner = new RuntimeOwner({
			root,
			sessionId: SID,
			transport: new IdleTransport(),
			heartbeatMs: 60_000,
		});
		await owner.start();
		await fn(owner);
	} finally {
		await owner?.stop();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function recordPath(): Promise<string | null> {
	const mod = await import("../../src/harness-control-plane/session-lease");
	const fn = (mod as { ownerSocketRecordPath?: (sessionRoot: string, sessionId: string) => string | null })
		.ownerSocketRecordPath;
	return fn ? fn(root, SID) : null;
}

function forgedRecord(socketPath: string): string {
	return JSON.stringify({
		socketPath,
		pid: process.pid,
		ownerId: "owner-planted",
		leaseEpoch: 1,
		nonce: "ab".repeat(32),
	});
}

async function expectUntrustedRecordIgnored(setup: (dir: string, file: string) => void): Promise<void> {
	const foreign = path.join(root, "attacker.sock");
	const server = await listen(foreign, FORGED);
	let sessionDir: string | null = null;
	try {
		const file = await recordPath();
		expect(file).toBeTruthy();
		sessionDir = path.dirname(file!);
		setup(sessionDir, file!);
		await plantLease(foreign);
		const promptFile = path.join(root, "prompt.txt");
		await writeFile(promptFile, SECRET, "utf8");
		const res = await runHarness(["submit", "--session", SID, "--prompt-file", promptFile, "--input", "{}"]);
		expect(server.received).toHaveLength(0);
		expect(server.received.join("\n")).not.toContain(SECRET);
		expect(res.raw).not.toContain(FORGED);
		await expect(
			acquireLease(root, SID, {
				ownerId: "owner-other",
				pid: process.pid,
				eventsPath: sessionPaths(root, SID).events,
				endpoint: { kind: "unix-socket", path: controlSocketPath(root, SID) },
				ttlMs: 10_000,
			}),
		).rejects.toThrow(/lease_held/);
		expect((await readLease(root, SID))?.ownerId).toBe("owner-planted");
	} finally {
		await server.close();
		if (sessionDir) fsSync.rmSync(sessionDir, { recursive: true, force: true });
	}
}

async function runHarness(
	args: string[],
	extra: Record<string, string> = {},
): Promise<{ code: number; raw: string; stderr: string }> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(cliEnv.env)) {
		if (value !== undefined) env[name] = value;
	}
	env.GJC_HARNESS_STATE_ROOT = root;
	env.GJC_SESSION_ID = "route-test";
	Object.assign(env, extra);
	const proc = Bun.spawn([process.execPath, cliEntry, "harness", ...args], {
		cwd: root,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, raw: stdout, stderr };
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "hsr-"));
	cliEnv = createHarnessCliEnv(repoRoot);
	await writeSessionState(root, seed());
});

afterEach(async () => {
	cliEnv.cleanup();
	await rm(root, { recursive: true, force: true });
	await Promise.all(extraDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("harness owner socket routing", () => {
	it.skipIf(process.platform === "win32")(
		"does not dial a workspace lease endpoint outside the private socket",
		async () => {
			const foreign = path.join(root, "attacker.sock");
			expect(Buffer.byteLength(foreign)).toBeLessThanOrEqual(100);
			const server = await listen(foreign, FORGED);
			try {
				await plantLease(foreign);
				const promptFile = path.join(root, "prompt.txt");
				await writeFile(promptFile, SECRET, "utf8");
				const res = await runHarness(["submit", "--session", SID, "--prompt-file", promptFile, "--input", "{}"]);
				expect(server.received.join("\n")).not.toContain(SECRET);
				expect(server.received).toHaveLength(0);
				expect(res.raw).not.toContain(FORGED);
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"allows a private owner socket to receive observe",
		async () => {
			const canonical = controlSocketPath(root, SID);
			const server = await listen(canonical, ALLOWED);
			try {
				await plantLease(canonical);
				const res = await runHarness(["observe", "--session", SID]);
				expect(res.code).toBe(0);
				expect(res.raw).toContain(ALLOWED);
				expect(server.received.some(line => line.includes('"observe"'))).toBe(true);
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"dials the private socket when the lease path uses dot segments",
		async () => {
			const canonical = controlSocketPath(root, SID);
			const dotted = `${canonical}${path.sep}..${path.sep}${path.basename(canonical)}`;
			const server = await listen(canonical, ALLOWED);
			try {
				await plantLease(dotted);
				const res = await runHarness(["observe", "--session", SID]);
				expect(res.code).toBe(0);
				expect(res.raw).toContain(ALLOWED);
				expect(server.received.some(line => line.includes('"observe"'))).toBe(true);
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"allows a custom socket directory to receive observe",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir);
			const env = { GJC_HARNESS_SOCKET_DIR: socketDir };
			const canonical = controlSocketPath(root, SID, env);
			const server = await listen(canonical, ALLOWED);
			try {
				await plantLease(canonical);
				const res = await runHarness(["observe", "--session", SID], env);
				expect(res.code).toBe(0);
				expect(res.raw).toContain(ALLOWED);
				expect(server.received.some(line => line.includes('"observe"'))).toBe(true);
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it.skipIf(process.platform !== "darwin")(
		"allows a different letter case of the private socket name to receive observe",
		async () => {
			const canonical = controlSocketPath(root, SID);
			const cased = path.join(path.dirname(canonical), path.basename(canonical).toUpperCase());
			expect(cased).not.toBe(canonical);
			const server = await listen(canonical, ALLOWED);
			try {
				await plantLease(cased);
				const res = await runHarness(["observe", "--session", SID]);
				expect(res.code).toBe(0);
				expect(res.raw).toContain(ALLOWED);
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it.skipIf(process.platform !== "darwin" || !privatePrefixAliasAvailable)(
		"allows the private-var alias of the private socket to receive observe",
		async () => {
			const canonical = controlSocketPath(root, SID);
			const alias = privatePrefixAlias(canonical);
			expect(alias).toBeTruthy();
			expect(alias).not.toBe(canonical);
			const server = await listen(canonical, ALLOWED);
			try {
				await plantLease(alias!);
				const res = await runHarness(["observe", "--session", SID]);
				expect(res.code).toBe(0);
				expect(res.raw).toContain(ALLOWED);
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"does not dial a symlink placed at the private socket",
		async () => {
			const foreign = path.join(root, "attacker.sock");
			const canonical = controlSocketPath(root, SID);
			const server = await listen(foreign, FORGED);
			try {
				await fsSync.promises.symlink(foreign, canonical);
				await plantLease(canonical);
				const promptFile = path.join(root, "prompt.txt");
				await writeFile(promptFile, SECRET, "utf8");
				const res = await runHarness(["submit", "--session", SID, "--prompt-file", promptFile, "--input", "{}"]);
				expect(server.received).toHaveLength(0);
				expect(res.raw).not.toContain(FORGED);
				expect(server.received.join("\n")).not.toContain(SECRET);
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"routes observe to a live owner when the command omits the socket dir",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir);
			await withSocketEnv({ GJC_HARNESS_SOCKET_DIR: socketDir }, async () => {
				const res = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: "" });
				const body = JSON.parse(res.raw) as {
					evidence?: { ownerRouted?: boolean };
					state?: { ownerLive?: boolean };
				};
				expect(res.code).toBe(0);
				expect(body.evidence?.ownerRouted).toBe(true);
				expect(body.state?.ownerLive).toBe(true);
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"routes observe to a live owner when the command socket dir differs",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir, otherDir);
			await withSocketEnv({ GJC_HARNESS_SOCKET_DIR: socketDir }, async () => {
				const res = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: otherDir });
				const body = JSON.parse(res.raw) as { evidence?: { ownerRouted?: boolean } };
				expect(res.code).toBe(0);
				expect(body.evidence?.ownerRouted).toBe(true);
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"routes across socket environments despite a stale PID temp file or symlink",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir, otherDir);
			const file = await recordPath();
			if (!file) throw new Error("missing socket record path");
			const stale = `${file}.tmp-${process.pid}`;
			const sentinel = path.join(root, "sentinel");
			fsSync.writeFileSync(sentinel, "untouched");
			try {
				for (const kind of ["file", "symlink"]) {
					fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
					if (kind === "file") fsSync.writeFileSync(stale, "stale", { mode: 0o600 });
					else fsSync.symlinkSync(sentinel, stale);
					await withSocketEnv({ GJC_HARNESS_SOCKET_DIR: socketDir }, async () => {
						const res = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: otherDir });
						const body = JSON.parse(res.raw) as { evidence?: { ownerRouted?: boolean } };
						expect(res.code).toBe(0);
						expect(body.evidence?.ownerRouted).toBe(true);
						expect(fsSync.existsSync(file)).toBe(true);
					});
					expect(fsSync.existsSync(file)).toBe(false);
					expect(fsSync.readFileSync(sentinel, "utf8")).toBe("untouched");
					expect(fsSync.lstatSync(stale).isSymbolicLink()).toBe(kind === "symlink");
					if (kind === "file") expect(fsSync.readFileSync(stale, "utf8")).toBe("stale");
					fsSync.unlinkSync(stale);
				}
			} finally {
				fsSync.rmSync(path.dirname(file), { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"routes observe through the socket record when the user sets a symlinked socket dir",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const holder = await mkdtemp(path.join(tmpdir(), "hsl-"));
			extraDirs.push(socketDir, holder);
			const linked = path.join(holder, "s");
			fsSync.symlinkSync(socketDir, linked);
			const storage = (await import("../../src/harness-control-plane/storage")) as {
				controlSocketPathFor?: (sessionRoot: string, sessionId: string, env: NodeJS.ProcessEnv) => string | null;
			};
			await withSocketEnv({ GJC_HARNESS_SOCKET_DIR: linked }, async () => {
				// Lookup rejects the symlinked base, so only the lease-bound record can route this owner.
				if (storage.controlSocketPathFor) {
					expect(storage.controlSocketPathFor(root, SID, { GJC_HARNESS_SOCKET_DIR: linked })).toBeNull();
				}
				const res = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: linked });
				const body = JSON.parse(res.raw) as { evidence?: { ownerRouted?: boolean } };
				expect(res.code).toBe(0);
				expect(body.evidence?.ownerRouted).toBe(true);
			});
			expect(fsSync.lstatSync(linked).isSymbolicLink()).toBe(true);
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"routes the same owner when only one side spells the state root through a symlink",
		async () => {
			const holder = await mkdtemp(path.join(tmpdir(), "hsl-"));
			extraDirs.push(holder);
			const linked = path.join(holder, "root");
			fsSync.symlinkSync(root, linked);
			const real = fsSync.realpathSync(root);
			for (const [ownerRoot, lookupRoot] of [
				[linked, real],
				[real, linked],
				[root, root],
			]) {
				const owner = new RuntimeOwner({
					root: ownerRoot,
					sessionId: SID,
					transport: new IdleTransport(),
					heartbeatMs: 60_000,
				});
				await owner.start();
				try {
					const resolved = await resolveOwner(lookupRoot, SID);
					expect(resolved.live).toBe(true);
					expect(resolved.socketPath).not.toBeNull();
					const res = await runHarness(["observe", "--session", SID], { GJC_HARNESS_STATE_ROOT: lookupRoot });
					const body = JSON.parse(res.raw) as { evidence?: { ownerRouted?: boolean } };
					expect(res.code).toBe(0);
					expect(body.evidence?.ownerRouted).toBe(true);
				} finally {
					await owner.stop();
				}
			}
		},
		40_000,
	);

	it.skipIf(process.platform === "win32")(
		"routes observe to a live owner when the command temp dir differs",
		async () => {
			const ownerTmp = await mkdtemp(path.join(tmpdir(), "hst-"));
			const commandTmp = await mkdtemp(path.join(tmpdir(), "hst-"));
			extraDirs.push(ownerTmp, commandTmp);
			await withSocketEnv({ TMPDIR: ownerTmp, GJC_HARNESS_SOCKET_DIR: undefined }, async () => {
				const res = await runHarness(["observe", "--session", SID], {
					TMPDIR: commandTmp,
					GJC_HARNESS_SOCKET_DIR: "",
				});
				const body = JSON.parse(res.raw) as { evidence?: { ownerRouted?: boolean } };
				expect(res.code).toBe(0);
				expect(body.evidence?.ownerRouted).toBe(true);
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"holds a live owner lease when a second acquire uses another socket dir",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir, otherDir);
			await withSocketEnv({ GJC_HARNESS_SOCKET_DIR: socketDir }, async () => {
				const previous = process.env.GJC_HARNESS_SOCKET_DIR;
				delete process.env.GJC_HARNESS_SOCKET_DIR;
				process.env.GJC_HARNESS_SOCKET_DIR = otherDir;
				try {
					await expect(
						acquireLease(root, SID, {
							ownerId: "owner-other",
							pid: process.pid,
							eventsPath: sessionPaths(root, SID).events,
							endpoint: { kind: "unix-socket", path: controlSocketPath(root, SID) },
							ttlMs: 10_000,
						}),
					).rejects.toThrow(/lease_held/);
				} finally {
					if (previous === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
					else process.env.GJC_HARNESS_SOCKET_DIR = previous;
				}
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"a second owner start from another socket dir leaves the first lease and record",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir, otherDir);
			const saved = process.env.GJC_HARNESS_SOCKET_DIR;
			process.env.GJC_HARNESS_SOCKET_DIR = socketDir;
			const owner1 = new RuntimeOwner({
				root,
				sessionId: SID,
				transport: new IdleTransport(),
				heartbeatMs: 60_000,
			});
			try {
				await owner1.start();
				const before = await readLease(root, SID);
				const file = await recordPath();
				expect(file).toBeTruthy();
				const recordBefore = fsSync.readFileSync(file!, "utf8");
				process.env.GJC_HARNESS_SOCKET_DIR = otherDir;
				const owner2 = new RuntimeOwner({
					root,
					sessionId: SID,
					transport: new IdleTransport(),
					heartbeatMs: 60_000,
				});
				await expect(owner2.start()).rejects.toThrow(/lease_held/);
				const after = await readLease(root, SID);
				expect(after?.ownerId).toBe(before?.ownerId);
				expect(after?.leaseEpoch).toBe(before?.leaseEpoch);
				expect(after?.endpoint).toEqual(before?.endpoint);
				expect(fsSync.readFileSync(file!, "utf8")).toBe(recordBefore);
				const res = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: socketDir });
				const body = JSON.parse(res.raw) as { evidence?: { ownerRouted?: boolean } };
				expect(res.code).toBe(0);
				expect(body.evidence?.ownerRouted).toBe(true);
			} finally {
				await owner1.stop();
				const file = await recordPath();
				if (file) fsSync.rmSync(path.dirname(file), { recursive: true, force: true });
				if (saved === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
				else process.env.GJC_HARNESS_SOCKET_DIR = saved;
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"clears the socket record when owner start fails after the lease is held",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir);
			const savedSocket = process.env.GJC_HARNESS_SOCKET_DIR;
			process.env.GJC_HARNESS_SOCKET_DIR = socketDir;
			const owner = new RuntimeOwner({
				root,
				sessionId: SID,
				transport: new IdleTransport(),
				heartbeatMs: 60_000,
				controlServerFactory: () =>
					({
						listen: async () => {
							const file = await recordPath();
							if (!file || !fsSync.existsSync(file)) throw new Error("record-missing");
							throw new Error("listen-failed");
						},
						close: async () => {},
					}) as never,
			});
			try {
				await expect(owner.start()).rejects.toThrow(/listen-failed/);
				expect(await readLease(root, SID)).toBeNull();
				const file = await recordPath();
				expect(file).toBeTruthy();
				expect(fsSync.existsSync(file!)).toBe(false);
			} finally {
				const file = await recordPath();
				if (file) fsSync.rmSync(path.dirname(file), { recursive: true, force: true });
				if (savedSocket === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
				else process.env.GJC_HARNESS_SOCKET_DIR = savedSocket;
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"keeps a base-format live lease when another socket dir reads it",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir, otherDir);
			const endpoint = controlSocketPath(root, SID, { GJC_HARNESS_SOCKET_DIR: socketDir });
			const server = await listen(endpoint, ALLOWED);
			const saved = process.env.GJC_HARNESS_SOCKET_DIR;
			try {
				await plantLease(endpoint);
				const same = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: socketDir });
				expect(same.code).toBe(0);
				expect(same.raw).toContain(ALLOWED);
				expect(server.received.some(line => line.includes('"observe"'))).toBe(true);
				process.env.GJC_HARNESS_SOCKET_DIR = otherDir;
				await expect(
					acquireLease(root, SID, {
						ownerId: "owner-other",
						pid: process.pid,
						eventsPath: sessionPaths(root, SID).events,
						endpoint: { kind: "unix-socket", path: controlSocketPath(root, SID) },
						ttlMs: 10_000,
					}),
				).rejects.toThrow(/lease_held/);
				expect((await readLease(root, SID))?.ownerId).toBe("owner-planted");
				expect((await readLease(root, SID))?.endpoint?.path).toBe(endpoint);
			} finally {
				await server.close();
				if (saved === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
				else process.env.GJC_HARNESS_SOCKET_DIR = saved;
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"keeps the trust boundary for a record-less lease from another socket dir",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir, otherDir);
			const endpoint = controlSocketPath(root, SID, { GJC_HARNESS_SOCKET_DIR: socketDir });
			const server = await listen(endpoint, ALLOWED);
			try {
				await plantLease(endpoint);
				const same = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: socketDir });
				expect(same.raw).toContain(ALLOWED);
				const before = server.received.length;
				const other = await runHarness(["observe", "--session", SID], { GJC_HARNESS_SOCKET_DIR: otherDir });
				expect(other.raw).not.toContain(ALLOWED);
				expect(server.received.length).toBe(before);
				// Intentional boundary (Known limits): without a lease-bound record the command cannot prove
				// the endpoint is the owner's private socket, so it does not dial it and reports no owner.
				const body = JSON.parse(other.raw) as {
					state?: { ownerLive?: boolean };
					evidence?: { readOnly?: boolean; ownerRouted?: boolean };
				};
				expect(other.code).toBe(0);
				expect(body.state?.ownerLive).toBe(false);
				expect(body.evidence?.readOnly).toBe(true);
				expect(body.evidence?.ownerRouted).toBeUndefined();
				const saved = process.env.GJC_HARNESS_SOCKET_DIR;
				process.env.GJC_HARNESS_SOCKET_DIR = otherDir;
				try {
					const resolved = await resolveOwner(root, SID);
					expect(resolved.live).toBe(true);
					expect(resolved.socketPath).toBeNull();
				} finally {
					if (saved === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
					else process.env.GJC_HARNESS_SOCKET_DIR = saved;
				}
				await expect(
					acquireLease(root, SID, {
						ownerId: "owner-other",
						pid: process.pid,
						eventsPath: sessionPaths(root, SID).events,
						endpoint: {
							kind: "unix-socket",
							path: controlSocketPath(root, SID, { GJC_HARNESS_SOCKET_DIR: otherDir }),
						},
						ttlMs: 10_000,
					}),
				).rejects.toThrow(/lease_held/);
				expect((await readLease(root, SID))?.ownerId).toBe("owner-planted");
			} finally {
				await server.close();
			}
		},
		20_000,
	);

	it("never trusts a socket record on windows", async () => {
		const mod = await import("../../src/harness-control-plane/session-lease");
		const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
		const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
		extraDirs.push(socketDir, otherDir);
		await withSocketEnv({ GJC_HARNESS_SOCKET_DIR: socketDir }, async () => {
			const lease = await readLease(root, SID);
			const endpoint = lease?.endpoint?.path;
			expect(endpoint).toBeTruthy();
			process.env.GJC_HARNESS_SOCKET_DIR = otherDir;
			if (process.platform !== "win32") {
				expect(mod.canonicalLeaseSocket(root, SID, endpoint!, lease)).toBe(endpoint!);
			}
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			try {
				expect(mod.ownerSocketRecordPath(root, SID)).toBeNull();
				expect(mod.canonicalLeaseSocket(root, SID, endpoint!, lease)).toBeNull();
			} finally {
				Object.defineProperty(process, "platform", platform);
			}
		});
	});

	it.skipIf(process.platform === "win32")(
		"does not route or take over through a world-writable socket record directory",
		async () => {
			await expectUntrustedRecordIgnored((dir, file) => {
				fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
				fsSync.chmodSync(dir, 0o777);
				fsSync.writeFileSync(file, forgedRecord(path.join(root, "attacker.sock")), { mode: 0o600 });
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"does not route or take over through an oversized socket record",
		async () => {
			await expectUntrustedRecordIgnored((dir, file) => {
				fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
				fsSync.chmodSync(dir, 0o700);
				fsSync.writeFileSync(file, "x".repeat(2048), { mode: 0o600 });
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"does not route or take over through a symlinked socket record directory",
		async () => {
			const real = await mkdtemp(path.join(tmpdir(), "hsn-"));
			extraDirs.push(real);
			await expectUntrustedRecordIgnored((dir, file) => {
				fsSync.rmSync(dir, { recursive: true, force: true });
				fsSync.symlinkSync(real, dir);
				fsSync.writeFileSync(path.join(real, path.basename(file)), forgedRecord(path.join(root, "attacker.sock")), {
					mode: 0o600,
				});
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"does not route or take over through a symlinked socket record",
		async () => {
			await expectUntrustedRecordIgnored((dir, file) => {
				fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
				fsSync.chmodSync(dir, 0o700);
				const planted = path.join(root, "forged-record.json");
				fsSync.writeFileSync(planted, forgedRecord(path.join(root, "attacker.sock")), { mode: 0o600 });
				fsSync.symlinkSync(planted, file);
			});
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"does not follow a pre-planted socket record temp symlink",
		async () => {
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			const otherDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir, otherDir);
			const savedSocket = process.env.GJC_HARNESS_SOCKET_DIR;
			process.env.GJC_HARNESS_SOCKET_DIR = socketDir;
			const secret = path.join(root, "record-secret.txt");
			fsSync.writeFileSync(secret, "secret-bytes", { mode: 0o600 });
			const owner = new RuntimeOwner({
				root,
				sessionId: SID,
				transport: new IdleTransport(),
				heartbeatMs: 60_000,
			});
			try {
				const file = await recordPath();
				expect(file).toBeTruthy();
				fsSync.mkdirSync(path.dirname(file!), { recursive: true, mode: 0o700 });
				fsSync.chmodSync(path.dirname(file!), 0o700);
				fsSync.symlinkSync(secret, `${file}.tmp-${process.pid}`);
				await owner.start();
				expect(fsSync.readFileSync(secret, "utf8")).toBe("secret-bytes");
				expect(fsSync.lstatSync(secret).isFile()).toBe(true);
				process.env.GJC_HARNESS_SOCKET_DIR = otherDir;
				const owner2 = new RuntimeOwner({
					root,
					sessionId: SID,
					transport: new IdleTransport(),
					heartbeatMs: 60_000,
				});
				await expect(owner2.start()).rejects.toThrow(/lease_held/);
				expect((await readLease(root, SID))?.ownerId).toBe(owner.ownerId);
			} finally {
				await owner.stop();
				const file = await recordPath();
				if (file) fsSync.rmSync(path.dirname(file), { recursive: true, force: true });
				if (savedSocket === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
				else process.env.GJC_HARNESS_SOCKET_DIR = savedSocket;
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"does not block on a fifo socket record",
		async () => {
			const file = await recordPath();
			if (!file) throw new Error("missing socket record path");
			const dir = path.dirname(file);
			fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fsSync.chmodSync(dir, 0o700);
			execFileSync("mkfifo", [file]);
			const foreign = path.join(root, "attacker.sock");
			const server = await listen(foreign, FORGED);
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir);
			const saved = process.env.GJC_HARNESS_SOCKET_DIR;
			const owner = new RuntimeOwner({
				root,
				sessionId: SID,
				transport: new IdleTransport(),
				heartbeatMs: 60_000,
			});
			try {
				await plantLease(foreign);
				const promptFile = path.join(root, "prompt.txt");
				await writeFile(promptFile, SECRET, "utf8");
				const res = await runHarness(["submit", "--session", SID, "--prompt-file", promptFile, "--input", "{}"]);
				expect(server.received).toHaveLength(0);
				expect(res.raw).not.toContain(FORGED);
				fsSync.rmSync(sessionPaths(root, SID).lease, { force: true });
				fsSync.rmSync(file, { force: true });
				process.env.GJC_HARNESS_SOCKET_DIR = socketDir;
				await owner.start();
				fsSync.rmSync(file, { force: true });
				execFileSync("mkfifo", [file]);
				await owner.stop();
			} finally {
				await server.close();
				await owner.stop().catch(() => {});
				fsSync.rmSync(dir, { recursive: true, force: true });
				if (saved === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
				else process.env.GJC_HARNESS_SOCKET_DIR = saved;
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"does not route through a directory placed at the socket record",
		async () => {
			const file = await recordPath();
			expect(file).toBeTruthy();
			const dir = path.dirname(file!);
			fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fsSync.chmodSync(dir, 0o700);
			fsSync.mkdirSync(file!, { mode: 0o700 });
			const foreign = path.join(root, "attacker.sock");
			const server = await listen(foreign, FORGED);
			try {
				await plantLease(foreign);
				const promptFile = path.join(root, "prompt.txt");
				await writeFile(promptFile, SECRET, "utf8");
				const res = await runHarness(["submit", "--session", SID, "--prompt-file", promptFile, "--input", "{}"]);
				expect(server.received).toHaveLength(0);
				expect(res.raw).not.toContain(FORGED);
			} finally {
				await server.close();
				fsSync.rmSync(dir, { recursive: true, force: true });
			}
		},
		20_000,
	);

	it.skipIf(process.platform === "win32" || !canSymlink)(
		"rejects a socket record when its directory is replaced before open",
		async () => {
			const mod = await import("../../src/harness-control-plane/session-lease");
			const file = await recordPath();
			expect(file).toBeTruthy();
			const dir = path.dirname(file!);
			fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fsSync.chmodSync(dir, 0o700);
			const swapped = await mkdtemp(path.join(tmpdir(), "hsn-"));
			extraDirs.push(swapped);
			fsSync.chmodSync(swapped, 0o700);
			const foreign = path.join(root, "attacker.sock");
			const sentinel = path.join(root, "swap-sentinel.txt");
			fsSync.writeFileSync(sentinel, "keep", { mode: 0o600 });
			fsSync.writeFileSync(path.join(swapped, "record.json"), forgedRecord(foreign), { mode: 0o600 });
			fsSync.symlinkSync(sentinel, path.join(swapped, `record.json.tmp-${process.pid}`));
			const server = await listen(foreign, FORGED);
			const socketDir = await mkdtemp(path.join(tmpdir(), "hsd-"));
			extraDirs.push(socketDir);
			const saved = process.env.GJC_HARNESS_SOCKET_DIR;
			process.env.GJC_HARNESS_SOCKET_DIR = socketDir;
			mod.setOwnerSocketRecordAfterDirCheck(() => {
				fsSync.rmSync(dir, { recursive: true, force: true });
				fsSync.symlinkSync(swapped, dir);
			});
			const owner = new RuntimeOwner({
				root,
				sessionId: SID,
				transport: new IdleTransport(),
				heartbeatMs: 60_000,
			});
			try {
				await plantLease(foreign);
				expect((await resolveOwner(root, SID)).socketPath).toBeNull();
				expect(fsSync.readFileSync(sentinel, "utf8")).toBe("keep");
				fsSync.rmSync(sessionPaths(root, SID).lease, { force: true });
				fsSync.rmSync(dir, { force: true });
				fsSync.mkdirSync(dir, { mode: 0o700 });
				await owner.start();
				expect(fsSync.readFileSync(sentinel, "utf8")).toBe("keep");
				expect((await readLease(root, SID))?.ownerId).toBe(owner.ownerId);
			} finally {
				mod.setOwnerSocketRecordAfterDirCheck(null);
				await owner.stop().catch(() => {});
				fsSync.rmSync(dir, { recursive: true, force: true });
				await server.close();
				if (saved === undefined) delete process.env.GJC_HARNESS_SOCKET_DIR;
				else process.env.GJC_HARNESS_SOCKET_DIR = saved;
			}
		},
		20_000,
	);

	it("property owner socket record text", async () => {
		const mod = await import("../../src/harness-control-plane/session-lease");
		const parse = mod.recordFromText;
		expect(typeof parse).toBe("function");
		const token = fc.string({ minLength: 1, maxLength: 40 }).filter(value => value.length > 0);
		const nonce = fc
			.array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
			.map(digits => digits.map(digit => digit.toString(16)).join(""));
		fc.assert(
			fc.property(
				fc.record({
					socketPath: token,
					pid: fc.integer({ min: 1, max: 1_000_000 }),
					ownerId: token,
					leaseEpoch: fc.integer({ min: 0, max: 10_000 }),
					nonce,
				}),
				fc.string(),
				(row, junk) => {
					const text = JSON.stringify(row);
					expect(parse(text)).toEqual(row);
					expect(parse(`x${junk}`)).toBeNull();
					expect(parse(`${text}}`)).toBeNull();
					expect(parse(JSON.stringify({ ...row, pid: String(row.pid) }))).toBeNull();
					expect(parse(JSON.stringify({ ...row, nonce: "ab" }))).toBeNull();
					return true;
				},
			),
			{ seed: 618, numRuns: 64 },
		);
	});

	it("property owner socket lexical identity", async () => {
		const mod = await import("../../src/harness-control-plane/session-lease");
		const classify = mod.classifyOwnerSocketLexical;
		expect(typeof classify).toBe("function");
		const segment = fc.string({ minLength: 1, maxLength: 12 }).filter(value => /^[A-Za-z0-9_-]+$/.test(value));
		fc.assert(
			fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), segment, (parts, name) => {
				const canonical = path.join(path.sep, ...parts, name);
				const dotted = `${canonical}${path.sep}.${path.sep}..${path.sep}${path.basename(canonical)}`;
				const trailed = `${canonical}${path.sep}`;
				expect(classify(canonical, canonical)).toBe("match");
				expect(classify(dotted, canonical)).toBe("match");
				expect(classify(trailed, canonical)).toBe("match");
				expect(classify(`${canonical}x`, canonical)).toBe("mismatch");
				expect(classify(` ${canonical}`, canonical)).toBe("mismatch");
				expect(classify(`${canonical} `, canonical)).toBe("mismatch");
				expect(classify("", canonical)).toBe("mismatch");
				expect(classify(`${canonical}\0`, canonical)).toBe("mismatch");
				expect(classify(`${canonical}\\extra`, canonical)).toBe("mismatch");
				expect(classify(dotted, canonical)).toBe(classify(path.resolve(dotted), canonical));
				return true;
			}),
			{ seed: 618, numRuns: 64 },
		);
	});
});
