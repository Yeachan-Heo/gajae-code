/**
 * ACP startup-control provenance wire oracle.
 *
 * The positive case uses the real ACP CLI over stdio and the same-build fixture
 * broker. The focused negative case retains the production-path WebSocket stub
 * style to prove a host that omits startup provenance is rejected precisely.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentSideConnection,
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import { AcpAgent } from "../../src/modes/acp/acp-agent";
import { brokerProcessIncarnation, writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import { startFixtureBrokerWithLeaseForTest } from "../../src/sdk/broker/ensure";
import { SessionIndex } from "../../src/sdk/broker/session-index";
import {
	cleanupFixtureRoots,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "../helpers/fixture-broker-cleanup";

class OracleClient implements Client {
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(): Promise<void> {}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "provenance-oracle-terminal" };
	}
}

type AcpProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cleanupRoots: FixtureRootCleanup[] = [];
const STDERR_CAP = 64 * 1024;

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

/** SIGTERM, then SIGKILL if needed, and never remove an owned root before exit. */
async function teardown(oracle: Oracle): Promise<void> {
	try {
		oracle.proc.stdin.end();
	} catch {
		// stdin was already closed
	}
	const exitedAfterEof = await Promise.race([oracle.proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
	if (!exitedAfterEof) {
		try {
			oracle.proc.kill("SIGTERM");
		} catch {
			// exited between the check and signal
		}
	}
	const exitedAfterTerm = await Promise.race([
		oracle.proc.exited.then(() => true),
		Bun.sleep(2_000).then(() => false),
	]);
	if (!exitedAfterTerm) {
		try {
			oracle.proc.kill("SIGKILL");
		} catch {
			// exited between the check and signal
		}
	}
	const confirmed = await Promise.race([oracle.proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
	if (!confirmed) {
		throw new Error(
			`ACP subprocess did not exit after SIGTERM and SIGKILL; refusing to remove owned root.\n[child stderr tail]\n${oracle.stderrTail()}`,
		);
	}
}

afterEach(async () => {
	await cleanupFixtureRoots(cleanupRoots);
});

/** Explicit child environment allowlist; all stateful locations are test-owned. */
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
	workspace: string;
	stderrTail: () => string;
	drainStderr: () => Promise<void>;
}

async function spawnOracle(): Promise<Oracle> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-acp-provenance-wire-"));
	const env = buildChildEnv(root);
	await Promise.all(
		[
			env.HOME,
			env.TMPDIR,
			env.XDG_DATA_HOME,
			env.XDG_CONFIG_HOME,
			env.XDG_STATE_HOME,
			env.XDG_CACHE_HOME,
			env.XDG_RUNTIME_DIR,
			env.GJC_CODING_AGENT_DIR,
		].map(directory => fsp.mkdir(directory, { recursive: true })),
	);
	const workspace = path.join(root, "workspace");
	await fsp.mkdir(workspace, { recursive: true });

	const agentDir = env.GJC_CODING_AGENT_DIR;
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
	let stderr = "";
	let stderrError: unknown;
	const stderrDrain = (async () => {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				stderr += decoder.decode(value, { stream: true });
				if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
			}
		} catch (error) {
			stderrError = error;
		}
	})();
	const oracle: Oracle = {
		proc,
		connection: new ClientSideConnection(() => new OracleClient(), ndJsonStream(subprocessInput(proc), proc.stdout)),
		workspace,
		stderrTail: () => stderr,
		drainStderr: async () => {
			await stderrDrain;
			if (stderrError !== undefined) throw stderrError;
		},
	};
	registerFixtureRuntime(cleanup, {
		key: "acp-provenance-subprocess",
		requiredOwner: "runtime-and-broker",
		shutdown: () => teardown(oracle),
		dispose: () => oracle.drainStderr(),
	});
	return oracle;
}

function rethrowWithStderr(oracle: Oracle, error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	const tail = oracle.stderrTail().trim();
	throw new Error(`${message}${tail ? `\n[child stderr tail]\n${tail}` : ""}`);
}

describe("ACP startup-control provenance wire oracle", () => {
	it("initializes and creates a session through the same-build broker", async () => {
		const oracle = await spawnOracle();
		try {
			await oracle.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await oracle.connection.newSession({ cwd: oracle.workspace, mcpServers: [] });
			expect(typeof created.sessionId).toBe("string");
			expect(created.sessionId.length).toBeGreaterThan(0);
			expect(oracle.stderrTail()).not.toContain("-32603");
			expect(oracle.stderrTail()).not.toContain("startup control provenance");
		} catch (error) {
			const diagnostic = `${error instanceof Error ? error.message : String(error)}\n${oracle.stderrTail()}`;
			expect(diagnostic).not.toContain("-32603");
			expect(diagnostic).not.toContain("startup control provenance");
			rethrowWithStderr(oracle, error);
		}
	}, 60_000);

	it("rejects a production-path host that omits startup control provenance", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-acp-provenance-stub-"));
		const agentDir = path.join(root, "agent");
		const workspace = path.join(root, "workspace");
		await fsp.mkdir(workspace, { recursive: true });
		const token = "startup-provenance-stub-token";
		const incarnation = brokerProcessIncarnation(process.pid);
		if (!incarnation) throw new Error("Test process incarnation is unavailable.");
		let server!: ReturnType<typeof Bun.serve>;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (frame.type === "broker_request" && frame.operation === "session.create") {
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: {
									sessionId: "missing-provenance",
									endpointGeneration: 1,
									pid: process.pid,
									processIncarnation: incarnation,
									hostIncarnation: incarnation,
									endpointMtimeMs,
									endpoint: {
										sessionId: "missing-provenance",
										pid: process.pid,
										url: `ws://127.0.0.1:${server.port}`,
										token,
									},
								},
							}),
						);
						return;
					}
					if (frame.type === "query_request") {
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								result:
									frame.query === "runtime.capabilities"
										? { promptTerminalOutcomeVersion: 1 }
										: { page: { items: [], complete: true } },
							}),
						);
						return;
					}
					if (frame.type === "broker_request") {
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: {} }));
					}
				},
			},
		});
		const endpointPath = path.join(workspace, ".gjc", "state", "sdk", "missing-provenance.json");
		await fsp.mkdir(path.dirname(endpointPath), { recursive: true });
		await fsp.writeFile(
			endpointPath,
			JSON.stringify({
				sessionId: "missing-provenance",
				pid: process.pid,
				url: `ws://127.0.0.1:${server.port}`,
				token,
			}),
		);
		const endpointMtimeMs = (await fsp.stat(endpointPath)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "missing-provenance",
			locator: { cwd: workspace, worktreeRoot: null, stateRoot: path.join(workspace, ".gjc", "state") },
			endpointGeneration: 1,
			pid: process.pid,
			processIncarnation: incarnation,
			hostIncarnation: incarnation,
			endpointMtimeMs,
		});
		await index.checkpointLiveHeartbeats();
		try {
			await writeBrokerDiscovery(agentDir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: packageJson.version,
				ownerId: "startup-provenance-stub",
				pid: process.pid,
				incarnation,
				host: "127.0.0.1",
				port: server.port!,
				url: `ws://127.0.0.1:${server.port}`,
				token,
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			});
			const abort = new AbortController();
			const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, { agentDir });
			try {
				const rejected = agent.newSession({ cwd: workspace, mcpServers: [] });
				await expect(rejected).rejects.toMatchObject({ code: "unavailable" });
				await expect(rejected).rejects.toThrow("startup control provenance");
			} finally {
				abort.abort();
			}
		} finally {
			server.stop(true);
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});
