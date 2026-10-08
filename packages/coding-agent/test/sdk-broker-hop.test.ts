import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as stream from "node:stream";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { refuseFailedBrokerLaunchForTest } from "../src/sdk/broker/daemon-entry";
import { type BrokerDiscovery, isPidAlive } from "../src/sdk/broker/discovery";
import {
	awaitBrokerLauncherForTest,
	BrokerHopError,
	brokerHopTimeoutResultForTest,
	brokerOwnerIdentityMatchesForTest,
	brokerSpawnFailureErrorForTest,
	brokerStartupExitStatusForTest,
	brokerTrampolineTimeoutResultForTest,
	launchBrokerViaDetachedChild,
	launchBrokerViaHop,
	parseBrokerHopReply,
	reapDetachedBrokerPidForTest,
	reapFailedBrokerLaunch,
	reapSpawnedBrokerForTest,
	signalDetachedBrokerProcessForTest,
	signalPinnedBrokerProcessForTest,
} from "../src/sdk/broker/ensure";
import {
	BROKER_HANDOFF_ACKNOWLEDGEMENT,
	waitForBrokerHandoffAcknowledgement,
	writeBrokerHopReplyForTest,
} from "../src/sdk/broker/hop";
import { observeProcessIncarnation } from "../src/sdk/broker/process-incarnation";

describe("SDK broker hop protocol", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `gjc-hop-test-${crypto.randomUUID()}`);
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

	test.skipIf(process.platform === "darwin")(
		"hop reports a live detached broker pid that outlives the hop, and reap targets that pid",
		async () => {
			// Use Bun for cross-platform sleep instead of shell utility
			const sleepScript = path.join(tempDir, "sleep-broker.js");
			await Bun.write(sleepScript, `await Bun.sleep(30000);`);
			const launched = await launchBrokerViaHop(
				{ command: { file: process.execPath, args: [sleepScript] }, cwd: tempDir },
				{ env: process.env, cwd: tempDir },
			);
			expect(launched.error).toBeUndefined();
			const pid = launched.realBrokerPid;
			if (pid === undefined) throw new Error("Hop response did not include the broker pid.");
			expect(Number.isInteger(pid)).toBe(true);
			expect(pid).not.toBe(launched.process.pid);
			// The hop has exited, but the broker it launched is still running.
			expect(launched.process.exitCode).toBe(0);
			expect(isPidAlive(pid)).toBe(true);

			// Reaping through the exited hop's ChildProcess must signal the reported broker pid.
			const incarnation = launched.realBrokerIncarnation;
			if (incarnation === undefined) throw new Error("Hop response did not include the broker incarnation.");
			await reapSpawnedBrokerForTest(launched.process, pid, incarnation, {
				gracefulMs: 2_000,
				killVerifyMs: 2_000,
			});
			expect(observeProcessIncarnation(pid).status).toBe("absent");
		},
	);

	test.skipIf(process.platform === "darwin")("failed hop handoff terminates the pinned broker process", async () => {
		const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const spawned = Promise.withResolvers<void>();
		child.once("spawn", spawned.resolve);
		await spawned.promise;
		const pid = child.pid;
		if (pid === undefined) throw new Error("Test broker did not expose its pid.");
		const reference = nativeProcessBindings().Process.fromPid(pid);
		if (!reference) throw new Error("Test broker process could not be pinned.");
		expect(reference.ppid).toBe(process.pid);

		try {
			const result = await writeBrokerHopReplyForTest(child, reference, pid, (_chunk, callback) => {
				callback(new Error("EPIPE: broken pipe, write"));
			});
			expect(result.kind).toBe("failed");
			if (result.kind !== "failed") throw new Error("Expected failed handoff result.");
			expect(result.reason).toContain("broker terminated");
			expect(reference.status()).not.toBe("running");
		} finally {
			if (reference.status() === "running") reference.signalRoot(os.constants.signals.SIGKILL);
			await reference.waitForExit({ timeoutMs: 1_000 });
		}
	});

	test.skipIf(process.platform === "darwin")(
		"hop terminates the broker when the parent does not acknowledge",
		async () => {
			const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			const spawned = Promise.withResolvers<void>();
			child.once("spawn", spawned.resolve);
			await spawned.promise;
			const pid = child.pid;
			if (pid === undefined) throw new Error("Test broker did not expose its pid.");
			const reference = nativeProcessBindings().Process.fromPid(pid);
			if (!reference) throw new Error("Test broker process could not be pinned.");

			try {
				const result = await writeBrokerHopReplyForTest(
					child,
					reference,
					pid,
					(_chunk, callback) => callback(),
					async () => false,
				);
				expect(result.kind).toBe("failed");
				if (result.kind !== "failed") throw new Error("Expected an unacknowledged handoff to fail.");
				expect(result.reason).toContain("not acknowledged");
				expect(reference.status()).not.toBe("running");
			} finally {
				if (reference.status() === "running") reference.signalRoot(os.constants.signals.SIGKILL);
				await reference.waitForExit({ timeoutMs: 1_000 });
			}
		},
	);

	test.skipIf(process.platform === "darwin")(
		"a completed handoff captured at the deadline is reaped by exact incarnation",
		async () => {
			const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			const spawned = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			child.once("spawn", spawned.resolve);
			child.once("close", closed.resolve);
			await spawned.promise;
			const pid = child.pid;
			if (pid === undefined) throw new Error("Test broker did not expose its pid.");
			const observation = observeProcessIncarnation(pid);
			if (observation.status !== "present") throw new Error("Test broker process identity could not be observed.");

			try {
				const result = await brokerHopTimeoutResultForTest(
					child,
					`${JSON.stringify({ pid, incarnation: observation.incarnation })}\n`,
					"",
					10,
					true,
				);
				expect(result.realBrokerPid).toBe(pid);
				expect(result.realBrokerIncarnation).toBe(observation.incarnation);
				if (!(result.error instanceof BrokerHopError)) throw new Error("Expected a typed hop timeout error.");
				expect(result.error.reason).toContain("captured broker handoff was reaped");
				await closed.promise;
				expect(observeProcessIncarnation(pid).status).toBe("absent");
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed.promise;
			}
		},
	);

	test.skipIf(process.platform === "darwin")(
		"a POSIX trampoline handoff captured at the deadline is reaped by exact incarnation",
		async () => {
			const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			const spawned = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			child.once("spawn", spawned.resolve);
			child.once("close", closed.resolve);
			await spawned.promise;
			const pid = child.pid;
			if (pid === undefined) throw new Error("Test broker did not expose its pid.");
			const observation = observeProcessIncarnation(pid);
			if (observation.status !== "present") throw new Error("Test broker process identity could not be observed.");

			try {
				const result = await brokerTrampolineTimeoutResultForTest(
					child,
					`${pid}\t${observation.incarnation}\n`,
					10,
					true,
				);
				expect(result.realBrokerPid).toBe(pid);
				expect(result.realBrokerIncarnation).toBe(observation.incarnation);
				expect(result.error?.message).toContain("captured broker handoff was reaped");
				await closed.promise;
				expect(observeProcessIncarnation(pid).status).toBe("absent");
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed.promise;
			}
		},
	);

	test("startup diagnostics prefer the real broker exit record over the completed hop", () => {
		expect(brokerStartupExitStatusForTest(0, "SIGTERM", { exitCode: 1, signal: null }, undefined)).toEqual({
			exitCode: 1,
			signal: null,
		});
		expect(brokerStartupExitStatusForTest(0, "SIGTERM", undefined, { exitCode: 1, signal: null })).toEqual({
			exitCode: 1,
			signal: null,
		});
	});

	test("hop launch errors preserve the underlying spawn diagnostic", async () => {
		const launched = await launchBrokerViaHop(
			{ command: { file: path.join(tempDir, "missing-broker"), args: [] } },
			{ env: process.env },
		);
		expect(launched.error).toBeInstanceOf(BrokerHopError);
		const error = launched.error as BrokerHopError;
		expect(error.hopStderr.trim()).not.toBe("");
		expect(error.message).toContain(error.hopStderr.trim());
		expect(brokerSpawnFailureErrorForTest(error)).toBe(error);
		expect(brokerSpawnFailureErrorForTest(new Error("ENOENT")).message).toBe(
			"Failed to spawn detached SDK broker: ENOENT",
		);
	});

	test("launcher wait terminates a child when its startup deadline expires", async () => {
		const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const spawned = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		child.once("spawn", spawned.resolve);
		child.once("close", closed.resolve);
		await spawned.promise;
		try {
			const result = await awaitBrokerLauncherForTest(child, 10);
			if (result.kind !== "timeout") throw new Error("Expected launcher timeout.");
			expect(result.terminated).toBe(true);
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await closed.promise;
			}
		}
	});

	test("launcher deadline runs the bounded handoff cleanup before forced termination", async () => {
		const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const spawned = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		child.once("spawn", spawned.resolve);
		child.once("close", closed.resolve);
		await spawned.promise;
		let cleanupRequested = false;
		try {
			const result = await awaitBrokerLauncherForTest(child, 10, () => {
				cleanupRequested = true;
				child.stdout?.destroy();
				child.kill("SIGKILL");
			});
			expect(result).toEqual({ kind: "timeout", terminated: true });
			expect(cleanupRequested).toBe(true);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await closed.promise;
			}
		}
	});

	test("broker inherits the hop environment and writes stderr to the log path (no fd numbers, no env on argv)", async () => {
		const logPath = path.join(tempDir, "broker-spawn.log");
		const marker = `SECRET_${crypto.randomUUID()}`;
		// Use Bun for cross-platform environment variable printing
		const echoScript = path.join(tempDir, "echo-env.js");
		await Bun.write(echoScript, `console.error(process.env.GJC_HOP_TEST_VALUE); await Bun.sleep(1000);`);
		const message = {
			command: { file: process.execPath, args: [echoScript] },
			stderrLogPath: logPath,
		};
		expect(JSON.stringify(message)).not.toContain(marker);
		const launched = await launchBrokerViaHop(message, {
			env: { ...process.env, GJC_HOP_TEST_VALUE: marker },
			cwd: tempDir,
		});
		expect(launched.error).toBeUndefined();
		const pid = launched.realBrokerPid;
		if (pid === undefined) throw new Error("Hop response did not include the broker pid.");
		const deadline = Date.now() + 5_000;
		while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
		expect((await Bun.file(logPath).text()).trim()).toBe(marker);
	});

	test("parseBrokerHopReply requires a positive pid and valid incarnation from a clean exit", () => {
		expect(parseBrokerHopReply(0, '{"pid":4321,"incarnation":"linux:123"}\n')).toEqual({
			realBrokerPid: 4321,
			realBrokerIncarnation: "linux:123",
			error: undefined,
		});
		for (const [code, stdout] of [
			[1, '{"pid":4321}'],
			[0, ""],
			[0, "not json"],
			[0, '{"pid":"4321"}'],
			[0, '{"pid":0}'],
			[0, '{"pid":1.5}'],
			[0, '{"pid":4321}'],
			[0, '{"pid":4321,"incarnation":"invalid"}'],
		] as const) {
			const parsed = parseBrokerHopReply(code, stdout);
			expect(parsed.realBrokerPid).toBeUndefined();
			expect(parsed.error).toBeInstanceOf(BrokerHopError);
		}
	});

	test("detached reaping never escalates after the PID changes incarnation", async () => {
		const kill = spyOn(process, "kill").mockImplementation(() => true);
		const observations = [
			{ status: "present", incarnation: "linux:11" },
			{ status: "present", incarnation: "linux:11" },
			{ status: "present", incarnation: "linux:12" },
		] as const;
		let index = 0;
		try {
			await reapDetachedBrokerPidForTest(
				12345,
				"linux:11",
				{ gracefulMs: 5, killVerifyMs: 5 },
				() => observations[index++] ?? { status: "unknown", reasonCode: "test_exhausted" },
				(pid, _incarnation, signal) => {
					process.kill(pid, signal);
					return true;
				},
			);
			expect(kill).toHaveBeenCalledTimes(1);
			expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
		} finally {
			kill.mockRestore();
		}
	});

	test("pinned broker signals require a matching process incarnation", () => {
		const signals: number[] = [];
		const reference = {
			incarnation: "windows:11",
			signalRoot: (signal: number): boolean => {
				signals.push(signal);
				return true;
			},
		};
		expect(signalPinnedBrokerProcessForTest(reference, "windows:12", "SIGTERM")).toBe(false);
		expect(signals).toEqual([]);
		expect(signalPinnedBrokerProcessForTest(reference, "windows:11", "SIGTERM")).toBe(true);
		expect(signals).toEqual([os.constants.signals.SIGTERM]);
	});

	test("detached broker signaling fails closed on Darwin without a pinned signal primitive", () => {
		const kill = spyOn(process, "kill").mockImplementation(() => true);
		try {
			expect(signalDetachedBrokerProcessForTest(12345, "darwin:123", "SIGTERM", "darwin")).toBe(false);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	test("broker handoff acknowledgement requires the complete protocol token", async () => {
		const acceptedInput = new stream.PassThrough();
		const accepted = waitForBrokerHandoffAcknowledgement(acceptedInput);
		acceptedInput.end(BROKER_HANDOFF_ACKNOWLEDGEMENT);
		expect(await accepted).toBe(true);

		const incompleteInput = new stream.PassThrough();
		const incomplete = waitForBrokerHandoffAcknowledgement(incompleteInput);
		incompleteInput.end(BROKER_HANDOFF_ACKNOWLEDGEMENT.slice(0, -1));
		expect(await incomplete).toBe(false);
	});

	test("failed successor handoff retries cleanup for its captured broker identity", async () => {
		const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const spawned = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		child.once("spawn", spawned.resolve);
		child.once("close", closed.resolve);
		await spawned.promise;
		const pid = child.pid;
		if (pid === undefined) throw new Error("Test broker did not expose its pid.");
		const observation = observeProcessIncarnation(pid);
		if (observation.status !== "present") throw new Error("Test broker process identity could not be observed.");

		try {
			const result = await refuseFailedBrokerLaunchForTest({
				process: child,
				realBrokerPid: pid,
				realBrokerIncarnation: observation.incarnation,
				error: new Error("trampoline timeout cleanup failed"),
			});
			expect(result).toMatchObject({ kind: "refused", reason: "spawn_failed" });
			if (result.kind !== "refused") throw new Error("Expected a failed successor refusal.");
			expect(result.detail).toContain("trampoline timeout cleanup failed");
			await closed.promise;
			expect(observeProcessIncarnation(pid).status).toBe("absent");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed.promise;
		}
	});

	test("detached discovery child cleanup uses the retained process handle", async () => {
		const launched = await launchBrokerViaDetachedChild(
			{ file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
			{ env: process.env },
		);
		if (launched.error) throw launched.error;
		const pid = launched.realBrokerPid;
		if (pid === undefined || pid !== launched.process.pid)
			throw new Error("Detached broker did not retain its exact child process handle.");
		const closed = Promise.withResolvers<void>();
		launched.process.once("close", closed.resolve);
		try {
			await reapFailedBrokerLaunch(launched);
			await closed.promise;
			expect(observeProcessIncarnation(pid).status).toBe("absent");
		} finally {
			if (launched.process.exitCode === null && launched.process.signalCode === null) {
				launched.process.kill("SIGKILL");
				await closed.promise;
			}
		}
	});

	test("detached reaping does not signal a PID that was already reused", async () => {
		const kill = spyOn(process, "kill").mockImplementation(() => true);
		try {
			await reapDetachedBrokerPidForTest(12345, "linux:11", { gracefulMs: 1, killVerifyMs: 1 }, () => ({
				status: "present",
				incarnation: "linux:12",
			}));
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	test("detached reaping refuses to signal without a verified incarnation", async () => {
		const kill = spyOn(process, "kill").mockImplementation(() => true);
		try {
			await expect(
				reapDetachedBrokerPidForTest(12345, undefined, { gracefulMs: 1, killVerifyMs: 1 }, () => ({
					status: "present",
					incarnation: "linux:11",
				})),
			).rejects.toThrow("without a verified process incarnation");
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
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
