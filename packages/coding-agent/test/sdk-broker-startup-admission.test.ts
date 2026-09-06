import { expect, spyOn, test } from "bun:test";
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
import {
	cancellableSleep,
	DEFAULT_DEPENDENCY_PREPARATION_TIMEOUT_MS,
	DEFAULT_READINESS_TIMEOUT_MS,
	DEFAULT_WORKTREE_PREPARATION_TIMEOUT_MS,
	deriveLifecycleOuterDeadlines,
	lifecycleRequestTimeoutMs,
	lifecycleStartupBudgetMs,
	preparationBudgetMs,
	startupQueueWaitMs,
} from "../src/sdk/broker/startup-budget";
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

test("closing after grant but before task execution refuses the admitted startup", async () => {
	const queue = new StartupAdmissionQueue(1);
	const release = Promise.withResolvers<void>();
	let nowCalls = 0;
	let queuedTaskRuns = 0;
	const timing: StartupAdmissionTiming = {
		now: () => {
			nowCalls += 1;
			if (nowCalls === 2) queue.close();
			return 1_000;
		},
		sleep: () => Promise.withResolvers<void>().promise,
	};
	const holder = queue.run(4_000, timing, async () => {
		await release.promise;
	});
	const queued = queue.run(4_000, timing, async () => {
		queuedTaskRuns += 1;
	});
	await Promise.resolve();

	release.resolve();
	await holder;

	expect(await queued).toEqual({ status: "admission_refused", reason: "admission_refused" });
	expect(queuedTaskRuns).toBe(0);
});

async function expectGraceWindowFenceRefusesQueuedStartup(observation: "replaced" | "ambiguous"): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-${observation}-fence-admission-`));
	const agentDir = path.join(root, "agent");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir, heartbeatTtlMs: 300 });
	const release = Promise.withResolvers<void>();
	const parked: StartupAdmissionTiming = { now: Date.now, sleep: () => Promise.withResolvers<void>().promise };
	const queuedInAdmission = Promise.withResolvers<void>();
	let spawnCalls = 0;
	try {
		delete process.env.GJC_SDK_SESSION_COMMAND;
		await broker.start();
		if (observation === "ambiguous") setAmbiguityGraceForTest(broker, 60_000);
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCalls += 1;
			throw new Error("SDK internal launch refused: fenced broker must not spawn.");
		});
		const holders = Array.from({ length: sdkHostStartupConcurrency() }, () =>
			broker.runStartup(4_000, parked, async () => {
				await release.promise;
			}),
		);
		await Promise.resolve();
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
			`queued-during-${observation}-fence`,
		);
		await queuedInAdmission.promise;

		setPublicationObservationForTest(broker, observation);
		const fenceDeadline = Date.now() + 2_000;
		let listResponse = await broker.handleRequest("session.list", {});
		while ((listResponse.ok || listResponse.error.code !== "unavailable") && Date.now() < fenceDeadline) {
			await Bun.sleep(10);
			listResponse = await broker.handleRequest("session.list", {});
		}
		expect(listResponse).toMatchObject({ ok: false, error: { code: "unavailable" } });

		release.resolve();
		await Promise.all(holders);
		expect(await queued).toEqual({
			ok: false,
			error: {
				code: "startup_admission_refused",
				message: "SDK host startup was refused because the broker no longer owns the session root.",
			},
		});
		expect(spawnCalls).toBe(0);
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
}

test("suspect-unpublished fence refuses queued startup before loss grace expires", async () => {
	await expectGraceWindowFenceRefusesQueuedStartup("replaced");
});

test("observation-ambiguous fence refuses queued startup before ambiguity grace expires", async () => {
	await expectGraceWindowFenceRefusesQueuedStartup("ambiguous");
});

test("publication replacement during heartbeat persistence cannot reopen startup admission", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-heartbeat-reopen-fence-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	try {
		await broker.start();
		const heartbeat = broker.heartbeat();
		setPublicationObservationForTest(broker, "replaced");
		await heartbeat;

		expect(await broker.handleRequest("session.list", {})).toEqual({
			ok: false,
			error: { code: "unavailable", message: "broker publication is unavailable" },
		});
	} finally {
		setPublicationObservationForTest(broker, undefined);
		await broker.stop().catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("an admitted startup fenced during ledger persistence cannot reach synchronous spawn", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-admitted-ledger-fence-"));
	const agentDir = path.join(root, "agent");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir, heartbeatTtlMs: 300 });
	const transitionEntered = Promise.withResolvers<void>();
	const releaseTransition = Promise.withResolvers<void>();
	let spawnCalls = 0;
	let paused = false;
	try {
		delete process.env.GJC_SDK_SESSION_COMMAND;
		await broker.start();
		const transition = broker.ledger.transition.bind(broker.ledger);
		const transitionSpy = spyOn(broker.ledger, "transition").mockImplementation(async (identity, state, fields) => {
			if (!paused && state === "effect_started") {
				paused = true;
				transitionEntered.resolve();
				await releaseTransition.promise;
			}
			return transition(identity, state, fields);
		});
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCalls += 1;
			throw new Error("SDK internal launch refused: fenced broker must not spawn.");
		});

		const startup = broker.handleRequest(
			"session.create",
			{ cwd: root, stateRoot: path.join(root, ".gjc", "state"), readinessTimeoutMs: 4_000 },
			"admitted-before-ledger-fence",
		);
		await transitionEntered.promise;

		setPublicationObservationForTest(broker, "replaced");
		const fenceDeadline = Date.now() + 2_000;
		let listResponse = await broker.handleRequest("session.list", {});
		while ((listResponse.ok || listResponse.error.code !== "unavailable") && Date.now() < fenceDeadline) {
			await Bun.sleep(10);
			listResponse = await broker.handleRequest("session.list", {});
		}
		expect(listResponse).toMatchObject({ ok: false, error: { code: "unavailable" } });

		releaseTransition.resolve();
		expect(await startup).toEqual({
			ok: false,
			error: {
				code: "startup_admission_refused",
				message: "SDK host startup was refused because the broker no longer owns the session root.",
			},
		});
		expect({ fenced: !listResponse.ok, spawnCalls }).toEqual({ fenced: true, spawnCalls: 0 });
		transitionSpy.mockRestore();
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setPublicationObservationForTest(broker, undefined);
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		releaseTransition.resolve();
		await broker.stop().catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
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

test("a stop that cannot prove it still owns the root drains the queued startups", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-unproven-stop-"));
	const agentDir = path.join(root, "agent");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	const release = Promise.withResolvers<void>();
	const parked: StartupAdmissionTiming = { now: Date.now, sleep: () => Promise.withResolvers<void>().promise };
	const queuedInAdmission = Promise.withResolvers<void>();
	let spawnCalls = 0;
	try {
		delete process.env.GJC_SDK_SESSION_COMMAND;
		await broker.start();
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCalls += 1;
			throw new Error("SDK internal launch refused: a broker that lost the root must not spawn.");
		});
		// Hold every startup slot so the lifecycle request has to queue behind them.
		const holders = Array.from({ length: sdkHostStartupConcurrency() }, () =>
			broker.runStartup(4_000, parked, async () => {
				await release.promise;
			}),
		);
		await Promise.resolve();
		// The queued request may only be woken by a drain, never by its own cutoff.
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
			"queued-behind-replaced-root",
		);
		await queuedInAdmission.promise;

		// A replacement already owns the published root. The watchdog runs on a 5s cadence
		// and has not observed it, so the broker's cached publication state is still healthy
		// and only a fresh observation can tell the stop what it may still claim.
		setPublicationObservationForTest(broker, "replaced");
		const stopped = broker.stop();

		// Slots only free up once the stop has already decided what it owns.
		release.resolve();
		await Promise.all(holders);
		expect(await queued).toEqual({
			ok: false,
			error: {
				code: "startup_admission_refused",
				message: "SDK host startup was refused because the broker no longer owns the session root.",
			},
		});
		expect(spawnCalls).toBe(0);
		await stopped;

		// A drained queue refuses every later startup, so a restart must not inherit it.
		setPublicationObservationForTest(broker, undefined);
		await broker.start();
		const restarted = await broker.runStartup(
			4_000,
			{ now: Date.now, sleep: async () => undefined },
			async () => "ready",
		);
		if (restarted.status !== "completed") throw new Error(`restart refused its own startup: ${restarted.status}.`);
		expect(restarted.value).toBe("ready");
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		setPublicationObservationForTest(broker, undefined);
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		release.resolve();
		await broker.stop().catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("the ACP caller deadline covers the admission wait even when readiness is defaulted", async () => {
	const defaulted = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: defaulted as never }).global(
		"session.create",
		{ cwd: "/workspace" },
		"defaulted-readiness",
	);
	expect(defaulted.timeoutMs).toBe(lifecycleStartupBudgetMs(DEFAULT_READINESS_TIMEOUT_MS) + 1_000);

	const requested = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: requested as never }).global(
		"session.create",
		{ cwd: "/workspace", readinessTimeoutMs: 4_000 },
		"requested-readiness",
	);
	expect(requested.timeoutMs).toBe(lifecycleStartupBudgetMs(4_000) + 1_000);

	// An operation that never queues for a startup slot keeps its own readiness sizing.
	const closing = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: closing as never }).global(
		"session.close",
		{ sessionId: "s", readinessTimeoutMs: 4_000 },
		"closing",
	);
	expect(closing.timeoutMs).toBe(5_000);
});
test("caller timeout adds independent prep budgets for both worktree input shapes", () => {
	expect(lifecycleStartupBudgetMs(DEFAULT_READINESS_TIMEOUT_MS)).toBe(20_000);
	expect(lifecycleRequestTimeoutMs("session.create", { cwd: "/workspace" })).toBe(21_000);
	expect(
		lifecycleRequestTimeoutMs("session.create", {
			cwd: "/workspace",
			target: { worktree: { enabled: true, name: "x" } },
		}),
	).toBe(81_000);
	expect(
		lifecycleRequestTimeoutMs("session.create", {
			cwd: "/workspace",
			worktree: { enabled: true, name: "x" },
		}),
	).toBe(81_000);
	expect(
		lifecycleRequestTimeoutMs("session.create", {
			cwd: "/workspace",
			target: { worktree: { enabled: true } },
		}),
	).toBe(81_000);
	expect(lifecycleRequestTimeoutMs("session.fork", { worktree: { name: "x" } })).toBe(81_000);
	expect(lifecycleRequestTimeoutMs("session.resume", { worktree: { enabled: true, name: "x" } })).toBe(81_000);
	expect(preparationBudgetMs({ cwd: "/workspace" })).toBe(0);
	expect(preparationBudgetMs({ target: { worktree: { enabled: true } } })).toBe(
		DEFAULT_WORKTREE_PREPARATION_TIMEOUT_MS + DEFAULT_DEPENDENCY_PREPARATION_TIMEOUT_MS,
	);
	expect(preparationBudgetMs({ worktreePreparationTimeoutMs: 1.5 })).toBeUndefined();
	expect(
		deriveLifecycleOuterDeadlines({
			admittedAt: 1_000_000,
			worktreePrepTimeoutMs: 30_000,
			dependencyPrepTimeoutMs: 30_000,
			requestedReadinessTimeoutMs: 10_000,
		}),
	).toMatchObject({
		worktreePreparationDeadlineAt: 1_030_000,
		lifecycleCleanupDeadlineAt: 1_070_000,
	});
});

test("lost-root completion does not wait indefinitely for model resolver disposal", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lost-root-disposal-"));
	const agentDir = path.join(root, "agent");
	const disposeGate = Promise.withResolvers<void>();
	const resolveModelPin = Object.assign(async () => ({ ok: true as const, model: null }), {
		dispose: () => disposeGate.promise,
	});
	const broker = new Broker({ agentDir, resolveModelPin });
	try {
		await broker.start();
		setPublicationObservationForTest(broker, "ambiguous");
		const completed = await Promise.race([broker.stop().then(() => true), Bun.sleep(2_500).then(() => false)]);
		expect(completed).toBe(true);
	} finally {
		disposeGate.resolve();
		setPublicationObservationForTest(broker, undefined);
		await broker.stop().catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a default startup admitted late by the production broker stays inside the ACP caller deadline", async () => {
	const sdk = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: sdk as never }).global(
		"session.create",
		{ cwd: "/workspace" },
		"default-late-admission",
	);
	const callerDeadlineMs = sdk.timeoutMs;
	if (callerDeadlineMs === undefined) throw new Error("ACP caller did not bound the default lifecycle request.");

	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-late-admission-"));
	const agentDir = path.join(root, "agent");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	const release = Promise.withResolvers<void>();
	const parked: StartupAdmissionTiming = { now: Date.now, sleep: () => Promise.withResolvers<void>().promise };
	const admissionParked = Promise.withResolvers<void>();
	const receivedAt = 1_000_000;
	let now = receivedAt;
	let observedQueueWaitMs: number | undefined;
	let spawnCalls = 0;
	try {
		delete process.env.GJC_SDK_SESSION_COMMAND;
		await broker.start();
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCalls += 1;
			throw new Error("SDK internal launch refused: this test only needs to reach the spawn seam.");
		});
		const holders = Array.from({ length: sdkHostStartupConcurrency() }, () =>
			broker.runStartup(startupQueueWaitMs(DEFAULT_READINESS_TIMEOUT_MS), parked, async () => {
				await release.promise;
			}),
		);
		await Promise.resolve();
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: ms => {
				observedQueueWaitMs ??= ms;
				admissionParked.resolve();
				return Promise.withResolvers<void>().promise;
			},
		});
		// No `readinessTimeoutMs`: the request shape of a caller that sizes nothing itself.
		const queued = broker.handleRequest(
			"session.create",
			{ cwd: root, stateRoot: path.join(root, ".gjc", "state") },
			"default-late-admission",
		);
		await admissionParked.promise;
		expect(observedQueueWaitMs).toBe(startupQueueWaitMs(DEFAULT_READINESS_TIMEOUT_MS));

		// Admit at the last instant the queue allows.
		const admittedAt = receivedAt + startupQueueWaitMs(DEFAULT_READINESS_TIMEOUT_MS) - 1;
		now = admittedAt;
		release.resolve();
		await Promise.all(holders);
		const response = await queued;

		// Reaching the spawn seam here proves readiness is granted fresh at admission:
		// measured from arrival the readiness deadline had already passed, and the broker
		// would have returned `readiness_timeout` before resolving any command.
		expect(spawnCalls).toBe(1);
		expect(response).toMatchObject({ ok: false, error: { code: "spawn_failed" } });

		// So the broker's own terminal instant for this admission, derived by the same
		// function its startup path uses, must still fit inside the deadline the ACP caller
		// granted the identical default request.
		const terminalAt = deriveLifecycleDeadlines(admittedAt, DEFAULT_READINESS_TIMEOUT_MS).lifecycleCleanupDeadlineAt;
		expect(terminalAt - receivedAt).toBeLessThanOrEqual(callerDeadlineMs);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		release.resolve();
		await broker.stop().catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("a refused waiter cancels the queue-wait cutoff it no longer needs", async () => {
	const queue = new StartupAdmissionQueue(1);
	const release = Promise.withResolvers<void>();
	const cutoffs: Array<AbortSignal | undefined> = [];
	const timing: StartupAdmissionTiming = {
		now: () => 1_000,
		sleep: (_ms, signal) => {
			cutoffs.push(signal);
			return Promise.withResolvers<void>().promise;
		},
	};
	const holder = queue.run(4_000, timing, () => release.promise);
	const queued = queue.run(4_000, timing, async () => "queued");
	await Promise.resolve();

	// While the waiter is still queued its cutoff is the only thing that can end the wait.
	expect(cutoffs).toHaveLength(1);
	expect(cutoffs[0]?.aborted).toBe(false);

	queue.close();
	expect(await queued).toEqual({ status: "admission_refused", reason: "admission_refused" });
	// A refusal is terminal, so the cutoff must not outlive it holding a timer that could
	// run for the rest of the queue-wait budget.
	expect(cutoffs[0]?.aborted).toBe(true);

	release.resolve();
	await holder;
});

test("the production queue-wait sleep ends with its cutoff instead of its duration", async () => {
	const cutoff = new AbortController();
	let settled = false;
	const sleeping = cancellableSleep(600_000, cutoff.signal).then(() => {
		settled = true;
	});
	await Bun.sleep(5);
	expect(settled).toBe(false);

	cutoff.abort();
	await sleeping;
	expect(settled).toBe(true);

	// An already-cancelled cutoff never arms a timer at all.
	const cancelled = new AbortController();
	cancelled.abort();
	await cancellableSleep(600_000, cancelled.signal);
});

test("the ACP caller deadline follows a supplied lifecycle deadline tuple, not the field it overrides", async () => {
	const receivedAt = 1_000_000;
	const tuple = deriveLifecycleDeadlines(receivedAt, 30_000);

	// The broker sizes both the admission wait and the readiness window from the tuple and
	// ignores `readinessTimeoutMs` entirely, so budgeting the overridden field would cut the
	// caller off long before the broker reaches its own terminal.
	const supplied = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: supplied as never }).global(
		"session.create",
		{ cwd: "/workspace", readinessTimeoutMs: 4_000, ...tuple },
		"supplied-deadline-tuple",
	);
	expect(supplied.timeoutMs).toBe(lifecycleStartupBudgetMs(30_000) + 1_000);

	// A close carries no admission wait, so it is budgeted on the tuple's readiness alone.
	const closing = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: closing as never }).global(
		"session.close",
		{ sessionId: "s", ...tuple },
		"closing-deadline-tuple",
	);
	expect(closing.timeoutMs).toBe(31_000);
});

test("the ACP caller leaves an unbudgetable lifecycle request on the generic client deadline", async () => {
	// A partial tuple conflicts with the broker's all-or-nothing deadline contract, and an
	// out-of-range readiness value is out of contract on its own. Both are refused as invalid
	// input before anything is queued, so neither may claim a startup-sized caller deadline.
	const partial = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: partial as never }).global(
		"session.create",
		{ cwd: "/workspace", receivedAt: 1_000_000, requestedReadinessTimeoutMs: 30_000 },
		"partial-deadline-tuple",
	);
	expect(partial.timeoutMs).toBeUndefined();

	const outOfRange = new TimeoutCapturingSdkClient();
	await new AcpSdkAdapter({ client: outOfRange as never }).global(
		"session.create",
		{ cwd: "/workspace", readinessTimeoutMs: 600_000 },
		"out-of-range-readiness",
	);
	expect(outOfRange.timeoutMs).toBeUndefined();
});
