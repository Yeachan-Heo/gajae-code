import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AcpSdkAdapter } from "../src/sdk/acp";
import {
	Broker,
	StartupAdmissionQueue,
	type StartupAdmissionTiming,
	sdkHostStartupConcurrency,
	setAmbiguityGraceForTest,
	setPublicationObservationForTest,
} from "../src/sdk/broker/broker";
import {
	deriveLifecycleDeadlines,
	setLifecycleCommandResolverForTest,
	setLifecycleTimingForTest,
} from "../src/sdk/broker/lifecycle";
import { startupQueueWaitMs } from "../src/sdk/broker/startup-budget";
import { normalizeSdkStartupFailure } from "../src/sdk/startup-capability";

function controlledTiming(now: () => number): {
	timing: StartupAdmissionTiming;
	sleeps: Array<PromiseWithResolvers<void>>;
} {
	const sleeps: Array<PromiseWithResolvers<void>> = [];
	return {
		timing: {
			now,
			sleep: () => {
				const sleep = Promise.withResolvers<void>();
				sleeps.push(sleep);
				return sleep.promise;
			},
		},
		sleeps,
	};
}

/** Records the request deadline the ACP caller actually grants a lifecycle startup. */
class TimeoutCapturingSdkClient {
	timeoutMs: number | undefined;
	async global(
		_operation: string,
		_input: Record<string, unknown>,
		options?: { timeoutMs?: number },
	): Promise<{ ok: true }> {
		this.timeoutMs = options?.timeoutMs;
		return { ok: true };
	}
}

test("SDK host startup concurrency scales sublinearly with observable CPU parallelism", () => {
	expect(sdkHostStartupConcurrency(1)).toBe(1);
	expect(sdkHostStartupConcurrency(4)).toBe(2);
	expect(sdkHostStartupConcurrency(16)).toBe(4);
	expect(sdkHostStartupConcurrency(20)).toBe(4);
});

test("concurrent startups either run or report admission timeout instead of pending", async () => {
	const queue = new StartupAdmissionQueue(1);
	const firstRelease = Promise.withResolvers<void>();
	const { timing, sleeps } = controlledTiming(() => 1_000);
	const first = queue.run(10_000, timing, async () => {
		await firstRelease.promise;
		return "first-ready";
	});
	const second = queue.run(10_000, timing, async () => "second-ready");
	const third = queue.run(10_000, timing, async () => "third-ready");
	await Promise.resolve();

	expect(sleeps).toHaveLength(2);
	sleeps[1]!.resolve();
	firstRelease.resolve();

	const results = await Promise.all([first, second, third]);
	expect(results.map(result => result.status)).toEqual(["completed", "completed", "admission_timeout"]);
	expect(results[2]).toEqual({ status: "admission_timeout", reason: "admission_timeout" });
	expect(JSON.stringify(results)).not.toContain('"reason":"pending"');
});

test("queued startup receives its full readiness budget from admission", async () => {
	let now = 1_000;
	const queue = new StartupAdmissionQueue(1);
	const firstRelease = Promise.withResolvers<void>();
	const { timing } = controlledTiming(() => now);
	const first = queue.run(4_000, timing, async () => {
		await firstRelease.promise;
		return undefined;
	});
	const second = queue.run(4_000, timing, async admittedAt => deriveLifecycleDeadlines(admittedAt, 4_000));
	await Promise.resolve();

	now = 9_000;
	firstRelease.resolve();
	const result = await second;
	await first;

	expect(result).toEqual({
		status: "completed",
		admittedAt: 9_000,
		value: {
			receivedAt: 9_000,
			requestedReadinessTimeoutMs: 4_000,
			semanticReadyDeadlineAt: 11_000,
			terminationStartDeadlineAt: 12_000,
			lifecycleCleanupDeadlineAt: 13_000,
		},
	});
});

test("single startup preserves the exact existing deadline derivation", async () => {
	const admittedAt = 25_000;
	let nowCalls = 0;
	const queue = new StartupAdmissionQueue(4);
	const result = await queue.run(
		10_000,
		{
			now: () => {
				nowCalls += 1;
				return admittedAt;
			},
			sleep: () => {
				throw new Error("an uncontended startup must not wait");
			},
		},
		async timestamp => deriveLifecycleDeadlines(timestamp, 10_000),
	);

	expect(nowCalls).toBe(1);
	expect(result).toEqual({
		status: "completed",
		admittedAt,
		value: deriveLifecycleDeadlines(admittedAt, 10_000),
	});
});

test("startup admission drains FIFO and releases slots after thrown tasks", async () => {
	const queue = new StartupAdmissionQueue(1);
	const firstRelease = Promise.withResolvers<void>();
	const { timing } = controlledTiming(() => 1_000);
	const order: string[] = [];
	const first = queue.run(10_000, timing, async () => {
		order.push("first");
		await firstRelease.promise;
	});
	const second = queue.run(10_000, timing, async () => {
		order.push("second");
		throw new Error("startup failed");
	});
	const third = queue.run(10_000, timing, async () => {
		order.push("third");
		return "ready";
	});
	await Promise.resolve();
	firstRelease.resolve();

	await first;
	await expect(second).rejects.toThrow("startup failed");
	await expect(third).resolves.toMatchObject({ status: "completed", value: "ready" });
	expect(order).toEqual(["first", "second", "third"]);
});

test("admission timeout has its own accurate normalized startup reason", () => {
	expect(normalizeSdkStartupFailure("startup", "admission_timeout")).toEqual({
		phase: "startup",
		reason: "admission_timeout",
		message: "SDK host startup was not admitted before the queue wait cutoff.",
	});
});

test("broker validates before admission and maps bounded queue waits honestly", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-startup-admission-"));
	const broker = new Broker({ agentDir });
	const release = Promise.withResolvers<void>();
	const holderTiming: StartupAdmissionTiming = {
		now: () => 1_000,
		sleep: () => Promise.withResolvers<void>().promise,
	};
	await broker.start();
	const holders = Array.from({ length: sdkHostStartupConcurrency() }, () =>
		broker.runStartup(4_000, holderTiming, async () => {
			await release.promise;
		}),
	);
	await Promise.resolve();
	setLifecycleTimingForTest(broker, { now: () => 9_000, sleep: async () => undefined });

	try {
		expect(await broker.handleRequest("session.create", {}, "invalid-before-admission")).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "A target path is required." },
		});
		expect(
			await broker.handleRequest(
				"session.create",
				{ cwd: agentDir, readinessTimeoutMs: 4_000 },
				"bounded-admission-timeout",
			),
		).toEqual({
			ok: false,
			error: {
				code: "startup_admission_timeout",
				message: "SDK host startup was not admitted before the queue wait cutoff.",
			},
		});
	} finally {
		setLifecycleTimingForTest(broker, undefined);
		release.resolve();
		await Promise.all(holders);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("closing the startup queue refuses its waiters instead of granting or stranding them", async () => {
	const queue = new StartupAdmissionQueue(1);
	const release = Promise.withResolvers<void>();
	const { timing, sleeps } = controlledTiming(() => 1_000);
	let queuedTaskRuns = 0;
	const holder = queue.run(4_000, timing, async () => {
		await release.promise;
	});
	const queued = queue.run(4_000, timing, async () => {
		queuedTaskRuns += 1;
	});
	await Promise.resolve();
	expect(sleeps).toHaveLength(1);

	queue.close();
	expect(await queued).toEqual({ status: "admission_refused", reason: "admission_refused" });

	release.resolve();
	await holder;
	expect(queuedTaskRuns).toBe(0);

	// A free slot must not resurrect a closed queue either.
	expect(
		await queue.run(4_000, timing, async () => {
			queuedTaskRuns += 1;
		}),
	).toEqual({ status: "admission_refused", reason: "admission_refused" });
	expect(queuedTaskRuns).toBe(0);
});

test("a broker that lost the root refuses queued startups instead of spawning children", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lost-root-admission-"));
	const agentDir = path.join(root, "agent");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	// A short TTL drives the publication watchdog at `ttl/3`, so the fence lands fast.
	const broker = new Broker({ agentDir, heartbeatTtlMs: 300 });
	const release = Promise.withResolvers<void>();
	const parked: StartupAdmissionTiming = { now: Date.now, sleep: () => Promise.withResolvers<void>().promise };
	const queuedInAdmission = Promise.withResolvers<void>();
	let brokerCompleted = false;
	let spawnPathEnteredAfterCompletion = 0;
	try {
		delete process.env.GJC_SDK_SESSION_COMMAND;
		await broker.start();
		setLifecycleCommandResolverForTest(broker, () => {
			if (brokerCompleted) spawnPathEnteredAfterCompletion += 1;
			throw new Error("SDK internal launch refused: fenced broker must not spawn.");
		});
		// Hold every startup slot so the lifecycle request has to queue behind them.
		const holders = Array.from({ length: sdkHostStartupConcurrency() }, () =>
			broker.runStartup(4_000, parked, async () => {
				await release.promise;
			}),
		);
		await Promise.resolve();
		// The queued request may only be woken by the drain, never by its own cutoff.
		setLifecycleTimingForTest(broker, {
			now: Date.now,
			sleep: () => {
				queuedInAdmission.resolve();
				return Promise.withResolvers<void>().promise;
			},
		});
		const queued = broker.handleRequest(
			"session.create",
			{ cwd: root, stateRoot: path.join(root, ".gjc", "state"), readinessTimeoutMs: 4_000 },
			"queued-behind-lost-root",
		);
		await queuedInAdmission.promise;

		// Fence the broker past its bounded ambiguity deadline so it completes as lost-root.
		setAmbiguityGraceForTest(broker, 1);
		setPublicationObservationForTest(broker, "ambiguous");
		await broker.completion;
		brokerCompleted = true;

		// Slots only free up once the fenced broker is already gone.
		release.resolve();
		await Promise.all(holders);

		expect(await queued).toEqual({
			ok: false,
			error: {
				code: "startup_admission_refused",
				message: "SDK host startup was refused because the broker no longer owns the session root.",
			},
		});
		expect(spawnPathEnteredAfterCompletion).toBe(0);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		setPublicationObservationForTest(broker, undefined);
		setAmbiguityGraceForTest(broker, undefined);
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		release.resolve();
		await broker.stop().catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("the ACP caller deadline covers admission wait, not only the readiness budget", async () => {
	const readinessTimeoutMs = 4_000;
	const sdk = new TimeoutCapturingSdkClient();
	const adapter = new AcpSdkAdapter({ url: "ws://unused", token: "secret", client: sdk as never });
	await adapter.global("session.create", { cwd: "/workspace", readinessTimeoutMs }, "late-admission");
	const callerDeadlineMs = sdk.timeoutMs;
	if (callerDeadlineMs === undefined) throw new Error("ACP caller did not bound the lifecycle request.");

	// The broker parks the request, then starts the readiness clock at admission, so its
	// terminal instant is measured from `admittedAt` and not from when the caller sent it.
	let now = 0;
	const queue = new StartupAdmissionQueue(1);
	const release = Promise.withResolvers<void>();
	const { timing } = controlledTiming(() => now);
	const holder = queue.run(startupQueueWaitMs(readinessTimeoutMs), timing, () => release.promise);
	const queued = queue.run(startupQueueWaitMs(readinessTimeoutMs), timing, async admittedAt =>
		deriveLifecycleDeadlines(admittedAt, readinessTimeoutMs),
	);
	await Promise.resolve();

	now = 3_700;
	release.resolve();
	const admitted = await queued;
	await holder;
	if (admitted.status !== "completed") throw new Error(`expected a late admission, got ${admitted.status}.`);
	expect(admitted.value.receivedAt).toBe(3_700);
	expect(admitted.value.lifecycleCleanupDeadlineAt).toBe(7_700);

	// The broker runs to that instant and persists a terminal result there, so a caller
	// that stopped listening earlier abandons a request that is still going to finish.
	expect(admitted.value.lifecycleCleanupDeadlineAt).toBeLessThanOrEqual(callerDeadlineMs);
	// Worst case: admitted at the very edge of the queue wait.
	expect(callerDeadlineMs).toBeGreaterThanOrEqual(startupQueueWaitMs(readinessTimeoutMs) + readinessTimeoutMs);
});
