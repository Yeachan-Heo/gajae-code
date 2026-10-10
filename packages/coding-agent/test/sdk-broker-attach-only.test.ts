import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PublicCommandFailure } from "../src/cli/public-command-errors";
import * as discoveryModule from "../src/sdk/broker/discovery";
import { brokerDiscoveryPath, readBrokerDiscovery } from "../src/sdk/broker/discovery";
import {
	brokerOwnerForTest,
	ensureBroker,
	type FixtureBrokerLease,
	isBrokerAttachOnly,
	SDK_BROKER_AUTOSTART_ENV,
	startFixtureBrokerWithLeaseForTest,
} from "../src/sdk/broker/ensure";
import { runSdkSessionCli, type SdkSessionCliArgs } from "../src/sdk/cli/session-cli";
import { SdkClientError } from "../src/sdk/client/client";
import { AgentDirSessionLifecycleClient, dispatchSpawnGlobal } from "../src/sdk/lifecycle/broker-client";
import { createSdkMcpServer } from "../src/sdk/mcp/server";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const roots: string[] = [];
const leases: FixtureBrokerLease[] = [];
let priorAutostart: string | undefined;

beforeEach(() => {
	priorAutostart = process.env[SDK_BROKER_AUTOSTART_ENV];
});

afterEach(async () => {
	if (priorAutostart === undefined) delete process.env[SDK_BROKER_AUTOSTART_ENV];
	else process.env[SDK_BROKER_AUTOSTART_ENV] = priorAutostart;
	for (const lease of leases.splice(0)) await lease.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function agentDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-attach-only-"));
	roots.push(root);
	const dir = path.join(root, "agent");
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

async function writeDiscovery(dir: string, overrides: Record<string, unknown>): Promise<void> {
	const file = brokerDiscoveryPath(dir);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(
		file,
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			host: "127.0.0.1",
			port: 1,
			token: "t",
			pid: process.pid,
			incarnation: "not-this-process",
			heartbeatAt: Date.now(),
			...overrides,
		}),
	);
}

async function expectUnavailableWithoutSpawn(dir: string): Promise<void> {
	const spawnSpy = spyOn(childProcess, "spawn");
	try {
		const error = await ensureBroker({ agentDir: dir }).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(SdkClientError);
		expect((error as SdkClientError).code).toBe("broker_unavailable");
		expect(spawnSpy).toHaveBeenCalledTimes(0);
	} finally {
		spawnSpy.mockRestore();
	}
}

it("reads attach-only mode only from the exact value 0", () => {
	expect(isBrokerAttachOnly({ [SDK_BROKER_AUTOSTART_ENV]: "0" })).toBe(true);
	expect(isBrokerAttachOnly({ [SDK_BROKER_AUTOSTART_ENV]: "1" })).toBe(false);
	expect(isBrokerAttachOnly({ [SDK_BROKER_AUTOSTART_ENV]: "" })).toBe(false);
	expect(isBrokerAttachOnly({})).toBe(false);
});

it("refuses without spawning when discovery is absent", async () => {
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	await expectUnavailableWithoutSpawn(await agentDir());
});

it("refuses without spawning when the discovery owner pid is dead", async () => {
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	const dir = await agentDir();
	await writeDiscovery(dir, { pid: 2_147_483_646 });
	await expectUnavailableWithoutSpawn(dir);
});

it("refuses without spawning when the discovery heartbeat is stale", async () => {
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	const dir = await agentDir();
	await writeDiscovery(dir, { heartbeatAt: 0 });
	await expectUnavailableWithoutSpawn(dir);
});

it("attaches to a live broker and re-attaches without spawning after it is gone", async () => {
	const dir = await agentDir();
	const started = await startFixtureBrokerWithLeaseForTest({ agentDir: dir });
	leases.push(started.lease);
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	const spawnSpy = spyOn(childProcess, "spawn");
	try {
		const attached = await ensureBroker({ agentDir: dir });
		expect(attached.pid).toBe(started.discovery.pid);
		expect(attached.incarnation).toBe(started.discovery.incarnation);
		expect(spawnSpy).toHaveBeenCalledTimes(0);
	} finally {
		spawnSpy.mockRestore();
	}
	await started.lease.close();
	await expectUnavailableWithoutSpawn(dir);
});

it("keeps autostart when the variable is unset", async () => {
	delete process.env[SDK_BROKER_AUTOSTART_ENV];
	const dir = await agentDir();
	const spawnSpy = spyOn(childProcess, "spawn");
	try {
		const discovery = await ensureBroker({ agentDir: dir });
		expect(spawnSpy).toHaveBeenCalled();
		expect((await readBrokerDiscovery(dir))?.pid).toBe(discovery.pid);
	} finally {
		spawnSpy.mockRestore();
		await brokerOwnerForTest(path.resolve(dir))?.stop();
	}
});

async function runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<{ output: string; exitCode: number }> {
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, ...argv], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { output: `${stdout}${stderr}`, exitCode };
}

async function expectNoBrokerArtifacts(dir: string): Promise<void> {
	expect(await readBrokerDiscovery(dir)).toBeNull();
	const sdkDir = path.join(dir, "sdk");
	const entries = await fs.readdir(sdkDir).catch(() => [] as string[]);
	expect(entries.filter(name => name.startsWith("broker-spawn"))).toEqual([]);
}

const SESSION_ID = "01a00000-0000-7000-8000-000000000000";
const PUBLIC_BROKER_CALLERS: Array<{ name: string; argv: (dir: string) => string[] }> = [
	{ name: "session list", argv: dir => ["sdk", "session", "list", "--agent-dir", dir, "--json"] },
	{ name: "session inspect", argv: dir => ["sdk", "session", "inspect", SESSION_ID, "--agent-dir", dir, "--json"] },
	{
		name: "session status",
		argv: dir => ["sdk", "session", "status", SESSION_ID, "op-ref-1", "--agent-dir", dir, "--json"],
	},
	{
		name: "session send",
		argv: dir => ["sdk", "session", "send", SESSION_ID, "--text", "hi", "--agent-dir", dir, "--json"],
	},
	{
		name: "session raw query",
		argv: dir => [
			"sdk",
			"session",
			"raw",
			"query",
			SESSION_ID,
			"--query",
			"transcript.list",
			"--agent-dir",
			dir,
			"--json",
		],
	},
	{
		name: "session raw global",
		argv: dir => ["sdk", "session", "raw", "global", "--op", "session.list", "--agent-dir", dir, "--json"],
	},
	{
		name: "session raw control",
		argv: dir => [
			"sdk",
			"session",
			"raw",
			"control",
			SESSION_ID,
			"--op",
			"turn.prompt",
			"--json-input",
			'{"text":"hi"}',
			"--agent-dir",
			dir,
			"--json",
		],
	},
	{ name: "search", argv: dir => ["sdk", "search", "--scope", "global", "--agent-dir", dir, "--json"] },
];

for (const caller of PUBLIC_BROKER_CALLERS) {
	it(`public ${caller.name} with ${SDK_BROKER_AUTOSTART_ENV}=0 refuses with broker_unavailable and spawns nothing`, async () => {
		const dir = await agentDir();
		const result = await runCli(caller.argv(dir), { ...process.env, [SDK_BROKER_AUTOSTART_ENV]: "0" });
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("broker_unavailable");
		await expectNoBrokerArtifacts(dir);
	});
}

it("the --attach-only flag is equivalent to the environment variable", async () => {
	const dir = await agentDir();
	const env = { ...process.env };
	delete env[SDK_BROKER_AUTOSTART_ENV];
	const result = await runCli(["sdk", "session", "list", "--attach-only", "--agent-dir", dir, "--json"], env);
	expect(result.exitCode).not.toBe(0);
	expect(result.output).toContain("broker_unavailable");
	await expectNoBrokerArtifacts(dir);
});

it("the SDK MCP tools refuse without spawning, attach when live, and refuse again after the broker dies", async () => {
	const dir = await agentDir();
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	const spawnSpy = spyOn(childProcess, "spawn");
	const server = createSdkMcpServer({ agentDir: dir });
	try {
		for (const call of [
			() => server.callTool("gjc_session_list"),
			() => server.callTool("gjc_session_global", { operation: "session.list" }),
		]) {
			expect(await call()).toMatchObject({ ok: false, error: { code: "broker_unavailable" } });
		}
		expect(spawnSpy).toHaveBeenCalledTimes(0);
	} finally {
		spawnSpy.mockRestore();
	}

	delete process.env[SDK_BROKER_AUTOSTART_ENV];
	const started = await startFixtureBrokerWithLeaseForTest({ agentDir: dir });
	leases.push(started.lease);
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	const liveSpy = spyOn(childProcess, "spawn");
	try {
		expect(await server.callTool("gjc_session_list")).not.toMatchObject({ error: { code: "broker_unavailable" } });
		// Re-entry after the broker that was live at the last read dies.
		await started.lease.close();
		expect(await server.callTool("gjc_session_list")).toMatchObject({
			ok: false,
			error: { code: "broker_unavailable" },
		});
		expect(liveSpy).toHaveBeenCalledTimes(0);
	} finally {
		liveSpy.mockRestore();
		await server.close();
	}
});

it("the lifecycle client and spawn dispatch refuse without spawning", async () => {
	const dir = await agentDir();
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	const spawnSpy = spyOn(childProcess, "spawn");
	try {
		for (const call of [
			() => new AgentDirSessionLifecycleClient(dir).global("session.list", {}, {}),
			() => dispatchSpawnGlobal(dir, {}, "attach-only-key", 1_000),
		]) {
			const error = await call().then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(SdkClientError);
			expect((error as SdkClientError).code).toBe("broker_unavailable");
		}
		expect(spawnSpy).toHaveBeenCalledTimes(0);
	} finally {
		spawnSpy.mockRestore();
	}
	await expectNoBrokerArtifacts(dir);
});

type DiscoveryState = { name: string; prepare: (dir: string) => Promise<void> };
const UNAVAILABLE_STATES: DiscoveryState[] = [
	{ name: "absent", prepare: async () => {} },
	{ name: "pid-dead", prepare: dir => writeDiscovery(dir, { pid: 2_147_483_646 }) },
	{ name: "stale", prepare: dir => writeDiscovery(dir, { heartbeatAt: 0 }) },
];

async function sessionCliOutcome(args: SdkSessionCliArgs): Promise<string> {
	const outputs: unknown[] = [];
	const thrown = await runSdkSessionCli(
		args,
		value => outputs.push(value),
		() => {},
	).then(
		() => undefined,
		(caught: unknown) => caught,
	);
	const failure = thrown instanceof PublicCommandFailure ? thrown.input : thrown;
	return JSON.stringify({ failure, outputs });
}

async function rejectionCode(call: () => Promise<unknown>): Promise<string> {
	const thrown = await call().then(
		() => undefined,
		(caught: unknown) => caught,
	);
	return thrown instanceof SdkClientError ? thrown.code : `not an SdkClientError: ${String(thrown)}`;
}

/** Every ensureBroker call site, invoked in-process so the spawn spy observes it. */
const IN_PROCESS_CALLERS: Array<{ site: string; outcome: (dir: string) => Promise<string> }> = [
	{ site: "session-cli sessionRows", outcome: dir => sessionCliOutcome({ action: "list", agentDir: dir }) },
	{
		site: "session-cli runSend",
		outcome: dir => sessionCliOutcome({ action: "send", sessionId: SESSION_ID, text: "hi", agentDir: dir }),
	},
	{
		site: "session-cli runStatus",
		outcome: dir => sessionCliOutcome({ action: "status", sessionId: SESSION_ID, opRef: "op-ref-1", agentDir: dir }),
	},
	{
		site: "session-cli runRawControl",
		outcome: dir =>
			sessionCliOutcome({
				action: "raw",
				rawAction: "control",
				sessionId: SESSION_ID,
				operation: "turn.prompt",
				jsonInput: '{"text":"hi"}',
				agentDir: dir,
			}),
	},
	{
		site: "session-cli runRawQuery",
		outcome: dir =>
			sessionCliOutcome({
				action: "raw",
				rawAction: "query",
				sessionId: SESSION_ID,
				query: "transcript.list",
				agentDir: dir,
			}),
	},
	{
		site: "session-cli runRawGlobal",
		outcome: dir =>
			sessionCliOutcome({ action: "raw", rawAction: "global", operation: "session.list", agentDir: dir }),
	},
	{
		site: "lifecycle AgentDirSessionLifecycleClient.global",
		outcome: dir => rejectionCode(() => new AgentDirSessionLifecycleClient(dir).global("session.list", {}, {})),
	},
	{
		site: "lifecycle dispatchSpawnGlobal",
		outcome: dir => rejectionCode(() => dispatchSpawnGlobal(dir, {}, "attach-only-key", 1_000)),
	},
	{
		site: "mcp gjc_session_list",
		outcome: async dir => {
			const server = createSdkMcpServer({ agentDir: dir });
			try {
				return JSON.stringify(await server.callTool("gjc_session_list"));
			} finally {
				await server.close();
			}
		},
	},
	{
		site: "mcp gjc_session_global session.list",
		outcome: async dir => {
			const server = createSdkMcpServer({ agentDir: dir });
			try {
				return JSON.stringify(await server.callTool("gjc_session_global", { operation: "session.list" }));
			} finally {
				await server.close();
			}
		},
	},
];

for (const caller of IN_PROCESS_CALLERS) {
	for (const state of UNAVAILABLE_STATES) {
		it(`${caller.site} with ${state.name} discovery reports broker_unavailable and spawns nothing`, async () => {
			const dir = await agentDir();
			await state.prepare(dir);
			process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
			const spawnSpy = spyOn(childProcess, "spawn");
			try {
				expect(await caller.outcome(dir)).toContain("broker_unavailable");
				expect(spawnSpy).toHaveBeenCalledTimes(0);
			} finally {
				spawnSpy.mockRestore();
			}
			expect((await readBrokerDiscovery(dir))?.pid).not.toBe(process.pid);
		});
	}
}

it("re-entry after a failed connection to a discovery that was live when read never spawns", async () => {
	const dir = await agentDir();
	const started = await startFixtureBrokerWithLeaseForTest({ agentDir: dir });
	leases.push(started.lease);
	process.env[SDK_BROKER_AUTOSTART_ENV] = "0";
	const discoveryFile = brokerDiscoveryPath(dir);
	const realRead = discoveryModule.readBrokerDiscovery;
	// During the first invocation every discovery read returns the record that was
	// live at its first read, while the owner dies right after that read and leaves
	// its record behind (as a SIGKILLed broker would). The caller is therefore handed
	// a live discovery and its connection to that endpoint actually fails.
	let liveSnapshot: Awaited<ReturnType<typeof realRead>> | undefined;
	let replaySnapshot = true;
	const readSpy = spyOn(discoveryModule, "readBrokerDiscovery").mockImplementation(async (...args) => {
		if (!replaySnapshot) return await realRead(...args);
		if (liveSnapshot === undefined) {
			liveSnapshot = await realRead(...args);
			const record = await fs.readFile(discoveryFile, "utf8");
			await started.lease.close();
			await Bun.write(discoveryFile, record);
		}
		return liveSnapshot;
	});
	const spawnSpy = spyOn(childProcess, "spawn");
	const server = createSdkMcpServer({ agentDir: dir });
	try {
		const first = await server.callTool("gjc_session_list");
		expect(liveSnapshot?.pid).toBe(started.discovery.pid);
		// A real connection failure, not the missing-discovery short circuit.
		expect(first).toEqual({ ok: false, error: { code: "pre_send", message: "SDK broker connection failed." } });
		replaySnapshot = false;
		// The caller re-enters after the failed connection: still attach-only.
		expect(await server.callTool("gjc_session_list")).toMatchObject({
			ok: false,
			error: { code: "broker_unavailable" },
		});
		expect(await rejectionCode(() => ensureBroker({ agentDir: dir }))).toBe("broker_unavailable");
		expect(spawnSpy).toHaveBeenCalledTimes(0);
	} finally {
		spawnSpy.mockRestore();
		readSpy.mockRestore();
		await server.close();
	}
	// Attach-only never retires: the dead owner's record is left for its supervisor.
	expect(await fs.readFile(discoveryFile, "utf8")).toContain(String(started.discovery.pid));
	expect(await readBrokerDiscovery(dir)).toBeNull();
});
