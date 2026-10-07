import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ACP_EXTERNAL_CONNECT_TIMEOUT_MS, ACP_SESSION_READINESS_TIMEOUT_MS } from "../src/modes/acp/acp-agent";
import { Broker, sdkHostStartupConcurrency } from "../src/sdk/broker/broker";
import {
	deriveLifecycleDeadlines,
	setLifecycleCommandResolverForTest,
	setLifecycleTimingForTest,
} from "../src/sdk/broker/lifecycle";
import {
	DEFAULT_BROKER_PRESPAWN_PREPARATION_TIMEOUT_MS,
	DEFAULT_READINESS_TIMEOUT_MS,
	lifecycleRequestTimeoutMs,
	startupQueueWaitMs,
} from "../src/sdk/broker/startup-budget";

test("broker-derived non-worktree preparation and fresh readiness fit the unchanged caller deadline", () => {
	for (const readinessTimeoutMs of [DEFAULT_READINESS_TIMEOUT_MS, ACP_SESSION_READINESS_TIMEOUT_MS]) {
		const queueWaitMs = startupQueueWaitMs(readinessTimeoutMs);
		const callerTimeoutMs = lifecycleRequestTimeoutMs("session.create", { cwd: "/workspace", readinessTimeoutMs });
		for (const queuedMs of [0, Math.floor(queueWaitMs / 2), queueWaitMs]) {
			const preSpawnAllowanceMs = Math.min(DEFAULT_BROKER_PRESPAWN_PREPARATION_TIMEOUT_MS, queueWaitMs - queuedMs);
			expect(queuedMs + preSpawnAllowanceMs + readinessTimeoutMs).toBeLessThanOrEqual(
				(callerTimeoutMs ?? 0) - 1_000,
			);
		}
		expect(callerTimeoutMs).toBe(queueWaitMs + readinessTimeoutMs + 1_000);
	}
	expect(
		lifecycleRequestTimeoutMs("session.create", { readinessTimeoutMs: ACP_SESSION_READINESS_TIMEOUT_MS }),
	).toBeLessThan(ACP_EXTERNAL_CONNECT_TIMEOUT_MS);
});

test("broker pre-spawn bookkeeping does not spend child semantic readiness", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prespawn-budget-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	let now = 1_000_000;
	let spawnCount = 0;
	try {
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
		});
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount += 1;
			throw new Error("stop after spawn authorization");
		});
		await broker.start();
		const transition = broker.ledger.transition.bind(broker.ledger);
		const transitionSpy = spyOn(broker.ledger, "transition").mockImplementation(async (identity, state, fields) => {
			if (state === "effect_started" && fields?.effectIntent) now += 9_000;
			return transition(identity, state, fields);
		});
		try {
			const response = await broker.handleRequest(
				"session.create",
				{
					cwd: root,
					stateRoot: path.join(root, ".gjc", "state"),
					readinessTimeoutMs: 10_000,
				},
				"prespawn-budget",
			);
			expect(spawnCount).toBe(1);
			expect(response).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Record<string, unknown>);
			const intent = rows.find(
				row =>
					(row.effectIntent as { lifecycleCleanupDeadlineAt?: number } | undefined)?.lifecycleCleanupDeadlineAt !==
					undefined,
			)?.effectIntent as { lifecycleCleanupDeadlineAt: number };
			expect(intent.lifecycleCleanupDeadlineAt).toBeGreaterThanOrEqual(
				deriveLifecycleDeadlines(now, 10_000).lifecycleCleanupDeadlineAt,
			);
		} finally {
			transitionSpy.mockRestore();
		}
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("broker pre-spawn preparation has a bounded retryable timeout", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prespawn-cap-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	let now = 1_000_000;
	let spawnCount = 0;
	try {
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
		});
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount += 1;
			throw new Error("unexpected spawn");
		});
		await broker.start();
		const transition = broker.ledger.transition.bind(broker.ledger);
		const transitionSpy = spyOn(broker.ledger, "transition").mockImplementation(async (identity, state, fields) => {
			if (state === "effect_started" && fields?.effectIntent) now += 31_000;
			return transition(identity, state, fields);
		});
		try {
			const response = await broker.handleRequest("session.create", { cwd: root }, "prespawn-cap");
			const message = response.ok ? "" : String(response.error.message);
			expect(spawnCount).toBe(0);
			expect(response).toMatchObject({
				ok: false,
				error: { code: "readiness_timeout", message: expect.stringContaining("pre-spawn preparation") },
			});
			expect(message).toContain("31000 ms");
			expect(message).toContain("10000 ms allowance");
		} finally {
			transitionSpy.mockRestore();
		}
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("queued startup cannot spend more than its remaining admission window on pre-spawn preparation", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prespawn-queued-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	const release = Promise.withResolvers<void>();
	const admissionParked = Promise.withResolvers<void>();
	let now = 1_000_000;
	let spawnCount = 0;
	try {
		await broker.start();
		const holders = Array.from({ length: sdkHostStartupConcurrency() }, () =>
			broker.runStartup(10_000, { now: () => now, sleep: () => Promise.withResolvers<void>().promise }, async () => {
				await release.promise;
			}),
		);
		await Promise.resolve();
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: () => {
				admissionParked.resolve();
				return Promise.withResolvers<void>().promise;
			},
		});
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount++;
			throw new Error("unexpected spawn");
		});
		const transition = broker.ledger.transition.bind(broker.ledger);
		const transitionSpy = spyOn(broker.ledger, "transition").mockImplementation(async (identity, state, fields) => {
			if (state === "effect_started" && fields?.effectIntent) now += 7_000;
			return transition(identity, state, fields);
		});
		try {
			const queued = broker.handleRequest("session.create", { cwd: root }, "prespawn-queued");
			await admissionParked.promise;
			now += 4_000;
			release.resolve();
			await Promise.all(holders);
			const response = await queued;
			expect(spawnCount).toBe(0);
			expect(response).toMatchObject({
				ok: false,
				error: { code: "readiness_timeout", message: expect.stringContaining("6000 ms allowance after 7000 ms") },
			});
		} finally {
			transitionSpy.mockRestore();
			release.resolve();
		}
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("caller-supplied exact deadlines remain strict during pre-spawn bookkeeping", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-prespawn-exact-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	let now = 1_000_000;
	let spawnCount = 0;
	try {
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async ms => {
				now += ms;
			},
		});
		setLifecycleCommandResolverForTest(broker, () => {
			spawnCount += 1;
			throw new Error("unexpected spawn");
		});
		await broker.start();
		const transition = broker.ledger.transition.bind(broker.ledger);
		const transitionSpy = spyOn(broker.ledger, "transition").mockImplementation(async (identity, state, fields) => {
			if (state === "effect_started" && fields?.effectIntent) now += 9_000;
			return transition(identity, state, fields);
		});
		try {
			const response = await broker.handleRequest(
				"session.create",
				{
					cwd: root,
					...deriveLifecycleDeadlines(now, 10_000),
				},
				"prespawn-exact",
			);
			expect(spawnCount).toBe(0);
			expect(response).toMatchObject({
				ok: false,
				error: { code: "readiness_timeout", message: expect.stringContaining("semantic readiness deadline") },
			});
		} finally {
			transitionSpy.mockRestore();
		}
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		setLifecycleTimingForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
