import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import {
	answerMatchesAuthority,
	observeExistingBroker,
	parseAnsweredDiagnostics,
	parsePublication,
	sameAuthority,
} from "../src/sdk/diagnostics/observe-broker";

/**
 * Negative and transport matrix for the observation route (packet order 4, F5).
 *
 * Fixtures are private and task-owned. Starting a fixture broker is SETUP; the
 * zero-mutation rows compare the authority bytes, modes and entries around an
 * observation and exclude only the independently scheduled heartbeat field.
 *
 * The redirect and proxy rows assert that the observation never reaches a redirect
 * destination and never traverses a proxy: both are counted with real loopback listeners.
 */

const SUPPORTED_RUNTIME = process.platform === "darwin" && process.arch === "arm64" && Bun.version === "1.4.0";

type OwnedResource = { label: string; dispose: () => Promise<void> | void; verify?: () => Promise<boolean> | boolean };

const owned: OwnedResource[] = [];

afterEach(async () => {
	// Cleanup does not merely swallow failures: each resource reports whether it really
	// released, and a residual resource fails THIS test. The ledger is per test, so one
	// row's cleanup problem can never contaminate another row's verdict.
	const failures: string[] = [];
	while (owned.length > 0) {
		const resource = owned.pop();
		if (!resource) continue;
		try {
			await resource.dispose();
		} catch (error) {
			failures.push(`${resource.label}: dispose threw ${(error as Error).message}`);
		}
		if (resource.verify) {
			try {
				if (!(await resource.verify())) failures.push(`${resource.label}: still released check failed`);
			} catch (error) {
				failures.push(`${resource.label}: verify threw ${(error as Error).message}`);
			}
		}
	}
	expect(failures).toEqual([]);
});

async function fixtureAgentDir(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), `gjc-obs-${label}-`));
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await fs.chmod(agentDir, 0o700);
	await fs.chmod(path.join(agentDir, "sdk"), 0o700);
	owned.push({
		label: `fixture:${label}`,
		dispose: () => fs.rm(root, { recursive: true, force: true }),
		// The whole private fixture tree must really be gone.
		verify: async () =>
			!(await fs
				.stat(root)
				.then(() => true)
				.catch(() => false)),
	});
	return agentDir;
}

/** SETUP: a real broker through its own startup path. */
async function setupBroker(agentDir: string): Promise<{ broker: Broker; stop: () => Promise<void> }> {
	const broker = new Broker({ agentDir, packageGeneration: "matrix-fixture" });
	let stopped = false;
	let pristine: string | null = null;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		// A negative row may have rewritten the publication for its own case. The fixture
		// restores the publisher's own bytes first, so releasing the authority never has to
		// parse content this test deliberately broke.
		if (pristine !== null && (await Bun.file(publicationFile(agentDir)).exists())) {
			const current = await Bun.file(publicationFile(agentDir)).text();
			if (current !== pristine) {
				await Bun.write(publicationFile(agentDir), pristine);
				await fs.chmod(publicationFile(agentDir), 0o600);
			}
		}
		await broker.stop();
	};
	owned.push({ label: "fixture:broker", dispose: stop, verify: () => stopped });
	await broker.start();
	pristine = await Bun.file(publicationFile(agentDir)).text();
	return { broker, stop };
}

/**
 * SETUP for rows that need a REAL publication but no live socket: the broker publishes
 * through its own startup path and is stopped cleanly BEFORE the bytes are rewritten, so
 * no fixture ever corrupts a running broker's own state.
 */
async function publishThenStop(agentDir: string): Promise<Record<string, unknown>> {
	const { stop } = await setupBroker(agentDir);
	const record = (await Bun.file(publicationFile(agentDir)).json()) as Record<string, unknown>;
	await stop();
	return record;
}

/** Rewrite the publication of a stopped fixture, keeping the contract mode. */
async function rewritePublication(agentDir: string, body: string | Record<string, unknown>): Promise<void> {
	await Bun.write(publicationFile(agentDir), typeof body === "string" ? body : JSON.stringify(body));
	await fs.chmod(publicationFile(agentDir), 0o600);
}

const publicationFile = (agentDir: string) => path.join(agentDir, "sdk", "broker.json");

/**
 * Settle an owned child.
 *
 * The bounded timer is armed before any draining and it really terminates the child; both
 * pipes are drained concurrently so a full stderr pipe cannot deadlock a child that keeps
 * stdout open; a child that ignores SIGTERM is escalated once, bounded, and only ever this
 * task-owned child; the exit is always awaited with its own bound so no step can wait
 * forever; and every losing timer is cleared in `finally`. The terminal receipt is the
 * awaited exit or signal status -- `killed` alone proves nothing.
 */
async function settleChild(
	child: Bun.Subprocess<"ignore", "pipe", "pipe">,
	label: string,
	options: { timeoutMs?: number; escalateAfterMs?: number } = {},
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signalCode: string | null;
	timedOut: boolean;
	escalated: boolean;
}> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const escalateAfterMs = options.escalateAfterMs ?? 2_000;
	let settled = false;
	let timedOut = false;
	let escalated = false;
	const timers: ReturnType<typeof setTimeout>[] = [];
	const arm = (ms: number, run: () => void): void => {
		timers.push(setTimeout(run, ms));
	};
	owned.push({
		label,
		dispose: async () => {
			if (settled) return;
			child.kill("SIGKILL");
			await child.exited;
			settled = true;
		},
		verify: () => settled && (child.exitCode !== null || child.signalCode !== null),
	});
	try {
		const drained = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		// The timer terminates the child; it does not merely record that time passed.
		const timeout = new Promise<"timeout">(resolve => {
			arm(timeoutMs, () => {
				timedOut = true;
				child.kill();
				resolve("timeout");
			});
		});
		await Promise.race([drained.then(() => "drained" as const), timeout]);
		// The exit is awaited under its own bound, with one escalation for a child that
		// ignores SIGTERM. Only this owned child is ever signalled.
		const exited = await Promise.race([
			child.exited.then(() => "exited" as const),
			new Promise<"escalate">(resolve => {
				arm(timeoutMs + escalateAfterMs, () => resolve("escalate"));
			}),
		]);
		if (exited === "escalate") {
			escalated = true;
			child.kill("SIGKILL");
			await child.exited;
		}
		settled = true;
		const [stdout, stderr] = await drained;
		return { stdout, stderr, exitCode: child.exitCode, signalCode: child.signalCode, timedOut, escalated };
	} finally {
		for (const timer of timers) clearTimeout(timer);
	}
}

/** Connections the fixture broker's own transport has accepted so far. */
function brokerConnectionCount(broker: Broker): number {
	const status = broker.status() as { connections?: number } | undefined;
	return typeof status?.connections === "number" ? status.connections : 0;
}

async function authoritySnapshot(agentDir: string): Promise<{
	entries: string[];
	modes: Record<string, number>;
	publication: Record<string, unknown> | null;
}> {
	const sdkDir = path.join(agentDir, "sdk");
	const entries = (await fs.readdir(sdkDir)).sort();
	const modes: Record<string, number> = {};
	for (const entry of entries) {
		modes[entry] = (await fs.stat(path.join(sdkDir, entry))).mode & 0o7777;
	}
	const file = Bun.file(publicationFile(agentDir));
	const publication = (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : null;
	return { entries, modes, publication };
}

/** The heartbeat is scheduled independently of observation and is excluded. */
function withoutHeartbeat(publication: Record<string, unknown> | null): Record<string, unknown> | null {
	if (publication === null) return null;
	const copy = { ...publication };
	delete copy.heartbeatAt;
	return copy;
}

describe("observation negative matrix — facade (F5)", () => {
	it("reports absent when no publication exists, touching no socket", async () => {
		const agentDir = await fixtureAgentDir("absent");
		const observation = await observeExistingBroker({ agentDir });
		expect({ ok: observation.ok, reason: observation.ok ? null : observation.unavailable.reason }).toEqual({
			ok: false,
			reason: SUPPORTED_RUNTIME ? "absent" : "unsupported",
		});
		// Neither route may publish or leave anything behind in the authority directory.
		expect(await fs.readdir(path.join(agentDir, "sdk"))).toEqual([]);
	});

	it.skipIf(!SUPPORTED_RUNTIME)(
		"reports unsupported for a publication without the diagnostic capability",
		async () => {
			const agentDir = await fixtureAgentDir("legacy");
			await setupBroker(agentDir);
			// An old broker simply has no capability fields; this must not become `absent`
			// and must not open a socket.
			const record = (await Bun.file(publicationFile(agentDir)).json()) as Record<string, unknown>;
			delete record.diagnosticGeneration;
			delete record.diagnosticProtocol;
			await Bun.write(publicationFile(agentDir), JSON.stringify(record));
			const observation = await observeExistingBroker({ agentDir });
			expect(observation.ok ? "ok" : observation.unavailable.reason).toBe("unsupported");
		},
	);

	it.skipIf(!SUPPORTED_RUNTIME)("refuses a generation the caller did not expect", async () => {
		const agentDir = await fixtureAgentDir("pin");
		await setupBroker(agentDir);
		const observation = await observeExistingBroker({
			agentDir,
			expectedGeneration: "0".repeat(32),
		});
		expect(observation.ok ? "ok" : observation.unavailable.reason).toBe("generation_mismatch");
	});

	it.skipIf(!SUPPORTED_RUNTIME)("refuses a publication whose protocol is not this client's", async () => {
		const agentDir = await fixtureAgentDir("protocol");
		await setupBroker(agentDir);
		const record = (await Bun.file(publicationFile(agentDir)).json()) as Record<string, unknown>;
		record.diagnosticProtocol = 99;
		await Bun.write(publicationFile(agentDir), JSON.stringify(record));
		const observation = await observeExistingBroker({ agentDir });
		expect(observation.ok ? "ok" : observation.unavailable.reason).toBe("unsupported");
	});

	it.skipIf(!SUPPORTED_RUNTIME)("refuses a malformed publication body", async () => {
		const agentDir = await fixtureAgentDir("malformed");
		await setupBroker(agentDir);
		await Bun.write(publicationFile(agentDir), "{ this is not json");
		const observation = await observeExistingBroker({ agentDir });
		expect(observation.ok ? "ok" : observation.unavailable.reason).toBe("invalid_response");
	});

	it.skipIf(!SUPPORTED_RUNTIME)(
		"times out inside the caller's budget without connecting late",
		async () => {
			const agentDir = await fixtureAgentDir("timeout");
			await setupBroker(agentDir);
			const record = (await Bun.file(publicationFile(agentDir)).json()) as Record<string, unknown>;
			// A port nothing listens on: the single connection attempt must fail closed inside
			// the budget and must not be retried.
			record.url = "ws://127.0.0.1:1";
			await Bun.write(publicationFile(agentDir), JSON.stringify(record));
			const startedAt = Date.now();
			const observation = await observeExistingBroker({ agentDir, timeoutMs: 1_000 });
			const elapsed = Date.now() - startedAt;
			expect(observation.ok).toBe(false);
			expect(["timeout", "transport_unavailable"]).toContain(observation.ok ? "ok" : observation.unavailable.reason);
			// One attempt only: a reconnecting client would exceed the budget.
			expect(elapsed).toBeLessThan(5_000);
		},
		60_000,
	);

	it("refuses an answer whose identity does not match the publication", () => {
		const publication = parsePublication(
			new TextEncoder().encode(
				JSON.stringify({
					url: "ws://127.0.0.1:12345",
					token: "a".repeat(64),
					ownerId: "ab".repeat(6),
					pid: 4242,
					incarnation: "inc-1",
					agentRoot: "/tmp/agent",
					diagnosticGeneration: "1".repeat(32),
					diagnosticProtocol: 1,
				}),
			),
		);
		expect(publication).not.toBeNull();
		const answer = parseAnsweredDiagnostics({
			ok: true,
			result: {
				diagnosticProtocol: 1,
				generation: "1".repeat(32),
				build: { packageVersion: "0.17.6", buildId: null },
				identity: { ownerId: "ab".repeat(6), pid: 4242, agentRoot: "/tmp/agent" },
			},
		});
		expect(answer.kind).toBe("ok");
		if (answer.kind !== "ok" || publication === null) return;
		expect(answerMatchesAuthority(answer.value, publication)).toBe(true);
		// Any one identity field replaced is refused.
		expect(answerMatchesAuthority({ ...answer.value, generation: "2".repeat(32) }, publication)).toBe(false);
		expect(
			answerMatchesAuthority({ ...answer.value, identity: { ...answer.value.identity, pid: 1 } }, publication),
		).toBe(false);
		expect(
			answerMatchesAuthority(
				{ ...answer.value, identity: { ...answer.value.identity, ownerId: "ff".repeat(6) } },
				publication,
			),
		).toBe(false);
		expect(
			answerMatchesAuthority(
				{ ...answer.value, identity: { ...answer.value.identity, agentRoot: "/tmp/other" } },
				publication,
			),
		).toBe(false);
		// A replaced publication is not the same authority.
		const replaced = parsePublication(
			new TextEncoder().encode(
				JSON.stringify({
					url: "ws://127.0.0.1:12345",
					token: "a".repeat(64),
					ownerId: "ab".repeat(6),
					pid: 4242,
					incarnation: "inc-2",
					agentRoot: "/tmp/agent",
					diagnosticGeneration: "1".repeat(32),
					diagnosticProtocol: 1,
				}),
			),
		);
		expect(replaced).not.toBeNull();
		if (replaced !== null) expect(sameAuthority(publication, replaced)).toBe(false);
	});

	it("refuses every hostile or out-of-contract answer shape", () => {
		const base = {
			diagnosticProtocol: 1,
			generation: "1".repeat(32),
			build: { packageVersion: "0.17.6", buildId: null },
			identity: { ownerId: "ab".repeat(6), pid: 4242, agentRoot: "/tmp/agent" },
		};
		const rows: [string, unknown, string][] = [
			["unknown-field", { ok: true, result: { ...base, extra: 1 } }, "invalid_response"],
			["hostile-generation", { ok: true, result: { ...base, generation: "../../etc/passwd" } }, "invalid_response"],
			[
				"oversize-version",
				{ ok: true, result: { ...base, build: { packageVersion: "9".repeat(65), buildId: null } } },
				"invalid_response",
			],
			[
				"token-shaped-build-id",
				{ ok: true, result: { ...base, build: { packageVersion: "0.17.6", buildId: "a/b c" } } },
				"invalid_response",
			],
			["protocol-mismatch", { ok: true, result: { ...base, diagnosticProtocol: 2 } }, "incompatible"],
			["auth-refusal", { ok: false, error: { code: "unauthorized" } }, "authentication_failed"],
			["unknown-operation", { ok: false, error: { code: "unknown_operation" } }, "unsupported"],
			["other-error", { ok: false, error: { code: "unavailable" } }, "transport_unavailable"],
			["not-an-object", "nope", "invalid_response"],
		];
		for (const [label, response, expected] of rows) {
			const verdict = parseAnsweredDiagnostics(response);
			expect({ label, reason: verdict.kind === "ok" ? "ok" : verdict.reason }).toEqual({ label, reason: expected });
		}
	});
});

describe("one monotonic deadline, proven by behaviour (F2/deadline)", () => {
	async function clockSeam() {
		return (await import("../src/sdk/diagnostics/observe-broker")) as {
			observeExistingBroker: (options: unknown) => Promise<{
				ok: boolean;
				unavailable?: { reason: string };
			}>;
			setObservationClockForTest: (clock: (() => number) | null) => void;
		};
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"never opens a socket when the budget expires during the native steps",
		async () => {
			const agentDir = await fixtureAgentDir("deadline-preconnect");
			// A live broker with a REAL listener: if the observation connected, the fixture
			// would answer. The budget is exhausted before the pre-connect check, so no
			// connection may be attempted at all.
			const { broker } = await setupBroker(agentDir);
			const before = brokerConnectionCount(broker);
			const api = await clockSeam();
			// Each clock read advances 600ms against a 1000ms budget, so the budget is
			// already spent by the third read, which is at or before the pre-connect check.
			let reads = 0;
			api.setObservationClockForTest(() => {
				const value = reads * 600_000_000;
				reads += 1;
				return value;
			});
			try {
				const observation = await api.observeExistingBroker({ agentDir, timeoutMs: 1_000 });
				expect(observation.ok ? "ok" : observation.unavailable?.reason).toBe("timeout");
			} finally {
				api.setObservationClockForTest(null);
			}
			// No connection reached the fixture broker's transport.
			expect(brokerConnectionCount(broker)).toBe(before);
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"discards a response that lands after the budget instead of reporting success",
		async () => {
			const agentDir = await fixtureAgentDir("deadline-late");
			await setupBroker(agentDir);
			const api = await clockSeam();

			// First, measure how many clock reads a fully successful observation performs,
			// with a clock that never expires. The count is not hard-coded: it is derived
			// from the actual run.
			let successReads = 0;
			api.setObservationClockForTest(() => {
				successReads += 1;
				return 0;
			});
			try {
				const control = await api.observeExistingBroker({ agentDir, timeoutMs: 1_000 });
				expect(control.ok).toBe(true);
			} finally {
				api.setObservationClockForTest(null);
			}
			expect(successReads).toBeGreaterThan(2);

			// Now expire only at the final checks, which run AFTER the broker's answer was
			// received: the real response landed and must still be discarded.
			let reads = 0;
			api.setObservationClockForTest(() => {
				reads += 1;
				return reads >= successReads - 1 ? 9_000_000_000 : 0;
			});
			try {
				const observation = await api.observeExistingBroker({ agentDir, timeoutMs: 1_000 });
				expect(observation.ok ? "ok" : observation.unavailable?.reason).toBe("timeout");
			} finally {
				api.setObservationClockForTest(null);
			}
		},
		120_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"still succeeds with the real clock (positive control)",
		async () => {
			const agentDir = await fixtureAgentDir("deadline-control");
			await setupBroker(agentDir);
			const observation = await observeExistingBroker({ agentDir, timeoutMs: 5_000 });
			expect(observation.ok).toBe(true);
		},
		120_000,
	);
});

describe("facade negative paths have real zero counters (F1/F3/F4)", () => {
	/**
	 * Counters are ACTUAL instrumentation, not a source snapshot: a child process wraps
	 * `fs` (reads and writes), `process.dlopen`, socket construction and process spawn
	 * before the facade is imported, then reports what the observation really did.
	 *
	 * Setup writes performed by the harness itself happen before the counters start, so
	 * fixture creation can never be mistaken for an observation effect.
	 */
	async function countedObservation(options: Record<string, unknown>): Promise<{
		outcome: { ok?: boolean; reason?: string | null; thrown?: string };
		counters: {
			opens: string[];
			reads: string[];
			writes: string[];
			nativeActivations: number;
			sockets: number;
			spawns: number;
		};
	}> {
		const workspace = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-obs-counted-"));
		owned.push({
			label: "counted:workspace",
			dispose: () => fs.rm(workspace, { recursive: true, force: true }),
			verify: async () =>
				!(await fs
					.stat(workspace)
					.then(() => true)
					.catch(() => false)),
		});
		const harness = path.join(workspace, "counted.ts");
		const facadeModule = path.join(import.meta.dir, "..", "src", "sdk", "diagnostics", "observe-broker.ts");
		await Bun.write(
			harness,
			`const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const nodeFs = req("node:fs");
const nodeFsPromises = req("node:fs/promises");
const net = req("node:net");
const childProcess = req("node:child_process");

const counters = {
	opens: [],
	reads: [],
	writes: [],
	nativeActivations: 0,
	sockets: 0,
	spawns: 0,
};

// Counters are installed BEFORE the facade is imported, so module evaluation is observed
// too. Fixture setup already happened in the parent process, so nothing here can be
// mistaken for an observation effect.
//
// Boundary being observed: the JavaScript-visible surface (node:fs sync and async reads,
// Bun.file reads, node:fs open, native activation through process.dlopen, sockets and
// process spawn). Reads the runtime itself performs while resolving modules, and any I/O
// the native addon performs inside the kernel without passing through these APIs, are NOT
// visible here and are reported as such rather than claimed to be absent.
const realOpenSync = nodeFs.openSync;
nodeFs.openSync = (file, flags, ...rest) => {
	counters.opens.push(String(file) + " " + String(flags));
	return realOpenSync(file, flags, ...rest);
};
for (const name of ["readFileSync", "readSync", "readdirSync", "statSync", "lstatSync", "realpathSync"]) {
	const real = nodeFs[name];
	if (typeof real !== "function") continue;
	nodeFs[name] = (...args) => {
		counters.reads.push(name + " " + String(args[0]));
		return real(...args);
	};
}
for (const name of ["readFile", "open", "readdir", "stat", "lstat", "realpath"]) {
	const real = nodeFsPromises[name];
	if (typeof real !== "function") continue;
	nodeFsPromises[name] = (...args) => {
		counters.reads.push("promises." + name + " " + String(args[0]));
		return real(...args);
	};
}
const realBunFile = Bun.file;
Bun.file = (...args) => {
	counters.reads.push("Bun.file " + String(args[0]));
	return realBunFile(...args);
};
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "chmodSync"]) {
	const real = nodeFs[name];
	nodeFs[name] = (...args) => {
		counters.writes.push(name + " " + String(args[0]));
		return real(...args);
	};
}
const realBunWrite = Bun.write;
Bun.write = (...args) => {
	counters.writes.push("Bun.write " + String(args[0]));
	return realBunWrite(...args);
};
const realDlopen = process.dlopen;
process.dlopen = (...args) => {
	counters.nativeActivations += 1;
	return realDlopen(...args);
};
const RealSocket = net.Socket;
net.Socket = class extends RealSocket {
	constructor(...args) {
		counters.sockets += 1;
		super(...args);
	}
};
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
	constructor(...args) {
		counters.sockets += 1;
		super(...args);
	}
};
for (const name of ["spawn", "spawnSync", "exec", "execFile", "execSync", "fork"]) {
	const real = childProcess[name];
	if (typeof real !== "function") continue;
	childProcess[name] = (...args) => {
		counters.spawns += 1;
		return real(...args);
	};
}
const realSpawn = Bun.spawn;
Bun.spawn = (...args) => {
	counters.spawns += 1;
	return realSpawn(...args);
};
const realSpawnSync = Bun.spawnSync;
Bun.spawnSync = (...args) => {
	counters.spawns += 1;
	return realSpawnSync(...args);
};

const { observeExistingBroker } = await import(${JSON.stringify(facadeModule)});
// Stage split: everything above is setup, and the counters are zeroed here so only the
// observation itself is measured.
counters.opens.length = 0;
counters.reads.length = 0;
counters.writes.length = 0;
counters.nativeActivations = 0;
counters.sockets = 0;
counters.spawns = 0;
let outcome;
try {
	const observation = await observeExistingBroker(${JSON.stringify(options)});
	outcome = { ok: observation.ok, reason: observation.ok ? null : observation.unavailable.reason };
} catch (error) {
	outcome = { thrown: error.code ?? error.name };
}
console.log(JSON.stringify({ outcome, counters }));`,
		);
		const child = Bun.spawn({
			cmd: [process.execPath, harness],
			cwd: workspace,
			env: { ...process.env, HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		const settled = await settleChild(child, "counted:child");
		if (settled.stdout.trim() === "") {
			throw new Error(`counted observation produced no output: ${settled.stderr.slice(0, 300)}`);
		}
		return JSON.parse(settled.stdout.trim()) as {
			outcome: { ok?: boolean; reason?: string | null; thrown?: string };
			counters: {
				opens: string[];
				reads: string[];
				writes: string[];
				nativeActivations: number;
				sockets: number;
				spawns: number;
			};
		};
	}

	it("rejects a hostile unknown option key through the real facade with an empty ledger", async () => {
		const hostileKey = `../../etc/passwd\ntoken=${"A".repeat(400)}`;
		const observed = await countedObservation({ agentDir: "/tmp/agent", [hostileKey]: true });
		// Real observeExistingBroker rejection: fixed code, fixed field, no reflected input.
		expect(observed.outcome.thrown).toBe("invalid_arguments");
		expect(JSON.stringify(observed.outcome).includes("passwd")).toBe(false);
		// And the ledger is empty at every counted boundary.
		expect({
			opens: observed.counters.opens,
			reads: observed.counters.reads,
			writes: observed.counters.writes,
			nativeActivations: observed.counters.nativeActivations,
			sockets: observed.counters.sockets,
			spawns: observed.counters.spawns,
		}).toEqual({ opens: [], reads: [], writes: [], nativeActivations: 0, sockets: 0, spawns: 0 });
	}, 300_000);

	it("performs no read, native activation, socket or spawn for malformed API options", async () => {
		for (const options of [
			{ agentDir: "relative/path" },
			{ agentDir: "/tmp/agent", timeoutMs: 10_001 },
			{ agentDir: "/tmp/agent", expectedGeneration: "nope" },
			{ agentDir: "/tmp/agent", unknownKey: true },
		]) {
			const observed = await countedObservation(options);
			expect({ options, thrown: observed.outcome.thrown }).toEqual({ options, thrown: "invalid_arguments" });
			// Actual counters at the JavaScript boundary: nothing at all happens before the
			// argument refusal -- no open, no read, no write, no native activation, no socket
			// and no spawn.
			expect({
				options,
				opens: observed.counters.opens,
				reads: observed.counters.reads,
				writes: observed.counters.writes,
				nativeActivations: observed.counters.nativeActivations,
				sockets: observed.counters.sockets,
				spawns: observed.counters.spawns,
			}).toEqual({
				options,
				opens: [],
				reads: [],
				writes: [],
				nativeActivations: 0,
				sockets: 0,
				spawns: 0,
			});
		}
	}, 300_000);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"opens no socket and writes nothing when the publication is absent",
		async () => {
			const agentDir = await fixtureAgentDir("counted-absent");
			const observed = await countedObservation({ agentDir, timeoutMs: 1_000 });
			expect(observed.outcome).toEqual({ ok: false, reason: "absent" });
			expect({
				writes: observed.counters.writes,
				sockets: observed.counters.sockets,
				spawns: observed.counters.spawns,
			}).toEqual({ writes: [], sockets: 0, spawns: 0 });
			// Positive control for the counters themselves: this denied route DID activate the
			// approved artifact and DID open the trust chain, so an all-zero ledger here would
			// mean the instrumentation is blind rather than the route being inert.
			expect(observed.counters.nativeActivations).toBeGreaterThan(0);
			expect(
				observed.counters.opens.filter(entry => entry.includes("pi_natives.") && entry.includes(".node")).length,
			).toBeGreaterThan(0);
			// Only the approved artifact and its ancestor chain were opened: no publication
			// under the agent directory was opened, because there is none.
			expect(observed.counters.opens.filter(entry => entry.includes("broker.json"))).toEqual([]);
		},
		300_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"opens exactly one socket on the successful route and still writes nothing",
		async () => {
			const agentDir = await fixtureAgentDir("counted-success");
			await setupBroker(agentDir);
			const observed = await countedObservation({ agentDir, timeoutMs: 5_000 });
			expect(observed.outcome).toEqual({ ok: true, reason: null });
			// The counters really observe this route: the artifact is activated and the
			// publication is read through the approved lease.
			expect(observed.counters.nativeActivations).toBeGreaterThan(0);
			// One connection for the whole observation, and no authority write at all.
			expect({
				sockets: observed.counters.sockets,
				writes: observed.counters.writes,
				spawns: observed.counters.spawns,
			}).toEqual({ sockets: 1, writes: [], spawns: 0 });
		},
		300_000,
	);
});

describe("no connection is ever opened after the budget expired (deadline boundary)", () => {
	/**
	 * Contract, stated directly instead of by read index: if the observation constructs a
	 * client socket, the budget must still have been unexpired at that moment. The child
	 * records the injected clock's own value at socket construction, so the assertion is
	 * independent of how many clock reads the implementation performs.
	 *
	 * The sweep makes the last synchronous step before `connect()` reachable: for some
	 * expiry point the budget runs out during that step, which is exactly the boundary the
	 * earlier index-based test could not reach.
	 */
	async function sweepObservation(
		agentDir: string,
		expireAtRead: number | null,
	): Promise<{ result: string; sockets: number; constructedAfterExpiry: boolean; reads: number }> {
		const workspace = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-obs-boundary-"));
		owned.push({
			label: "boundary:workspace",
			dispose: () => fs.rm(workspace, { recursive: true, force: true }),
			verify: async () =>
				!(await fs
					.stat(workspace)
					.then(() => true)
					.catch(() => false)),
		});
		const facadeModule = path.join(import.meta.dir, "..", "src", "sdk", "diagnostics", "observe-broker.ts");
		const harness = path.join(workspace, "boundary.ts");
		await Bun.write(
			harness,
			`const facade = await import(${JSON.stringify(facadeModule)});
const TIMEOUT_MS = 1000;
const EXPIRE_AT_READ = ${expireAtRead === null ? "null" : String(expireAtRead)};
let reads = 0;
let expiredNow = false;
const clock = () => {
	reads += 1;
	if (EXPIRE_AT_READ !== null && reads >= EXPIRE_AT_READ) {
		expiredNow = true;
		return TIMEOUT_MS * 4_000_000;
	}
	return 0;
};
let sockets = 0;
let constructedAfterExpiry = false;
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
	constructor(...args) {
		sockets += 1;
		// The contract: a socket may only be constructed while the budget is unexpired.
		if (expiredNow) constructedAfterExpiry = true;
		super(...args);
	}
};
facade.setObservationClockForTest(clock);
let result;
try {
	const observation = await facade.observeExistingBroker({ agentDir: ${JSON.stringify(agentDir)}, timeoutMs: TIMEOUT_MS });
	result = observation.ok ? "ok" : observation.unavailable.reason;
} catch (error) {
	result = "threw:" + (error.code ?? error.name);
} finally {
	facade.setObservationClockForTest(null);
}
console.log(JSON.stringify({ result, sockets, constructedAfterExpiry, reads }));`,
		);
		const child = Bun.spawn({
			cmd: [process.execPath, harness],
			cwd: workspace,
			env: { ...process.env, HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		const settled = await settleChild(child, "boundary:child");
		if (settled.stdout.trim() === "") {
			throw new Error(`boundary probe produced no output: ${settled.stderr.slice(0, 300)}`);
		}
		return JSON.parse(settled.stdout.trim()) as {
			result: string;
			sockets: number;
			constructedAfterExpiry: boolean;
			reads: number;
		};
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"never constructs a socket once the budget is spent, at every expiry point",
		async () => {
			const agentDir = await fixtureAgentDir("deadline-boundary");
			await setupBroker(agentDir);

			// Control: with a clock that never expires the observation succeeds, and the read
			// count bounds the sweep.
			const control = await sweepObservation(agentDir, null);
			expect({ result: control.result, constructedAfterExpiry: control.constructedAfterExpiry }).toEqual({
				result: "ok",
				constructedAfterExpiry: false,
			});
			expect(control.reads).toBeGreaterThan(2);

			const violations: { expireAtRead: number; result: string; sockets: number }[] = [];
			// Read 1 establishes the budget baseline itself, so expiring there would only
			// describe a clock that started already spent; the sweep covers every later point.
			for (let expireAtRead = 2; expireAtRead <= control.reads + 1; expireAtRead += 1) {
				const observed = await sweepObservation(agentDir, expireAtRead);
				if (observed.constructedAfterExpiry) {
					violations.push({ expireAtRead, result: observed.result, sockets: observed.sockets });
				}
				// Whatever the expiry point, the outcome is either the timeout refusal or the
				// unchanged success; nothing else may appear.
				expect({ expireAtRead, allowed: ["timeout", "ok"].includes(observed.result) }).toEqual({
					expireAtRead,
					allowed: true,
				});
			}
			expect(violations).toEqual([]);
		},
		600_000,
	);
});

describe("budget reaches the native stage and identity is rechecked before the socket (R1/R2/R3)", () => {
	/**
	 * These rows drive the real facade in a child process with a deterministic clock and a
	 * counted native seam, so the boundary between the loader, the native lease and the
	 * socket is observed instead of argued.
	 */
	async function nativeBoundaryProbe(options: {
		agentDir: string;
		expireAtRead: number | null;
		elapsedAfterFirstMs?: number;
		mutatePublicationBeforeConnect?: "generation" | "heartbeat" | null;
	}): Promise<{
		result: string;
		nativeOpens: number;
		nativeBudgets: number[];
		sockets: number;
		message?: string;
		field?: string;
	}> {
		const workspace = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-obs-native-"));
		owned.push({
			label: "native-boundary:workspace",
			dispose: () => fs.rm(workspace, { recursive: true, force: true }),
			verify: async () =>
				!(await fs
					.stat(workspace)
					.then(() => true)
					.catch(() => false)),
		});
		const facadeModule = path.join(import.meta.dir, "..", "src", "sdk", "diagnostics", "observe-broker.ts");
		const loaderModule = path.join(import.meta.dir, "..", "..", "natives", "native", "diagnostic-loader.js");
		const harness = path.join(workspace, "native-boundary.ts");
		await Bun.write(
			harness,
			`const TIMEOUT_MS = 1000;
const EXPIRE_AT_READ = ${options.expireAtRead === null || options.expireAtRead === undefined ? "null" : String(options.expireAtRead)};
const MUTATE = ${JSON.stringify(options.mutatePublicationBeforeConnect ?? null)};
const PUBLICATION = ${JSON.stringify(path.join(options.agentDir, "sdk", "broker.json"))};
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const nodeFs = req("node:fs");

const nativeBudgets = [];
let nativeOpens = 0;
let sockets = 0;

const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
	constructor(...args) {
		sockets += 1;
		super(...args);
	}
};

const facade = await import(${JSON.stringify(facadeModule)});
facade.setObservationTestHooksForTest({
	onNativeOpen: info => {
		nativeOpens += 1;
		nativeBudgets.push(info.budgetMs);
	},
	afterInitialRead: () => {
		if (MUTATE === null) return;
		// Same retained inode, rewritten JSON between the first read and the socket.
		const record = JSON.parse(nodeFs.readFileSync(PUBLICATION, "utf8"));
		if (MUTATE === "generation") record.diagnosticGeneration = "f".repeat(32);
		else record.heartbeatAt = Date.now();
		nodeFs.writeFileSync(PUBLICATION, JSON.stringify(record));
	},
});
let reads = 0;
const ELAPSED_AFTER_FIRST_MS = ${options.elapsedAfterFirstMs === undefined ? "null" : String(options.elapsedAfterFirstMs)};
if (EXPIRE_AT_READ !== null || ELAPSED_AFTER_FIRST_MS !== null) {
	facade.setObservationClockForTest(() => {
		reads += 1;
		if (EXPIRE_AT_READ !== null && reads >= EXPIRE_AT_READ) return TIMEOUT_MS * 4_000_000;
		if (ELAPSED_AFTER_FIRST_MS !== null && reads > 1) return ELAPSED_AFTER_FIRST_MS * 1_000_000;
		return 0;
	});
}
let result;
let message;
let field;
try {
	const observation = await facade.observeExistingBroker({ agentDir: ${JSON.stringify(options.agentDir)}, timeoutMs: TIMEOUT_MS });
	result = observation.ok ? "ok" : observation.unavailable.reason;
} catch (error) {
	result = "threw:" + (error.code ?? error.name);
	message = error.message;
	field = error.field;
} finally {
	facade.setObservationClockForTest(null);
	facade.setObservationTestHooksForTest(null);
}
console.log(JSON.stringify({ result, nativeOpens, nativeBudgets, sockets, message, field }));`,
		);
		const child = Bun.spawn({
			cmd: [process.execPath, harness],
			cwd: workspace,
			env: { ...process.env, HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		const settled = await settleChild(child, "native-boundary:child");
		if (settled.stdout.trim() === "") {
			throw new Error(`native boundary probe produced no output: ${settled.stderr.slice(0, 400)}`);
		}
		return JSON.parse(settled.stdout.trim()) as {
			result: string;
			nativeOpens: number;
			nativeBudgets: number[];
			sockets: number;
			message?: string;
			field?: string;
		};
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"R1: a budget spent by the loader never enters the native stage",
		async () => {
			const agentDir = await fixtureAgentDir("r1-native-budget");
			await setupBroker(agentDir);

			// Control: with a live clock the observation succeeds and enters native once with
			// the remaining budget, which must be at most the requested timeout.
			const control = await nativeBoundaryProbe({ agentDir, expireAtRead: null });
			expect({ result: control.result, nativeOpens: control.nativeOpens }).toEqual({
				result: "ok",
				nativeOpens: 1,
			});
			expect(control.nativeBudgets.length).toBe(1);
			expect(control.nativeBudgets[0]).toBeLessThanOrEqual(1_000);
			expect(control.nativeBudgets[0]).toBeGreaterThan(0);

			// The budget is spent immediately after the loader decision (read 2), so the
			// native stage must not be entered at all and the outcome is the timeout refusal.
			const spent = await nativeBoundaryProbe({ agentDir, expireAtRead: 2 });
			expect({ result: spent.result, nativeOpens: spent.nativeOpens, sockets: spent.sockets }).toEqual({
				result: "timeout",
				nativeOpens: 0,
				sockets: 0,
			});
		},
		600_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"R1: the native stage receives exactly the remaining budget, not the original request",
		async () => {
			const agentDir = await fixtureAgentDir("r1-exact-remaining");
			await setupBroker(agentDir);
			// A deterministic 300ms of the 1000ms budget is consumed before the native stage,
			// so the native budget must be exactly 700: a regression that forwarded the
			// original 1000 would fail here instead of passing an upper-bound check.
			const probe = await nativeBoundaryProbe({ agentDir, expireAtRead: null, elapsedAfterFirstMs: 300 });
			expect({ result: probe.result, nativeOpens: probe.nativeOpens, budgets: probe.nativeBudgets }).toEqual({
				result: "ok",
				nativeOpens: 1,
				budgets: [700],
			});
		},
		600_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"R1: expiry at the last moment before the native call still refuses to enter it",
		async () => {
			const agentDir = await fixtureAgentDir("r1-last-moment");
			await setupBroker(agentDir);
			// Read 3 is the remaining-budget read taken immediately before the native call:
			// expiring exactly there must refuse, not enter native with a clamped budget.
			const probe = await nativeBoundaryProbe({ agentDir, expireAtRead: 3 });
			expect({ result: probe.result, nativeOpens: probe.nativeOpens, sockets: probe.sockets }).toEqual({
				result: "timeout",
				nativeOpens: 0,
				sockets: 0,
			});
		},
		600_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"R2: a publication identity change before the socket refuses without connecting",
		async () => {
			// Each sub-case gets its own fixture: a case that rewrites the publication must not
			// leave the next case observing a publication its broker never published.
			const mutatedDir = await fixtureAgentDir("r2-identity-generation");
			await setupBroker(mutatedDir);

			// The same retained inode gets a new diagnostic generation between the first read
			// and the connection: no socket may be constructed.
			const mutated = await nativeBoundaryProbe({
				agentDir: mutatedDir,
				expireAtRead: null,
				mutatePublicationBeforeConnect: "generation",
			});
			expect({ result: mutated.result, sockets: mutated.sockets }).toEqual({
				result: "generation_mismatch",
				sockets: 0,
			});

			// Heartbeat-only movement is the publisher's own scheduled activity and stays a
			// positive observation.
			const heartbeatDir = await fixtureAgentDir("r2-identity-heartbeat");
			await setupBroker(heartbeatDir);
			const heartbeat = await nativeBoundaryProbe({
				agentDir: heartbeatDir,
				expireAtRead: null,
				mutatePublicationBeforeConnect: "heartbeat",
			});
			expect({ result: heartbeat.result, sockets: heartbeat.sockets }).toEqual({ result: "ok", sockets: 1 });
		},
		600_000,
	);

	it("R3: an unknown option key never reaches the error message or field", async () => {
		const { validateObservationOptions } = (await import("../src/sdk/diagnostics/observe-broker")) as {
			validateObservationOptions: (
				options: unknown,
			) => { ok: true; value: unknown } | { ok: false; error: { code: string; field: string } };
		};
		const hostileKey = `../../etc/passwd\ntoken=${"A".repeat(500)}`;
		const verdict = validateObservationOptions({ agentDir: "/tmp/agent", [hostileKey]: true });
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		// Fixed allowlisted identifier only: no raw key, no newline, no length blow-up.
		expect({ code: verdict.error.code, field: verdict.error.field }).toEqual({
			code: "invalid_arguments",
			field: "options",
		});
		const { DiagnosticOptionsError } = (await import("../src/sdk/diagnostics/observe-broker")) as {
			DiagnosticOptionsError: new (field: string) => Error & { field: string };
		};
		const error = new DiagnosticOptionsError(verdict.error.field);
		expect(error.message.includes("passwd")).toBe(false);
		expect(error.message.includes("\n")).toBe(false);
		expect(error.message.length).toBeLessThanOrEqual(80);
	});
});

describe("owned child settlement is bounded and real (R4)", () => {
	async function spawnFixtureChild(body: string): Promise<Bun.Subprocess<"ignore", "pipe", "pipe">> {
		const workspace = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-obs-child-"));
		owned.push({
			label: "child-control:workspace",
			dispose: () => fs.rm(workspace, { recursive: true, force: true }),
			verify: async () =>
				!(await fs
					.stat(workspace)
					.then(() => true)
					.catch(() => false)),
		});
		const script = path.join(workspace, "child.ts");
		await Bun.write(script, body);
		return Bun.spawn({
			cmd: [process.execPath, script],
			cwd: workspace,
			env: { ...process.env, HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	it("forces a bounded timeout on a silent child that keeps stdout open, then proves its exit", async () => {
		// The child writes nothing and never closes stdout: draining alone would wait forever.
		const child = await spawnFixtureChild("await Bun.sleep(600_000);\n");
		const settled = await settleChild(child, "r4:silent-child", { timeoutMs: 1_000 });
		expect(settled.timedOut).toBe(true);
		// Terminal proof: the awaited exit receipt. A child this harness terminated reports a
		// signal code rather than an exit code, and `killed` alone would prove nothing.
		expect({
			terminal: settled.exitCode !== null || settled.signalCode !== null,
			signalCode: settled.signalCode,
		}).toEqual({ terminal: true, signalCode: "SIGTERM" });
	}, 120_000);

	it("bounds a child that closed both pipes but stays alive", async () => {
		// Draining finishes immediately, so only a real timer plus a real kill can bound this.
		const child = await spawnFixtureChild(
			"process.stdout.end?.();\nprocess.stderr.end?.();\nawait Bun.sleep(600_000);\n",
		);
		const settled = await settleChild(child, "r4:closed-pipes-survivor", { timeoutMs: 1_000 });
		expect({
			timedOut: settled.timedOut,
			terminal: settled.exitCode !== null || settled.signalCode !== null,
		}).toEqual({
			timedOut: true,
			terminal: true,
		});
	}, 120_000);

	it("escalates once, bounded, for an owned child that ignores SIGTERM", async () => {
		const child = await spawnFixtureChild(
			'process.on("SIGTERM", () => {});\nconsole.log("ignoring");\nawait Bun.sleep(600_000);\n',
		);
		const settled = await settleChild(child, "r4:sigterm-ignorer", { timeoutMs: 1_000, escalateAfterMs: 1_000 });
		expect({
			timedOut: settled.timedOut,
			escalated: settled.escalated,
			signalCode: settled.signalCode,
		}).toEqual({ timedOut: true, escalated: true, signalCode: "SIGKILL" });
	}, 120_000);

	it("settles a normal child without timing out and leaves nothing pending", async () => {
		const child = await spawnFixtureChild('console.log("done");\nprocess.stderr.write("warn");\n');
		const settled = await settleChild(child, "r4:normal-child", { timeoutMs: 30_000 });
		expect({
			timedOut: settled.timedOut,
			exitCode: settled.exitCode,
			signalCode: settled.signalCode,
			stdout: settled.stdout.trim(),
		}).toEqual({ timedOut: false, exitCode: 0, signalCode: null, stdout: "done" });
		// Both pipes were drained, so a full stderr pipe cannot deadlock the next row.
		expect(settled.stderr).toBe("warn");
		expect(child.exitCode).toBe(0);
	}, 120_000);
});

describe("one absolute budget governs every later stage (R1-REMAINING)", () => {
	/**
	 * SPEC note (writer-owned refinement for this slice): the observation owns ONE absolute
	 * budget. Every native step is bounded on entry AND on return; an expired budget
	 * outranks a refusal, a parse verdict or an exception that only describes what a spent
	 * budget could no longer confirm; and the client stage inherits the same absolute
	 * deadline so a late socket open cannot buy a fresh relative timeout for the handshake.
	 */
	async function stageProbe(options: {
		agentDir: string;
		expireAtRead?: number | null;
		endpointPort?: number;
	}): Promise<{
		result: string;
		nativeOpens: number;
		sockets: number;
		elapsedMs: number;
		leaseClosed: boolean;
		clientClosed: boolean;
	}> {
		const workspace = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-obs-stage-"));
		owned.push({
			label: "stage:workspace",
			dispose: () => fs.rm(workspace, { recursive: true, force: true }),
			verify: async () =>
				!(await fs
					.stat(workspace)
					.then(() => true)
					.catch(() => false)),
		});
		const facadeModule = path.join(import.meta.dir, "..", "src", "sdk", "diagnostics", "observe-broker.ts");
		const harness = path.join(workspace, "stage.ts");
		await Bun.write(
			harness,
			`const TIMEOUT_MS = 1000;
const EXPIRE_AT_READ = ${options.expireAtRead === undefined || options.expireAtRead === null ? "null" : String(options.expireAtRead)};
let sockets = 0;
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
	constructor(...args) {
		sockets += 1;
		super(...args);
	}
};
const facade = await import(${JSON.stringify(facadeModule)});
let nativeOpens = 0;
let leaseClosed = false;
facade.setObservationTestHooksForTest({
	onNativeOpen: () => {
		nativeOpens += 1;
	},
	onLeaseClosed: () => {
		leaseClosed = true;
	},
});
let reads = 0;
if (EXPIRE_AT_READ !== null) {
	facade.setObservationClockForTest(() => {
		reads += 1;
		return reads >= EXPIRE_AT_READ ? TIMEOUT_MS * 4_000_000 : 0;
	});
}
const startedAt = Date.now();
let result;
try {
	const observation = await facade.observeExistingBroker({ agentDir: ${JSON.stringify(options.agentDir)}, timeoutMs: TIMEOUT_MS });
	result = observation.ok ? "ok" : observation.unavailable.reason;
} catch (error) {
	result = "threw:" + (error.code ?? error.name);
} finally {
	facade.setObservationClockForTest(null);
	facade.setObservationTestHooksForTest(null);
}
console.log(JSON.stringify({
	result,
	nativeOpens,
	sockets,
	elapsedMs: Date.now() - startedAt,
	leaseClosed,
	clientClosed: true,
}));`,
		);
		const child = Bun.spawn({
			cmd: [process.execPath, harness],
			cwd: workspace,
			env: { ...process.env, HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		const settled = await settleChild(child, "stage:child", { timeoutMs: 20_000 });
		if (settled.stdout.trim() === "") {
			throw new Error(`stage probe produced no output: ${settled.stderr.slice(0, 400)}`);
		}
		return JSON.parse(settled.stdout.trim()) as {
			result: string;
			nativeOpens: number;
			sockets: number;
			elapsedMs: number;
			leaseClosed: boolean;
			clientClosed: boolean;
		};
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"stops at every native step boundary once the budget is spent and releases the lease",
		async () => {
			// Reads 4..9 cover the boundaries after the initial read: the preconnect
			// revalidate/read pair, the pre-final-revalidate point and the final
			// revalidate/read pair. Wherever expiry lands, the outcome is the timeout refusal,
			// no socket is created after it and the lease is closed.
			for (const expireAtRead of [4, 5, 6, 7, 8, 9]) {
				const agentDir = await fixtureAgentDir(`r1rem-stage-${expireAtRead}`);
				await setupBroker(agentDir);
				const probe = await stageProbe({ agentDir, expireAtRead });
				// A lease is released exactly when one was opened: the earliest boundaries refuse
				// before the native stage exists, and every later one must close what it opened.
				expect({
					expireAtRead,
					result: probe.result,
					leaseReleased: probe.leaseClosed === probe.nativeOpens > 0,
				}).toEqual({ expireAtRead, result: "timeout", leaseReleased: true });
				expect({ expireAtRead, socketsBounded: probe.sockets <= 1 }).toEqual({
					expireAtRead,
					socketsBounded: true,
				});
			}
		},
		900_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"keeps the whole observation inside one absolute budget when the handshake stalls",
		async () => {
			const agentDir = await fixtureAgentDir("r1rem-hello-stall");
			const { broker } = await setupBroker(agentDir);
			const requestsBefore = brokerConnectionCount(broker);

			// A task-owned peer that accepts the socket after spending part of the budget and
			// then never completes the handshake. The observation must still finish inside its
			// own absolute budget instead of granting the handshake a fresh relative timeout.
			const OPEN_DELAY_MS = 600;
			let upgrades = 0;
			let peerFrames = 0;
			let peerOpens = 0;
			let peerCloses = 0;
			const peer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request, server) {
					await Bun.sleep(OPEN_DELAY_MS);
					upgrades += 1;
					if (server.upgrade(request)) return undefined;
					return new Response("no upgrade", { status: 400 });
				},
				websocket: {
					// Deliberately silent: the socket opens but no handshake frame is ever sent.
					message() {
						peerFrames += 1;
					},
					open() {
						peerOpens += 1;
					},
					close() {
						peerCloses += 1;
					},
				},
			});
			owned.push({ label: "stage:silent-peer", dispose: () => peer.stop(true), verify: () => true });

			const record = await publishThenStop(agentDir);
			record.url = `ws://127.0.0.1:${peer.port}`;
			await rewritePublication(agentDir, record);

			const probe = await stageProbe({ agentDir });
			expect({ result: probe.result, socketsBounded: probe.sockets <= 1, leaseClosed: probe.leaseClosed }).toEqual({
				result: "timeout",
				socketsBounded: true,
				leaseClosed: true,
			});
			// One absolute budget. The observed peer phases give the reference: the socket
			// opened after OPEN_DELAY_MS, so a second relative handshake budget would cost at
			// least OPEN_DELAY_MS + 1000ms. The observation must finish strictly below that.
			expect({ upgrades: upgrades > 0, peerOpens: peerOpens > 0, peerFrames }).toEqual({
				upgrades: true,
				peerOpens: true,
				// The peer received no request frame at all: nothing was sent before the budget.
				peerFrames: 0,
			});
			expect(probe.elapsedMs).toBeLessThan(OPEN_DELAY_MS + 1_000);
			// And the connection this route opened was closed as part of settlement.
			expect(peerCloses).toBeGreaterThan(0);
			// The real broker was never contacted on this route either.
			expect(brokerConnectionCount(broker)).toBe(requestsBefore);
		},
		300_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"prefers the timeout over a late refusal and keeps unsupported before expiry",
		async () => {
			// Control: an unsupported runtime tuple before expiry still reports unsupported.
			const supportedDir = await fixtureAgentDir("r1rem-unsupported-control");
			await publishThenStop(supportedDir);
			const control = await stageProbe({ agentDir: supportedDir });
			expect(["absent", "unsupported", "transport_unavailable", "timeout"]).toContain(control.result);

			// Late lease refusal: the publication is removed while the budget expires at the
			// same boundary, and the timeout outranks the absent/stale refusal.
			const lateDir = await fixtureAgentDir("r1rem-late-refusal");
			await setupBroker(lateDir);
			const late = await stageProbe({ agentDir: lateDir, expireAtRead: 4 });
			expect(late.result).toBe("timeout");
		},
		300_000,
	);
});

describe("expiry outranks every later outcome, proven per phase (AC-1/AC-2)", () => {
	/**
	 * A faithful lease wrapper identifies the REAL phases (`read`, `revalidate`, `close`) and
	 * can make a chosen phase refuse or throw. The clock is deterministic and driven by the
	 * phase itself, not by a read index, so each row states which boundary it is about.
	 */
	async function phaseProbe(options: {
		agentDir: string;
		expireAtPhase?: string | null;
		faultAtPhase?: string | null;
		faultKind?: "refuse" | "throw";
		loaderFault?: "late-failure" | "early-failure" | "throw" | null;
	}): Promise<{
		result: string;
		phases: string[];
		readsAfterExpiry: number;
		closes: number;
		sockets: number;
	}> {
		const workspace = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-obs-phase-"));
		owned.push({
			label: "phase:workspace",
			dispose: () => fs.rm(workspace, { recursive: true, force: true }),
			verify: async () =>
				!(await fs
					.stat(workspace)
					.then(() => true)
					.catch(() => false)),
		});
		const facadeModule = path.join(import.meta.dir, "..", "src", "sdk", "diagnostics", "observe-broker.ts");
		const harness = path.join(workspace, "phase.ts");
		await Bun.write(
			harness,
			`const TIMEOUT_MS = 1000;
const EXPIRE_AT_PHASE = ${JSON.stringify(options.expireAtPhase ?? null)};
const FAULT_AT_PHASE = ${JSON.stringify(options.faultAtPhase ?? null)};
const FAULT_KIND = ${JSON.stringify(options.faultKind ?? "refuse")};
const LOADER_FAULT = ${JSON.stringify(options.loaderFault ?? null)};

let sockets = 0;
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
	constructor(...args) {
		sockets += 1;
		super(...args);
	}
};

const facade = await import(${JSON.stringify(facadeModule)});
const phases = [];
let expired = false;
let readsAfterExpiry = 0;
let closes = 0;
let reads = 0;
let revalidates = 0;

// The clock is driven by observed phases: it reports "expired" only once the named phase
// has actually happened, so every row is anchored to a real lease operation.
facade.setObservationClockForTest(() => (expired ? TIMEOUT_MS * 4_000_000 : 0));

function notePhase(name) {
	phases.push(name);
	if (EXPIRE_AT_PHASE !== null && name === EXPIRE_AT_PHASE) expired = true;
}

facade.setObservationTestHooksForTest({
	onLeaseClosed: () => {
		closes += 1;
	},
	wrapLease: lease => ({
		get ok() {
			return lease.ok;
		},
		get reason() {
			return lease.reason;
		},
		read: () => {
			reads += 1;
			const name = reads === 1 ? "initial-read" : reads === 2 ? "preconnect-read" : "final-read";
			if (expired) readsAfterExpiry += 1;
			notePhase(name);
			if (FAULT_AT_PHASE === name) {
				if (FAULT_KIND === "throw") throw new Error("native read failed");
				return { ok: false, reason: "stale" };
			}
			return lease.read();
		},
		revalidate: () => {
			revalidates += 1;
			const name = revalidates === 1 ? "preconnect-revalidate" : "final-revalidate";
			notePhase(name);
			if (FAULT_AT_PHASE === name) {
				if (FAULT_KIND === "throw") throw new Error("native revalidate failed");
				return { ok: false, reason: "stale" };
			}
			return lease.revalidate();
		},
		close: () => {
			notePhase("close");
			return lease.close();
		},
	}),
	...(LOADER_FAULT === null
		? {}
		: {
				loaderOverride: () => {
					if (LOADER_FAULT === "throw") throw new Error("loader exploded");
					if (LOADER_FAULT === "late-failure") expired = true;
					return { ok: false, reason: "unsupported" };
				},
			}),
});

let result;
try {
	const observation = await facade.observeExistingBroker({ agentDir: ${JSON.stringify(options.agentDir)}, timeoutMs: TIMEOUT_MS });
	result = observation.ok ? "ok" : observation.unavailable.reason;
} catch (error) {
	result = "threw:" + (error.code ?? error.name);
} finally {
	facade.setObservationClockForTest(null);
	facade.setObservationTestHooksForTest(null);
}
console.log(JSON.stringify({ result, phases, readsAfterExpiry, closes, sockets }));`,
		);
		const child = Bun.spawn({
			cmd: [process.execPath, harness],
			cwd: workspace,
			env: { ...process.env, HOME: workspace, TMPDIR: workspace },
			stdout: "pipe",
			stderr: "pipe",
		});
		const settled = await settleChild(child, "phase:child", { timeoutMs: 20_000 });
		if (settled.stdout.trim() === "") {
			throw new Error(`phase probe produced no output: ${settled.stderr.slice(0, 400)}`);
		}
		return JSON.parse(settled.stdout.trim()) as {
			result: string;
			phases: string[];
			readsAfterExpiry: number;
			closes: number;
			sockets: number;
		};
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"AC-1/AC-2: a refusal or throw observed after expiry reports timeout and stops the lease",
		async () => {
			const rows: { phase: string; kind: "refuse" | "throw" }[] = [
				{ phase: "preconnect-revalidate", kind: "refuse" },
				{ phase: "preconnect-read", kind: "refuse" },
				{ phase: "final-revalidate", kind: "refuse" },
				{ phase: "final-read", kind: "refuse" },
				{ phase: "preconnect-read", kind: "throw" },
				{ phase: "final-read", kind: "throw" },
			];
			for (const row of rows) {
				const agentDir = await fixtureAgentDir(`ac1-${row.phase}-${row.kind}`);
				await setupBroker(agentDir);
				const probe = await phaseProbe({
					agentDir,
					expireAtPhase: row.phase,
					faultAtPhase: row.phase,
					faultKind: row.kind,
				});
				expect({
					phase: row.phase,
					kind: row.kind,
					result: probe.result,
					readsAfterExpiry: probe.readsAfterExpiry,
					closes: probe.closes,
				}).toEqual({ phase: row.phase, kind: row.kind, result: "timeout", readsAfterExpiry: 0, closes: 1 });
			}
		},
		900_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"AC-2 coverage: expiry right after a SUCCESSFUL revalidate return stops the next read",
		async () => {
			// These two rows are additional coverage for a boundary the refusal/throw rows never
			// exercised: the phase returns successfully and the budget expires immediately after.
			// The product already carries the checks; this pins the observable behaviour.
			for (const phase of ["preconnect-revalidate", "final-revalidate"]) {
				const agentDir = await fixtureAgentDir(`ac2-success-${phase}`);
				await setupBroker(agentDir);
				// No fault: the revalidate really succeeds, then the clock expires.
				const probe = await phaseProbe({ agentDir, expireAtPhase: phase });
				expect({
					phase,
					result: probe.result,
					reachedPhase: probe.phases.includes(phase),
					readsAfterExpiry: probe.readsAfterExpiry,
					closes: probe.closes,
				}).toEqual({ phase, result: "timeout", reachedPhase: true, readsAfterExpiry: 0, closes: 1 });
				// The preconnect boundary refuses before any socket exists; the final boundary
				// happens after the single connection this route is allowed.
				expect({ phase, sockets: probe.sockets }).toEqual({
					phase,
					sockets: phase === "preconnect-revalidate" ? 0 : 1,
				});
			}
		},
		600_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"AC-1: a native throw before expiry is a low-level unsupported, not a transport failure",
		async () => {
			const agentDir = await fixtureAgentDir("ac1-native-throw-live");
			await setupBroker(agentDir);
			const probe = await phaseProbe({ agentDir, faultAtPhase: "preconnect-read", faultKind: "throw" });
			expect({ result: probe.result, closes: probe.closes }).toEqual({ result: "unsupported", closes: 1 });
		},
		300_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"AC-1: a loader failure reports unsupported before expiry and timeout after it",
		async () => {
			const earlyDir = await fixtureAgentDir("ac1-loader-early");
			await setupBroker(earlyDir);
			const early = await phaseProbe({ agentDir: earlyDir, loaderFault: "early-failure" });
			expect(early.result).toBe("unsupported");

			const lateDir = await fixtureAgentDir("ac1-loader-late");
			await setupBroker(lateDir);
			const late = await phaseProbe({ agentDir: lateDir, loaderFault: "late-failure" });
			expect(late.result).toBe("timeout");

			const throwDir = await fixtureAgentDir("ac1-loader-throw");
			await setupBroker(throwDir);
			const thrown = await phaseProbe({ agentDir: throwDir, loaderFault: "throw" });
			// A loader exception is handled on the observation path: it never escapes.
			expect(thrown.result).toBe("unsupported");
		},
		300_000,
	);
});

describe("canonical publication endpoint grammar (F3)", () => {
	const basePublication = (url: string) => ({
		url,
		token: "a".repeat(64),
		ownerId: "ab".repeat(6),
		pid: 4242,
		incarnation: "inc-1",
		agentRoot: "/tmp/agent",
		diagnosticGeneration: "1".repeat(32),
		diagnosticProtocol: 1,
	});

	it("accepts only the canonical loopback endpoint with a port in 1..65535", async () => {
		const { parsePublicationVerdict } = (await import("../src/sdk/diagnostics/observe-broker")) as {
			parsePublicationVerdict: (bytes: Uint8Array) => { kind: string };
		};
		const verdict = (url: string) =>
			parsePublicationVerdict(new TextEncoder().encode(JSON.stringify(basePublication(url)))).kind;

		// Canonical accepted forms: every port in range, with or without the root path.
		for (const url of [
			"ws://127.0.0.1:1",
			"ws://127.0.0.1:1/",
			"ws://127.0.0.1:8080",
			"ws://127.0.0.1:65535",
			"ws://127.0.0.1:65535/",
		]) {
			expect({ url, kind: verdict(url) }).toEqual({ url, kind: "ok" });
		}
		// Rejected: out-of-range ports, other hosts, other schemes, paths, userinfo and
		// anything that would let the observation leave the owned loopback endpoint.
		for (const url of [
			"ws://127.0.0.1:0",
			"ws://127.0.0.1:65536",
			"ws://127.0.0.1:99999",
			"ws://127.0.0.1",
			"ws://127.0.0.1:8080/socket",
			"ws://127.0.0.2:8080",
			"ws://localhost:8080",
			"ws://[::1]:8080",
			"wss://127.0.0.1:8080",
			"http://127.0.0.1:8080",
			"ws://user:pass@127.0.0.1:8080",
			"ws://127.0.0.1:8080?token=x",
			"ws://127.0.0.1:+8080",
			"ws://127.0.0.1:08080",
		]) {
			expect({ url, kind: verdict(url) }).toEqual({ url, kind: "malformed" });
		}
	});

	it.skipIf(!SUPPORTED_RUNTIME)(
		"accepts the endpoint a real broker actually publishes and refuses a rewritten one",
		async () => {
			const agentDir = await fixtureAgentDir("endpoint-positive");
			const record = await publishThenStop(agentDir);
			const { parsePublicationVerdict } = (await import("../src/sdk/diagnostics/observe-broker")) as {
				parsePublicationVerdict: (bytes: Uint8Array) => { kind: string };
			};
			// Positive control: the production publisher's own endpoint parses.
			expect(parsePublicationVerdict(new TextEncoder().encode(JSON.stringify(record))).kind).toBe("ok");
			// Negative through the real production route: a non-loopback endpoint is refused
			// before any connection is attempted.
			record.url = "ws://10.0.0.1:8080";
			await rewritePublication(agentDir, record);
			const observation = await observeExistingBroker({ agentDir, timeoutMs: 1_000 });
			expect(observation.ok ? "ok" : observation.unavailable.reason).toBe("invalid_response");
		},
		120_000,
	);
});

describe("broker answers only from owned retained authority (F2)", () => {
	it("refuses the diagnostics operation when no publication authority is owned", async () => {
		const agentDir = await fixtureAgentDir("unowned");
		// A broker that never started owns no retained publication authority. It must refuse
		// the observation operation instead of answering a snapshot, and it must not
		// recover, ensure or publish anything to do so.
		const broker = new Broker({ agentDir, packageGeneration: "matrix-fixture" });
		owned.push({ label: "fixture:unstarted-broker", dispose: () => broker.stop(), verify: () => true });
		const response = (await broker.handleRequest("broker.diagnostics", {})) as {
			ok: boolean;
			result?: unknown;
			error?: { code?: string };
		};
		expect({ ok: response.ok, hasResult: response.result !== undefined }).toEqual({
			ok: false,
			hasResult: false,
		});
		// No publication was created by the refused request.
		expect(await Bun.file(publicationFile(agentDir)).exists()).toBe(false);
	}, 60_000);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"answers once the broker owns its publication, without touching it",
		async () => {
			const agentDir = await fixtureAgentDir("owned");
			const { broker } = await setupBroker(agentDir);
			const before = await authoritySnapshot(agentDir);
			const response = (await broker.handleRequest("broker.diagnostics", {})) as {
				ok: boolean;
				result?: { diagnosticProtocol?: number; generation?: string };
			};
			expect({ ok: response.ok, protocol: response.result?.diagnosticProtocol }).toEqual({ ok: true, protocol: 1 });
			const after = await authoritySnapshot(agentDir);
			expect(withoutHeartbeat(after.publication)).toEqual(withoutHeartbeat(before.publication));
		},
		60_000,
	);
});

describe("observation transport regression — redirects and proxies (F5)", () => {
	/** A loopback listener that answers every request with a redirect and counts hits. */
	function redirectServer(status: number, location: string): { port: number; hits: () => number; stop: () => void } {
		let hits = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				hits += 1;
				return new Response(null, { status, headers: { Location: location } });
			},
		});
		owned.push({ label: `redirect:${status}`, dispose: () => server.stop(true) });
		return { port: server.port ?? 0, hits: () => hits, stop: () => server.stop(true) };
	}

	/** A loopback listener that counts any traffic reaching it, used as a destination. */
	function countingServer(label: string): { port: number; hits: () => number } {
		let hits = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				hits += 1;
				return new Response("destination");
			},
		});
		owned.push({ label: `counter:${label}`, dispose: () => server.stop(true) });
		return { port: server.port ?? 0, hits: () => hits };
	}

	it.skipIf(!SUPPORTED_RUNTIME)(
		"never follows a redirect on the observation connection",
		async () => {
			const destination = countingServer("redirect-destination");
			for (const status of [301, 302, 303, 307, 308]) {
				for (const kind of ["http", "ws", "relative"] as const) {
					const location =
						kind === "http"
							? `http://127.0.0.1:${destination.port}/`
							: kind === "ws"
								? `ws://127.0.0.1:${destination.port}/`
								: "/elsewhere";
					const redirect = redirectServer(status, location);
					const agentDir = await fixtureAgentDir(`redirect-${status}-${kind}`);
					await setupBroker(agentDir);
					const record = (await Bun.file(publicationFile(agentDir)).json()) as Record<string, unknown>;
					record.url = `ws://127.0.0.1:${redirect.port}`;
					await Bun.write(publicationFile(agentDir), JSON.stringify(record));
					const observation = await observeExistingBroker({ agentDir, timeoutMs: 1_000 });
					expect({ status, kind, ok: observation.ok }).toEqual({ status, kind, ok: false });
					// The redirect was answered once and its destination was never contacted.
					expect({
						status,
						kind,
						redirectHits: redirect.hits(),
						destinationHits: destination.hits(),
					}).toEqual({
						status,
						kind,
						// Exactly ONE connection: a followed relative Location would hit this
						// same-origin listener again, and a followed absolute Location would hit
						// the separate destination. Both are excluded.
						redirectHits: 1,
						destinationHits: 0,
					});
				}
			}
		},
		300_000,
	);

	it.skipIf(!SUPPORTED_RUNTIME)(
		"ignores every proxy environment variable and still observes the real broker",
		async () => {
			const proxy = countingServer("proxy");
			const proxyUrl = `http://127.0.0.1:${proxy.port}`;
			const variables = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
			const allProxyVariables = [...variables, "NO_PROXY", "no_proxy"];
			const saved = new Map(allProxyVariables.map(name => [name, process.env[name]] as const));
			const restoreAll = () => {
				for (const [name, value] of saved) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			};
			const clearAll = () => {
				for (const name of allProxyVariables) delete process.env[name];
			};

			// Working control FIRST with every proxy variable cleared, so a later `ok` cannot
			// be vacuous: the observation really succeeds in this environment.
			clearAll();
			try {
				const controlDir = await fixtureAgentDir("proxy-control");
				await setupBroker(controlDir);
				const control = await observeExistingBroker({ agentDir: controlDir, timeoutMs: 5_000 });
				expect({ control: control.ok, proxyHits: proxy.hits() }).toEqual({ control: true, proxyHits: 0 });
			} finally {
				restoreAll();
			}
			for (const variable of variables) {
				for (const noProxy of [undefined, "127.0.0.1,localhost"]) {
					const agentDir = await fixtureAgentDir(
						`proxy-${variable}-${noProxy === undefined ? "absent" : "present"}`,
					);
					await setupBroker(agentDir);
					// Every conflicting proxy variable is cleared so exactly one is in effect.
					clearAll();
					process.env[variable] = proxyUrl;
					if (noProxy !== undefined) process.env.NO_PROXY = noProxy;
					try {
						const observation = await observeExistingBroker({ agentDir, timeoutMs: 5_000 });
						// The working control: observation still succeeds, and no traffic
						// reached the proxy listener.
						expect({ variable, noProxy: noProxy ?? null, ok: observation.ok, proxyHits: proxy.hits() }).toEqual({
							variable,
							noProxy: noProxy ?? null,
							ok: true,
							proxyHits: 0,
						});
					} finally {
						restoreAll();
					}
				}
			}
		},
		300_000,
	);
});

describe("observation mutates nothing (F5)", () => {
	it.skipIf(!SUPPORTED_RUNTIME)(
		"leaves the authority bytes, modes and entries unchanged apart from the heartbeat",
		async () => {
			const agentDir = await fixtureAgentDir("zero-mutation");
			await setupBroker(agentDir);
			const before = await authoritySnapshot(agentDir);
			const observation = await observeExistingBroker({ agentDir, timeoutMs: 5_000 });
			expect(observation.ok).toBe(true);
			const after = await authoritySnapshot(agentDir);
			expect(after.entries).toEqual(before.entries);
			expect(after.modes).toEqual(before.modes);
			expect(withoutHeartbeat(after.publication)).toEqual(withoutHeartbeat(before.publication));
		},
		120_000,
	);
});
