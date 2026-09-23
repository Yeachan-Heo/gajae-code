import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "../src/config/file-lock";
import { type KevProcessIdentity, type KevSetupDeps, runKevSetup } from "../src/setup/kev-setup";
import {
	controlRequest,
	controlSocketPathIsBindable,
	KEV_SERVICE_SHIM_SOURCE,
	KEV_SUPERVISOR_SOURCE,
	type KevControlReply,
	kevControl,
} from "../src/setup/kev-supervisor";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = /^[a-f0-9]{64}$/u;
const roots: string[] = [];
const spawnedPids: number[] = [];
afterEach(async () => {
	// Only pids this file spawned are ever signaled here.
	for (const pid of spawnedPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** Shared-checkout isolation: only this window may be bound by these tests. */
const PORT_BASE = Number(process.env.PORT_BASE ?? 42040);
const PORT_LIMIT = PORT_BASE + 20;

/** The same predicate the setup code uses to decide whether a service still holds its port. */
function loopbackPortIsFree(port: number): boolean {
	try {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: {
				data() {},
				open(socket) {
					socket.end();
				},
			},
		});
		server.stop(true);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
		throw error;
	}
}

function reservedLoopbackPort(): number | undefined {
	for (let port = PORT_BASE; port < PORT_LIMIT; port++) if (loopbackPortIsFree(port)) return port;
	return undefined;
}

async function until(predicate: () => boolean | Promise<boolean>, attempts = 240): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await predicate()) return true;
		await Bun.sleep(25);
	}
	return false;
}

function processIsGone(pid: number): boolean {
	try {
		nativeKill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

const nativeKill = process.kill.bind(process);
type SignalCall = [number, string | number | undefined];

/**
 * Record every signal attempt and deliver none. These tests assert that the stop
 * path signals nothing, so a regression must be caught rather than delivered to
 * whatever process currently holds a fixture pid. Liveness probes still pass
 * through so the lock owner check keeps working.
 *
 * The binding is replaced directly because `spyOn(process, "kill")` does not
 * intercept it under Bun — a spy here would silently assert nothing.
 */
function captureSignals(): { calls: SignalCall[]; restore: () => void } {
	const calls: SignalCall[] = [];
	const original = process.kill;
	process.kill = ((pid: number, signal?: string | number) => {
		calls.push([pid, signal]);
		return signal === 0 ? nativeKill(pid, signal) : true;
	}) as typeof process.kill;
	return {
		calls,
		restore: () => {
			process.kill = original;
		},
	};
}

/** Signals other than the liveness probe used by the lock owner check. */
function realSignals(capture: { calls: SignalCall[] }): SignalCall[] {
	return capture.calls.filter(([, signal]) => signal !== 0);
}

async function fixture() {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kev-test-"));
	roots.push(base);
	const root = path.join(base, "installation");
	const stateDir = path.join(base, "agent-state");
	const snapshot = path.join(base, "snapshot");
	await fs.mkdir(snapshot);
	await Bun.write(path.join(snapshot, "head.pt"), "unit-test fixture, not a trained model");
	const calls: Array<{ argv: string[]; cwd: string }> = [];
	const processes = new Map<number, KevProcessIdentity>();
	const spawned: string[][] = [];
	const killedHandles: number[] = [];
	const control: Array<{ socket: string; request: Record<string, unknown> }> = [];
	/** Stand-in for the real Python supervisor: only a matching token moves its child. */
	const supervisor = {
		pid: undefined as number | undefined,
		token: undefined as string | undefined,
		servicePid: 4242,
		running: false,
		answers: true,
		acceptsToken: true,
	};
	const deps: KevSetupDeps = {
		stateDir,
		run: async (argv, options) => {
			expect((await fs.stat(options.cwd)).isDirectory()).toBe(true);
			calls.push({ argv: [...argv], cwd: options.cwd });
			if (argv[0] === "git" && argv[1] === "clone") await fs.mkdir(path.join(root, "repo"), { recursive: true });
			if (argv[0] === "uv" && argv[1] === "sync")
				await fs.mkdir(path.join(root, "repo", ".venv"), { recursive: true });
			let stdout = "";
			if (argv[1] === "remote") stdout = "https://github.com/jaredpalmer/kev.git";
			if (argv[1] === "rev-parse") stdout = REVISION;
			if (argv[2]?.includes("snapshot_download")) stdout = snapshot;
			return { exitCode: 0, stdout, stderr: "" };
		},
		spawn: (argv, options) => {
			const pid = 42 + spawned.length;
			spawned.push([...argv]);
			processes.set(pid, { command: argv.join(" "), incarnation: "Fri Oct 2 12:34:56 2026" });
			supervisor.pid = pid;
			supervisor.token = options.token;
			supervisor.running = true;
			return {
				pid,
				unref() {},
				kill() {
					killedHandles.push(pid);
					processes.delete(pid);
					supervisor.running = false;
				},
			};
		},
		inspect: pid => processes.get(pid),
		control: async (socketPath, message): Promise<KevControlReply | undefined> => {
			const request = JSON.parse(message.trim()) as Record<string, unknown>;
			control.push({ socket: socketPath, request });
			if (!supervisor.answers || !supervisor.running) return undefined;
			if (!supervisor.acceptsToken || request.token !== supervisor.token) return { ok: false, error: "refused" };
			if (request.op === "status") return { ok: true, pid: supervisor.servicePid, state: "running" };
			if (request.op !== "stop") return { ok: false, error: "unsupported" };
			supervisor.running = false;
			if (supervisor.pid !== undefined) processes.delete(supervisor.pid);
			return { ok: true, exit: 0 };
		},
		portAvailable: () => true,
		listens: () => true,
		health: async () => true,
		sleep: async () => {},
		readyTimeoutMs: 1,
		stopTimeoutMs: 1,
	};
	return { root, base, stateDir, snapshot, calls, processes, spawned, killedHandles, control, supervisor, deps };
}

async function privateJson(file: string, value: unknown): Promise<void> {
	await Bun.write(file, JSON.stringify(value));
	await fs.chmod(file, 0o600);
}

function stopRequests(control: Array<{ socket: string; request: Record<string, unknown> }>) {
	return control.filter(call => call.request.op === "stop");
}

describe("Kev lifecycle", () => {
	test("installs from existing working directories, verifies revision, and remembers a custom root/model", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root, model: "example/kev-fixture" }, f.deps);
		const clone = f.calls.findIndex(call => call.argv[0] === "git" && call.argv[1] === "clone");
		const sync = f.calls.findIndex(call => call.argv[0] === "uv" && call.argv[1] === "sync");
		const download = f.calls.findIndex(call => call.argv[2]?.includes("snapshot_download"));
		expect(clone).toBeGreaterThan(-1);
		expect(sync).toBeGreaterThan(clone);
		expect(download).toBeGreaterThan(sync);
		expect(f.calls[download]?.argv.at(-1)).toBe("example/kev-fixture");
		expect(await runKevSetup("status", {}, f.deps)).toMatchObject({
			state: "stopped",
			root: f.root,
			model: "example/kev-fixture",
		});
		expect((await fs.stat(path.join(f.root, "install.json"))).mode & 0o777).toBe(0o600);
	});

	test("starts a supervised checkpoint and stops it through its authenticated control channel", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		expect(await runKevSetup("start", {}, f.deps)).toMatchObject({ state: "running", pid: 42 });
		expect(f.spawned[0]).toContain(f.snapshot);
		expect(f.spawned[0]).toContain("--fallback");
		expect(f.spawned[0]?.some(arg => arg.startsWith("gjc_kev_owner="))).toBe(true);
		expect(f.spawned[0]).toContain(path.join(f.root, "supervisor.py"));
		expect(f.spawned[0]).toContain(path.join(f.root, "control.sock"));
		// The token is never an argument: it reaches the supervisor only on stdin.
		expect(f.supervisor.token).toMatch(TOKEN);
		expect(f.spawned[0]?.some(arg => arg.includes(f.supervisor.token!))).toBe(false);
		const record = await Bun.file(path.join(f.root, "server.json")).json();
		expect(record).toMatchObject({ version: 2, socket: path.join(f.root, "control.sock") });
		expect(record.token).toBe(f.supervisor.token);
		expect((await fs.stat(path.join(f.root, "server.json"))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.join(f.root, "supervisor.py"))).mode & 0o777).toBe(0o600);
		await runKevSetup("start", {}, f.deps);
		expect(f.spawned).toHaveLength(1);
		const kills = captureSignals();
		try {
			expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopped" });
			await runKevSetup("stop", {}, f.deps);
		} finally {
			kills.restore();
		}
		expect(realSignals(kills)).toEqual([]);
		expect(stopRequests(f.control)).toEqual([
			{ socket: path.join(f.root, "control.sock"), request: { op: "stop", token: f.supervisor.token } },
		]);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(false);
	});

	test("a pid reused between the ownership check and the stop is never signaled", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		// The recorded pid is a real, unrelated process this test owns. Any signal the
		// stop path sends to it is therefore observable as that process dying, with no
		// reliance on intercepting a call.
		const bystander = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
		spawnedPids.push(bystander.pid);
		const supervisorPid = bystander.pid;
		const file = path.join(f.root, "server.json");
		const owned = { ...((await Bun.file(file).json()) as Record<string, unknown>), pid: supervisorPid };
		await privateJson(file, owned);
		f.supervisor.pid = supervisorPid;
		f.processes.set(supervisorPid, f.processes.get(42)!);
		const reused: KevProcessIdentity = {
			command: "/usr/bin/unrelated-user-work --important",
			incarnation: "Sat Oct 3 09:00:00 2026",
		};
		// Ownership is proven, then — deterministically, at the instant the stop is
		// issued and before it acts — the kernel hands that exact pid to an unrelated
		// process. A bare `process.kill(record.pid, "SIGTERM")` would signal the new
		// owner in this window; the control channel cannot, because it never resolves
		// a pid at all.
		let ownershipChecks = 0;
		let reusedNow = false;
		f.deps.inspect = pid => {
			if (pid !== supervisorPid) return f.processes.get(pid);
			if (reusedNow) return reused;
			ownershipChecks++;
			return f.processes.get(pid);
		};
		const answer = f.deps.control!;
		f.deps.control = async (socketPath, message) => {
			if ((JSON.parse(message.trim()) as { op?: string }).op === "stop") reusedNow = true;
			return answer(socketPath, message);
		};
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopped" });
		// The process now holding the recorded pid is untouched.
		expect(
			await Promise.race([
				bystander.exited.then(() => "signaled" as const),
				Bun.sleep(400).then(() => "alive" as const),
			]),
		).toBe("alive");
		// The stop carried only an operation and the recorded token — no pid field
		// exists on this path for a reused pid to leak into.
		expect(stopRequests(f.control)).toEqual([
			{ socket: path.join(f.root, "control.sock"), request: { op: "stop", token: f.supervisor.token } },
		]);
		expect("kill" in f.deps).toBe(false);
		// Ownership was proven (status, then the pre-stop recheck) before the flip.
		expect(ownershipChecks).toBe(2);
		expect(reusedNow).toBe(true);
		expect(f.deps.inspect!(supervisorPid)).toBe(reused);
	});

	test("a supervisor that refuses the token keeps its child and its ownership record", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		f.supervisor.acceptsToken = false;
		const kills = captureSignals();
		try {
			expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopping" });
		} finally {
			kills.restore();
		}
		expect(realSignals(kills)).toEqual([]);
		expect(f.supervisor.running).toBe(true);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(true);
	});

	test("forged ownership metadata cannot authorize a stop", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await privateJson(path.join(f.root, "server.json"), { version: 2, pid: 42, argv: [] });
		f.processes.set(42, { command: "unrelated-user-work", incarnation: "now" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(f.control).toEqual([]);
	});

	test("a version-1 record is not ours and is never stopped through it", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		const file = path.join(f.root, "server.json");
		const record = await Bun.file(file).json();
		await privateJson(file, { ...record, version: 1 });
		expect(await runKevSetup("status", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(stopRequests(f.control)).toEqual([]);
	});

	test("a record naming a different control socket is foreign and is never sent the token", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		const file = path.join(f.root, "server.json");
		const record = (await Bun.file(file).json()) as Record<string, unknown>;
		const before = f.control.length;
		// Schema-valid and otherwise identical: only the socket is redirected.
		await privateJson(file, { ...record, socket: path.join(f.base, "attacker.sock") });
		expect(await runKevSetup("status", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(f.control.slice(before)).toEqual([]);
	});

	test("PID reuse with identical command text but a different incarnation fails closed", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		f.processes.set(42, { command: f.spawned[0]!.join(" "), incarnation: "a-new-process" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "foreign" });
		expect(stopRequests(f.control)).toEqual([]);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(true);
	});

	test("occupied ports reject startup without spawning or signaling", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		f.deps.portAvailable = () => false;
		await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow("occupied");
		expect(f.spawned).toEqual([]);
		expect(f.control).toEqual([]);
	});

	test("does not truncate a symlinked foreign log", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const foreign = path.join(f.base, "foreign.txt");
		await Bun.write(foreign, "preserve me");
		await fs.symlink(foreign, path.join(f.root, "server.log"));
		await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow();
		expect(await Bun.file(foreign).text()).toBe("preserve me");
		expect(f.spawned).toEqual([]);
	});

	test("does not truncate a hard-linked foreign log", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const foreign = path.join(f.base, "foreign-hardlink.txt");
		await Bun.write(foreign, "preserve me");
		await fs.chmod(foreign, 0o644);
		// O_NOFOLLOW refuses symlinks but not a second link to the same inode.
		await fs.link(foreign, path.join(f.root, "server.log"));
		await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow("Unsafe Kev log file");
		expect(await Bun.file(foreign).text()).toBe("preserve me");
		expect((await fs.stat(foreign)).mode & 0o777).toBe(0o644);
		expect(f.spawned).toEqual([]);
	});

	test("refuses revision drift before starting a process", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const run = f.deps.run!;
		f.deps.run = (argv, options) =>
			argv[1] === "rev-parse"
				? Promise.resolve({ exitCode: 0, stdout: "f".repeat(40), stderr: "" })
				: run(argv, options);
		await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow("revision mismatch");
		expect(f.spawned).toEqual([]);
	});

	test("readiness follows the supervised child's listener, not the supervisor pid", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const listened: number[] = [];
		f.deps.listens = pid => {
			listened.push(pid);
			return pid === f.supervisor.servicePid;
		};
		expect(await runKevSetup("start", {}, f.deps)).toMatchObject({ state: "running", pid: 42 });
		expect(listened).toContain(f.supervisor.servicePid);
		expect(listened).not.toContain(42);
	});

	test("reports loading honestly and can stop an owned not-yet-ready process", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		f.deps.listens = () => false;
		expect(await runKevSetup("start", {}, f.deps)).toMatchObject({ state: "starting" });
		expect(await runKevSetup("status", {}, f.deps)).toMatchObject({ state: "starting" });
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopped" });
	});

	test("retains ownership when the supervisor does not answer its control socket", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		f.deps.control = async () => undefined;
		const kills = captureSignals();
		try {
			expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopping" });
		} finally {
			kills.restore();
		}
		expect(realSignals(kills)).toEqual([]);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(true);
	});

	test("a dead supervisor whose port still has a listener is orphaned, not stopped", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		f.processes.delete(f.supervisor.pid!);
		// The supervisor is gone but its child still holds the port.
		f.deps.portAvailable = () => false;
		const kills = captureSignals();
		try {
			expect(await runKevSetup("status", {}, f.deps)).toMatchObject({ ok: false, state: "orphaned" });
			expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ ok: false, state: "orphaned" });
		} finally {
			kills.restore();
		}
		expect(realSignals(kills)).toEqual([]);
		expect(stopRequests(f.control)).toEqual([]);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(true);
	});

	test("a dead supervisor retires the record only once the port is free", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		f.processes.delete(f.supervisor.pid!);
		const kills = captureSignals();
		try {
			expect(await runKevSetup("status", {}, f.deps)).toMatchObject({ state: "stale" });
			expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ ok: true, state: "stopped" });
		} finally {
			kills.restore();
		}
		expect(realSignals(kills)).toEqual([]);
		expect(stopRequests(f.control)).toEqual([]);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(false);
	});

	test("a live service outranks missing installation metadata and is stopped through its token", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		await runKevSetup("start", {}, f.deps);
		await fs.rm(path.join(f.root, "install.json"));
		// Never `not-installed`: that reads as "nothing to do" for a running server.
		expect(await runKevSetup("status", {}, f.deps)).toMatchObject({ ok: false, state: "orphaned", pid: 42 });
		f.supervisor.acceptsToken = false;
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ ok: false, state: "stopping" });
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(true);
		expect(f.supervisor.running).toBe(true);
		f.supervisor.acceptsToken = true;
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ ok: true, state: "stopped" });
		expect(stopRequests(f.control)).toHaveLength(2);
		expect(stopRequests(f.control).every(call => call.socket === path.join(f.root, "control.sock"))).toBe(true);
		expect(await Bun.file(path.join(f.root, "server.json")).exists()).toBe(false);
	});
});

describe("Kev lifecycle lock", () => {
	test("recovers a lock abandoned by a crashed owner", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const lock = path.join(f.root, ".lifecycle");
		const holder = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { acquireFileLock } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/config/file-lock.ts"))});
				 await acquireFileLock(${JSON.stringify(lock)}, { retries: 3, retryDelayMs: 50 });
				 console.log("held");
				 await new Promise(() => {});`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		spawnedPids.push(holder.pid);
		const reader = holder.stdout.getReader();
		const held = await reader.read();
		expect(new TextDecoder().decode(held.value)).toContain("held");
		await reader.cancel().catch(() => undefined);
		expect((await fs.lstat(`${lock}.lock`)).isDirectory()).toBe(true);
		// Crash the owner mid-critical-section: the lock directory survives with a
		// real owner record naming a pid that is now dead.
		holder.kill("SIGKILL");
		await holder.exited;
		expect(await runKevSetup("stop", {}, f.deps)).toMatchObject({ state: "stopped" });
	}, 20_000);

	test("refuses to steal a lock held by a live owner", async () => {
		const f = await fixture();
		await runKevSetup("install", { root: f.root }, f.deps);
		const release = await acquireFileLock(path.join(f.root, ".lifecycle"), { retries: 3, retryDelayMs: 50 });
		try {
			await expect(runKevSetup("stop", {}, f.deps)).rejects.toThrow("Kev lifecycle is busy");
			await expect(runKevSetup("start", {}, f.deps)).rejects.toThrow("Kev lifecycle is busy");
			expect(f.spawned).toEqual([]);
			// The live owner still holds the exact lock it acquired.
			expect((await fs.lstat(path.join(f.root, ".lifecycle.lock"))).isDirectory()).toBe(true);
		} finally {
			await release();
		}
	}, 20_000);
});

const python = Bun.which("python3");

describe.skipIf(!python)("Kev supervisor process", () => {
	test("a SIGKILLed supervisor takes its server down and frees the port", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kev-crash-"));
		roots.push(base);
		await fs.chmod(base, 0o700);
		const supervisorScript = path.join(base, "supervisor.py");
		const shim = path.join(base, "kev-service.py");
		await Bun.write(supervisorScript, KEV_SUPERVISOR_SOURCE);
		await Bun.write(shim, KEV_SERVICE_SHIM_SOURCE);
		await fs.chmod(supervisorScript, 0o600);
		await fs.chmod(shim, 0o600);
		const socketPath = path.join(base, "control.sock");
		expect(controlSocketPathIsBindable(socketPath)).toBe(true);
		const port = reservedLoopbackPort();
		expect(port).toBeDefined();

		const token = "c".repeat(64);
		// `http.server` stands in for `kev.serve`: a runpy-able module that holds a
		// loopback port, started through the same shim the real service uses.
		const supervisor = Bun.spawn(
			[
				python!,
				supervisorScript,
				"--socket",
				socketPath,
				"--",
				python!,
				shim,
				"--",
				"http.server",
				String(port),
				"--bind",
				"127.0.0.1",
			],
			{ cwd: base, stdin: "pipe", stdout: "ignore", stderr: "pipe" },
		);
		spawnedPids.push(supervisor.pid);
		supervisor.stdin.write(`${token}\n`);
		supervisor.stdin.end();

		expect(await until(() => pathExists(socketPath))).toBe(true);
		const started = await kevControl(socketPath, controlRequest("status", token));
		expect(started).toMatchObject({ ok: true, state: "running" });
		const servicePid = started!.pid!;
		spawnedPids.push(servicePid);
		expect(await until(() => !loopbackPortIsFree(port!))).toBe(true);

		// SIGKILL: the supervisor runs no shutdown code at all. Only the inherited
		// pipe closing can tell the server that nothing is left to stop it.
		nativeKill(supervisor.pid, "SIGKILL");
		await supervisor.exited;

		expect(await until(() => processIsGone(servicePid))).toBe(true);
		expect(await until(() => loopbackPortIsFree(port!))).toBe(true);
	}, 60_000);

	test("refuses a wrong token, then stops its child for the right one", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kev-sup-"));
		roots.push(base);
		await fs.chmod(base, 0o700);
		const script = path.join(base, "supervisor.py");
		await Bun.write(script, KEV_SUPERVISOR_SOURCE);
		await fs.chmod(script, 0o600);
		const socketPath = path.join(base, "control.sock");
		expect(controlSocketPathIsBindable(socketPath)).toBe(true);

		const token = "a".repeat(64);
		const supervisor = Bun.spawn(
			[python!, script, "--socket", socketPath, "--", python!, "-c", "import time; time.sleep(60)"],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		spawnedPids.push(supervisor.pid);
		supervisor.stdin.write(`${token}\n`);
		supervisor.stdin.end();

		for (let attempt = 0; attempt < 200; attempt++) {
			if (await pathExists(socketPath)) break;
			await Bun.sleep(25);
		}
		expect((await fs.lstat(socketPath)).mode & 0o777).toBe(0o600);

		const started = await kevControl(socketPath, controlRequest("status", token));
		expect(started).toMatchObject({ ok: true, state: "running" });
		const servicePid = started!.pid!;
		spawnedPids.push(servicePid);

		const refused = await kevControl(socketPath, controlRequest("stop", "b".repeat(64)));
		expect(refused).toEqual({ ok: false, error: "refused" });
		await Bun.sleep(250);
		expect(await kevControl(socketPath, controlRequest("status", token))).toMatchObject({
			ok: true,
			pid: servicePid,
			state: "running",
		});

		const stopped = await kevControl(socketPath, controlRequest("stop", token));
		expect(stopped?.ok).toBe(true);
		expect(await supervisor.exited).toBe(0);
		expect(await pathExists(socketPath)).toBe(false);
		expect(() => process.kill(servicePid, 0)).toThrow();
	}, 30_000);
});
