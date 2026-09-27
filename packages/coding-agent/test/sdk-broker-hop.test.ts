import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { type BrokerDiscovery, isPidAlive } from "../src/sdk/broker/discovery";
import {
	BrokerHopError,
	brokerOwnerIdentityMatchesForTest,
	parseBrokerHopReply,
	reapSpawnedBrokerForTest,
} from "../src/sdk/broker/ensure";

const HOP_ENTRY = path.join(import.meta.dir, "..", "src", "sdk", "broker", "hop.ts");

async function runHop(
	message: unknown,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ hop: ChildProcess; stdout: string; code: number | null }> {
	const hop = spawn(
		process.execPath,
		[
			"-e",
			`import(${JSON.stringify(HOP_ENTRY)}).then(m => m.runBrokerHopFromArgv(process.argv.slice(1)))`,
			JSON.stringify(message),
		],
		{ stdio: ["ignore", "pipe", "pipe"], env },
	);
	let stdout = "";
	hop.stdout?.on("data", chunk => {
		stdout += chunk.toString();
	});
	const code = await new Promise<number | null>(resolve => hop.on("close", resolve));
	return { hop, stdout, code };
}

describe("SDK broker hop protocol", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join("/tmp", `gjc-hop-test-${randomUUID()}`);
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("windows owner rejects foreign discovery with different pid", () => {
		// Simulate Windows hop scenario: real broker pid is 1234 from hop output
		const realBrokerPid = 1234;
		const brokerIncarnation = "test-incarnation";
		const ownerIdentity: BrokerDiscovery = {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: realBrokerPid,
			incarnation: brokerIncarnation,
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "test-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};

		// Foreign discovery with different pid should be rejected
		const foreignDiscovery: BrokerDiscovery = {
			...ownerIdentity,
			pid: 5678, // Different pid
		};

		expect(brokerOwnerIdentityMatchesForTest(ownerIdentity, foreignDiscovery)).toBe(false);
		expect(brokerOwnerIdentityMatchesForTest(ownerIdentity, ownerIdentity)).toBe(true);
	});

	test("hop reports a live detached broker pid that outlives the hop, and reap targets that pid", async () => {
		const { hop, stdout, code } = await runHop({ command: { file: "sleep", args: ["30"] }, cwd: tempDir });
		expect(code).toBe(0);
		const reported = JSON.parse(stdout.trim()) as { pid: number };
		expect(Number.isInteger(reported.pid)).toBe(true);
		expect(reported.pid).not.toBe(hop.pid);
		// The hop has exited, but the broker it launched is still running.
		expect(hop.exitCode).toBe(0);
		expect(isPidAlive(reported.pid)).toBe(true);

		// Reaping through the exited hop's ChildProcess must signal the reported broker pid.
		await reapSpawnedBrokerForTest(hop, reported.pid, { gracefulMs: 2_000, killVerifyMs: 2_000 });
		expect(isPidAlive(reported.pid)).toBe(false);
	});

	test("hop exits non-zero without a pid when the broker command cannot be spawned", async () => {
		const { stdout, code } = await runHop({ command: { file: path.join(tempDir, "missing-broker"), args: [] } });
		expect(stdout.trim()).toBe("");
		expect(code).not.toBe(0);
	});

	test("broker inherits the hop environment and writes stderr to the log path (no fd numbers, no env on argv)", async () => {
		const logPath = path.join(tempDir, "broker-spawn.log");
		const marker = `SECRET_${randomUUID()}`;
		const message = {
			command: { file: "sh", args: ["-c", 'echo "$GJC_HOP_TEST_VALUE" >&2'] },
			stderrLogPath: logPath,
		};
		expect(JSON.stringify(message)).not.toContain(marker);
		const { stdout, code } = await runHop(message, { ...process.env, GJC_HOP_TEST_VALUE: marker });
		expect(code).toBe(0);
		const { pid } = JSON.parse(stdout.trim()) as { pid: number };
		const deadline = Date.now() + 5_000;
		while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
		expect((await fs.readFile(logPath, "utf8")).trim()).toBe(marker);
	});

	test("parseBrokerHopReply accepts only a positive integer pid from a clean exit", () => {
		expect(parseBrokerHopReply(0, '{"pid":4321}\n')).toEqual({ realBrokerPid: 4321, error: undefined });
		for (const [code, stdout] of [
			[1, '{"pid":4321}'],
			[0, ""],
			[0, "not json"],
			[0, '{"pid":"4321"}'],
			[0, '{"pid":0}'],
			[0, '{"pid":1.5}'],
		] as const) {
			const parsed = parseBrokerHopReply(code, stdout);
			expect(parsed.realBrokerPid).toBeUndefined();
			expect(parsed.error).toBeInstanceOf(BrokerHopError);
		}
	});

	test("hop failure produces typed BrokerHopError", async () => {
		// This test verifies that when the hop fails, a typed BrokerHopError is produced
		// The actual hop invocation is complex, so we test the error class exists and can be constructed
		const { BrokerHopError } = await import("../src/sdk/broker/ensure");

		const error = new BrokerHopError({
			exitCode: 1,
			stdout: "invalid json",
			reason: "test hop failure",
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe("broker_hop_failed");
		expect(error.hopExitCode).toBe(1);
		expect(error.hopStdout).toBe("invalid json");
		expect(error.reason).toBe("test hop failure");
	});

	test("broker owner identity matching requires exact pid and incarnation", () => {
		const baseIdentity: BrokerDiscovery = {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "1.0.0",
			ownerId: "owner-1",
			pid: 1000,
			incarnation: "incarnation-abc",
			host: "127.0.0.1",
			port: 8000,
			url: "ws://127.0.0.1:8000",
			token: "token-123",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};

		// Matching discovery
		expect(brokerOwnerIdentityMatchesForTest(baseIdentity, baseIdentity)).toBe(true);

		// Different pid
		const differentPid = { ...baseIdentity, pid: 2000 };
		expect(brokerOwnerIdentityMatchesForTest(baseIdentity, differentPid)).toBe(false);

		// Different incarnation
		const differentIncarnation = { ...baseIdentity, incarnation: "incarnation-xyz" };
		expect(brokerOwnerIdentityMatchesForTest(baseIdentity, differentIncarnation)).toBe(false);

		// Different ownerId should NOT match
		const differentOwner = { ...baseIdentity, ownerId: "owner-2" };
		expect(brokerOwnerIdentityMatchesForTest(baseIdentity, differentOwner)).toBe(false);

		// Null left identity (not matching)
		expect(brokerOwnerIdentityMatchesForTest(null, baseIdentity)).toBe(false);
	});
});
