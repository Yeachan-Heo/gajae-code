/**
 * ACP `session/delete` wire oracle — a real child process over stdio.
 *
 * Spawns `bun packages/coding-agent/src/cli.ts --mode acp --no-extensions`
 * with stdin/stdout pipes and a sanitized, explicitly-owned child environment
 * that NEVER spreads `process.env`. Every HOME/XDG/cache/state/runtime/tmp/agent
 * dir is owned by the test and rooted under an isolated temp root, so session
 * transcripts and artifacts never land in the developer's real `~/.gjc`.
 *
 * Over the public SDK 1.2.1 surface (`ClientSideConnection` / `ndJsonStream`)
 * this proves the full lifecycle against a real subprocess: capability
 * advertisement → create → explicit scoped list → artifact creation → delete →
 * post-delete list absence → transcript/artifact absence → repeat-delete no-op
 * `{}` → unknown-delete no-op `{}`. Strict unit tests in `acp-agent.test.ts`
 * remain the authority proof for the duplicate/identity/close-state edge cases.
 *
 * No process-global env mutation, no gates/formatters/commits/pushes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import {
	cleanupFixtureRoots,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

/** Minimal host→client callback impl for the SDK callbacks. */
class OracleClient implements Client {
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(_params: SessionNotification): Promise<void> {}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "oracle-terminal" };
	}
}

type AcpProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cleanupRoots: FixtureRootCleanup[] = [];
/** Bounded stderr retention cap (bytes) kept for failure diagnostics. */
const STDERR_CAP = 64 * 1024;

/** Wrap the child's stdin sink as a `WritableStream` for `ndJsonStream`. */
function subprocessInput(proc: AcpProc): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
		close() {
			proc.stdin.end();
		},
		abort() {
			proc.stdin.end();
		},
	});
}

/**
 * Deterministic teardown: close stdin, give the child a short grace window to
 * shut down on its own, then SIGKILL. Unlike a plain race-timeout this MUST
 * confirm the child actually exited after SIGKILL — if it is somehow still
 * alive the teardown fails fast with bounded stderr diagnostics rather than
 * orphaning a live child under `rm -rf` cleanup. Only once exit is confirmed
 * (and stderr fully drained) may the caller remove the owned root.
 */
async function teardown(oracle: Oracle): Promise<void> {
	const { proc } = oracle;
	try {
		proc.stdin.end();
	} catch {
		// already closed
	}
	// Grace window for an orderly shutdown after the stdin EOF.
	const graceful = await Promise.race([proc.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
	if (!graceful) {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already exited between the liveness check and the kill
		}
	}
	// Confirm exit — no silent race-timeout here. SIGKILL is uninterruptible, so
	// a child still alive past this bounded wait indicates a kernel-level stuck
	// state; surface it with stderr rather than dropping a live child.
	const confirmed = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
	if (!confirmed) {
		throw new Error(
			`ACP subprocess did not exit after SIGKILL; refusing to remove owned root.\n[child stderr tail]\n${oracle.stderrTail()}`,
		);
	}
}

afterEach(async () => {
	await cleanupFixtureRoots(cleanupRoots);
});

/**
 * Explicit minimal environment allowlist. NEVER spreads `process.env`: only
 * `PATH` and the locale/timezone vars (`LANG`/`LC_ALL`/`TZ`) are forwarded, and
 * the locale/timezone vars only "as available" (present and non-empty). `HOME`,
 * `TMPDIR`, every XDG dir, and the agent dirs are owned by the test and rooted
 * under the isolated temp root. This function performs no process-global env
 * mutation — it only constructs and returns a fresh object handed to the child.
 */
function buildChildEnv(root: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: root,
		TMPDIR: path.join(root, "tmp"),
		XDG_DATA_HOME: path.join(root, ".local", "share"),
		XDG_CONFIG_HOME: path.join(root, ".config"),
		XDG_STATE_HOME: path.join(root, ".local", "state"),
		XDG_CACHE_HOME: path.join(root, ".cache"),
		XDG_RUNTIME_DIR: path.join(root, ".run"),
		GJC_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
		const value = process.env[key];
		if (value !== undefined && value !== "") env[key] = value;
	}
	return env;
}

interface Oracle {
	proc: AcpProc;
	connection: ClientSideConnection;
	root: string;
	workspace: string;
	stderrTail: () => string;
	/** Awaits the full stderr drain (after exit) and rejects if the reader failed. */
	drainStderr: () => Promise<void>;
}

/** Spawn the real ACP subprocess and wire the SDK client to its stdio. */
async function spawnOracle(): Promise<Oracle> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-delete-wire-"));
	const env = buildChildEnv(root);

	// Create every owned directory up front so the child finds writable roots.
	const ownedDirs = [
		env.HOME,
		env.TMPDIR,
		env.XDG_DATA_HOME,
		env.XDG_CONFIG_HOME,
		env.XDG_STATE_HOME,
		env.XDG_CACHE_HOME,
		env.XDG_RUNTIME_DIR,
		env.GJC_CODING_AGENT_DIR,
	];
	await Promise.all(ownedDirs.map(dir => fs.promises.mkdir(dir, { recursive: true })));

	const workspace = path.join(root, "workspace");
	await fs.promises.mkdir(workspace, { recursive: true });

	const agentDir = path.join(root, "agent");
	const started = await withFixtureBrokerEnvironment(() => startFixtureBrokerWithLeaseForTest({ agentDir, env }));
	const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
	cleanupRoots.push(cleanup);

	const proc = Bun.spawn(["bun", "packages/coding-agent/src/cli.ts", "--mode", "acp", "--no-extensions"], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	// Bounded stderr capture: keep draining (so the pipe never blocks the child)
	// while retaining only the last STDERR_CAP bytes for failure diagnostics.
	// `stderrDrain` resolves only once the child's stderr fd closes (after exit),
	// so teardown can await a complete drain before removing the owned root.
	let stderrBuf = "";
	let stderrError: unknown;
	const stderrDrain = (async () => {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) {
					stderrBuf += decoder.decode(value, { stream: true });
					if (stderrBuf.length > STDERR_CAP) {
						stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_CAP);
					}
				}
			}
		} catch (error) {
			// Retain the reader/drain failure to surface it after confirmed child
			// exit. Never swallow it as success: teardown awaits this drain only
			// after the child has exited, then rethrows so the test fails instead
			// of orphaning cleanup under rm -rf.
			stderrError = error;
		}
	})();

	const connection = new ClientSideConnection(
		() => new OracleClient(),
		ndJsonStream(subprocessInput(proc), proc.stdout),
	);

	const oracle: Oracle = {
		proc,
		connection,
		root,
		workspace,
		stderrTail: () => stderrBuf,
		drainStderr: async () => {
			// Await the full drain first; teardown calls this only after the child
			// has confirmed exit. Then surface a retained reader/drain failure so a
			// broken stderr pipe fails the test (and blocks root removal) instead of
			// being silently swallowed.
			await stderrDrain;
			if (stderrError !== undefined) {
				const tail = stderrBuf.trim();
				const readerMessage = stderrError instanceof Error ? stderrError.message : String(stderrError);
				throw new Error(
					`stderr reader/drain failed after confirmed child exit; refusing to remove owned root.\n[reader error]\n${readerMessage}${tail ? `\n[child stderr tail]\n${tail}` : ""}`,
				);
			}
		},
	};
	registerFixtureRuntime(cleanup, {
		key: "acp-subprocess",
		requiredOwner: "runtime-and-broker",
		shutdown: () => teardown(oracle),
		dispose: () => oracle.drainStderr(),
	});
	return oracle;
}

/** Re-throw an error annotated with the captured child stderr tail. */
function rethrowWithStderr(oracle: Oracle, error: unknown): never {
	const tail = oracle.stderrTail().trim();
	const message = error instanceof Error ? error.message : String(error);
	const note = tail ? `\n[child stderr tail]\n${tail}` : "";
	throw new Error(`${message}${note}`);
}

describe("ACP session/delete wire oracle (real subprocess stdio)", () => {
	it("advertises sessionCapabilities.delete and .list over a real subprocess link", async () => {
		const oracle = await spawnOracle();
		try {
			const initialized = await oracle.connection.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
			});
			expect(initialized.agentCapabilities?.sessionCapabilities?.delete).toEqual({});
			expect(initialized.agentCapabilities?.sessionCapabilities?.list).toEqual({});
		} catch (error) {
			rethrowWithStderr(oracle, error);
		}
	}, 60_000);

	it("create → list → artifact → delete → absence → repeat/unknown no-op over stdio", async () => {
		const oracle = await spawnOracle();
		const { connection, workspace, root } = oracle;
		try {
			await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

			// Create a session.
			const created = await connection.newSession({ cwd: workspace, mcpServers: [] });
			const sessionId = created.sessionId;
			expect(typeof sessionId).toBe("string");
			expect(sessionId.length).toBeGreaterThan(0);

			// Explicit scoped list includes the new session.
			const listBefore = await connection.listSessions({ cwd: workspace });
			expect(listBefore.sessions.map(session => session.sessionId)).toContain(sessionId);

			// Exactly one persisted session transcript exists; broker index logs are not transcripts.
			const transcripts = await Array.fromAsync(
				new Bun.Glob("**/*.jsonl").scan({
					cwd: path.join(root, "agent", "sessions"),
					absolute: true,
					onlyFiles: true,
				}),
			);
			expect(transcripts).toHaveLength(1);
			const sessionPath = transcripts[0]!;

			// Artifact creation in the sibling artifacts directory (strip ".jsonl").
			const artifactsDir = sessionPath.slice(0, -6);
			await fs.promises.mkdir(artifactsDir, { recursive: true });
			const artifactPath = path.join(artifactsDir, "oracle.txt");
			await fs.promises.writeFile(artifactPath, "artifact");
			expect(fs.existsSync(artifactPath)).toBe(true);

			// Delete it.
			const deleteResult = await connection.deleteSession({ sessionId });
			expect(deleteResult).toEqual({});

			// Post-delete scoped list no longer includes it.
			const listAfter = await connection.listSessions({ cwd: workspace });
			expect(listAfter.sessions.map(session => session.sessionId)).not.toContain(sessionId);

			// Transcript and its artifacts directory (and artifact) are gone.
			expect(fs.existsSync(sessionPath)).toBe(false);
			expect(fs.existsSync(artifactsDir)).toBe(false);
			expect(fs.existsSync(artifactPath)).toBe(false);

			// Repeat delete of the now-absent id is a no-op {}.
			const repeatDelete = await connection.deleteSession({ sessionId });
			expect(repeatDelete).toEqual({});

			// Delete of an id that never existed is also {}.
			const unknownDelete = await connection.deleteSession({ sessionId: "never-existed" });
			expect(unknownDelete).toEqual({});
		} catch (error) {
			rethrowWithStderr(oracle, error);
		}
	}, 60_000);
});
