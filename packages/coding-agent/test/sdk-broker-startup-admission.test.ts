import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	Broker,
	StartupAdmissionQueue,
	type StartupAdmissionTiming,
	sdkHostStartupConcurrency,
} from "../src/sdk/broker/broker";
import { deriveLifecycleDeadlines, setLifecycleTimingForTest } from "../src/sdk/broker/lifecycle";
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
