import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectSharedStateRoot } from "../src/gjc-runtime/session-layout";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { SessionIndex, type SessionLocatorV2 } from "../src/sdk/broker/session-index";
import { SessionRouter } from "../src/sdk/router";

const tempDirs: string[] = [];

const fixtureProcessIncarnation = processIncarnation(process.pid);
if (!fixtureProcessIncarnation) throw new Error("Current process incarnation is unavailable.");

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(policy: ConstructorParameters<typeof SessionIndex>[1] = {}) {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-generation-status-"));
	tempDirs.push(agentDir);
	const index = await new SessionIndex(agentDir, policy).open();
	const router = new SessionRouter({ agentDir, deps: { createIndex: () => index } });
	const locator: SessionLocatorV2 = {
		cwd: agentDir,
		worktreeRoot: null,
		stateRoot: projectSharedStateRoot(agentDir),
	};
	return { agentDir, index, locator, router };
}

async function register(
	index: SessionIndex,
	locator: SessionLocatorV2,
	sessionId: string,
	endpointGeneration: number,
	options: { hostIncarnation?: string; ts?: number } = {},
) {
	return await index.append({
		type: "host_registered",
		sessionId,
		locator,
		endpointGeneration,
		pid: process.pid,
		endpointMtimeMs: endpointGeneration * 1_000,
		hostIncarnation: options.hostIncarnation ?? fixtureProcessIncarnation,
		...(options.ts === undefined ? {} : { ts: options.ts }),
	});
}

async function retire(
	index: SessionIndex,
	locator: SessionLocatorV2,
	sessionId: string,
	endpointGeneration: number,
	type: "host_unregistered" | "session_closed" | "session_deleted",
	options: { hostIncarnation?: string; ts?: number } = {},
) {
	return await index.append({
		type,
		sessionId,
		locator,
		endpointGeneration,
		pid: process.pid,
		endpointMtimeMs: endpointGeneration * 1_000,
		hostIncarnation: options.hostIncarnation ?? fixtureProcessIncarnation,
		...(options.ts === undefined ? {} : { ts: options.ts }),
	});
}

describe("SessionRouter exact generation status", () => {
	test("reports the exact live generation as current and keeps reconnects idempotent", async () => {
		const { index, locator, router } = await fixture();
		await register(index, locator, "current-session", 1);

		const first = await router.generationStatus("current-session", 1);
		await register(index, locator, "current-session", 1);
		const reconnected = await router.generationStatus("current-session", 1);

		expect(first).toEqual({
			status: "current",
			evidence: { source: "session_index", observedIndexSeq: 1, evidenceIndexSeq: 1 },
		});
		expect(reconnected).toEqual({
			status: "current",
			evidence: { source: "session_index", observedIndexSeq: 2, evidenceIndexSeq: 2 },
		});
	});

	test("returns positive close and delete retirement evidence after Router stop", async () => {
		const { index, locator, router } = await fixture();
		await register(index, locator, "closed-session", 3);
		await retire(index, locator, "closed-session", 3, "host_unregistered");
		await register(index, locator, "lifecycle-closed-session", 4);
		await retire(index, locator, "lifecycle-closed-session", 4, "session_closed");
		await register(index, locator, "deleted-session", 5);
		await retire(index, locator, "deleted-session", 5, "session_deleted");
		await router.stop();

		expect(await router.generationStatus("closed-session", 3)).toEqual({
			status: "retired",
			evidence: {
				source: "session_index",
				observedIndexSeq: 6,
				evidenceIndexSeq: 2,
				event: "host_unregistered",
			},
		});
		expect(await router.generationStatus("lifecycle-closed-session", 4)).toEqual({
			status: "retired",
			evidence: {
				source: "session_index",
				observedIndexSeq: 6,
				evidenceIndexSeq: 4,
				event: "session_closed",
			},
		});
		expect(await router.generationStatus("deleted-session", 5)).toEqual({
			status: "retired",
			evidence: {
				source: "session_index",
				observedIndexSeq: 6,
				evidenceIndexSeq: 6,
				event: "session_deleted",
			},
		});
	});

	test("reports a positively observed old generation as replaced by a live rehost", async () => {
		const { index, locator, router } = await fixture();
		await register(index, locator, "rehosted-session", 8);
		await retire(index, locator, "rehosted-session", 8, "host_unregistered");
		await register(index, locator, "rehosted-session", 9);

		expect(await router.generationStatus("rehosted-session", 8)).toEqual({
			status: "replaced",
			currentGeneration: 9,
			evidence: { source: "session_index", observedIndexSeq: 3, evidenceIndexSeq: 3 },
		});
		expect((await router.generationStatus("rehosted-session", 9)).status).toBe("current");
	});

	test("classifies unavailable and incomplete reconciliation as unknown", async () => {
		const { agentDir, index, locator, router } = await fixture();
		await index.append({
			type: "lifecycle_terminal",
			sessionId: "uncertain-session",
			locator,
			endpointGeneration: 2,
			pid: process.pid,
			terminalUncertain: true,
		});
		expect(await router.generationStatus("uncertain-session", 2)).toEqual({
			status: "unknown",
			reason: "reconciliation_incomplete",
			evidence: { source: "session_index", observedIndexSeq: 1 },
		});

		class UnavailableIndex extends SessionIndex {
			override async open(): Promise<this> {
				throw new Error("index unavailable");
			}
		}
		const unavailable = new SessionRouter({
			agentDir,
			deps: { createIndex: () => new UnavailableIndex(agentDir) },
		});
		expect(await unavailable.generationStatus("uncertain-session", 2)).toEqual({
			status: "unknown",
			reason: "index_unavailable",
		});
	});

	test("does not infer retirement from absence, unknown sessions, or invalid generations", async () => {
		const { index, locator, router } = await fixture();
		await register(index, locator, "known-session", 5);

		expect(await router.generationStatus("missing-session", 5)).toMatchObject({
			status: "unknown",
			reason: "session_not_observed",
		});
		expect(await router.generationStatus("known-session", 4)).toMatchObject({
			status: "unknown",
			reason: "generation_not_observed",
		});
		expect(await router.generationStatus("known-session", Number.MAX_SAFE_INTEGER + 1)).toEqual({
			status: "unknown",
			reason: "invalid_generation",
		});
	});

	test("keeps competing state-root authority unknown", async () => {
		const { index, locator, router } = await fixture();
		await register(index, locator, "ambiguous-session", 1);
		await register(
			index,
			{ cwd: locator.cwd, worktreeRoot: locator.worktreeRoot, stateRoot: path.join(locator.cwd, "foreign-state") },
			"ambiguous-session",
			2,
		);

		expect(await router.generationStatus("ambiguous-session", 1)).toEqual({
			status: "unknown",
			reason: "ambiguous_authority",
			evidence: { source: "session_index", observedIndexSeq: 2 },
		});
	});

	test("ignores a terminal historical root when the same generation is live on a new root", async () => {
		const { index, locator, router } = await fixture();
		const replacementLocator = {
			cwd: locator.cwd,
			worktreeRoot: locator.worktreeRoot,
			stateRoot: path.join(locator.cwd, "replacement-state"),
		};
		await register(index, locator, "resolved-root-session", 2);
		await retire(index, locator, "resolved-root-session", 2, "host_unregistered");
		await register(index, replacementLocator, "resolved-root-session", 2);

		expect(await router.generationStatus("resolved-root-session", 2)).toEqual({
			status: "current",
			evidence: { source: "session_index", observedIndexSeq: 3, evidenceIndexSeq: 3 },
		});
	});

	test("revalidates process incarnation after replay before reporting current", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-generation-pid-reuse-"));
		tempDirs.push(agentDir);
		const locator: SessionLocatorV2 = {
			cwd: agentDir,
			worktreeRoot: null,
			stateRoot: projectSharedStateRoot(agentDir),
		};
		let running = true;
		let observedIncarnation = "linux:100";
		const index = await new SessionIndex(
			agentDir,
			{},
			{
				retainProcess: () => ({ incarnation: observedIncarnation, isRunning: () => running }),
			},
		).open();
		await register(index, locator, "pid-reuse-session", 6, { hostIncarnation: "linux:100" });
		const router = new SessionRouter({ agentDir, deps: { createIndex: () => index } });

		expect((await router.generationStatus("pid-reuse-session", 6)).status).toBe("current");
		running = false;
		observedIncarnation = "linux:200";
		expect(await router.generationStatus("pid-reuse-session", 6)).toEqual({
			status: "unknown",
			reason: "reconciliation_incomplete",
			evidence: { source: "session_index", observedIndexSeq: 1 },
		});
	});

	test("retries when the index changes between the observation plan and commit", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-generation-plan-race-"));
		tempDirs.push(agentDir);
		const locator: SessionLocatorV2 = {
			cwd: agentDir,
			worktreeRoot: null,
			stateRoot: projectSharedStateRoot(agentDir),
		};
		let index: SessionIndex;
		let raced = false;
		index = await new SessionIndex(
			agentDir,
			{},
			{
				retainProcess: async () => {
					if (!raced) {
						raced = true;
						await index.append({
							type: "host_unregistered",
							sessionId: "plan-race-session",
							locator,
							endpointGeneration: 7,
							pid: process.pid,
							hostIncarnation: "linux:700",
						});
					}
					return { incarnation: "linux:700", isRunning: () => true };
				},
			},
		).open();
		await register(index, locator, "plan-race-session", 7, { hostIncarnation: "linux:700" });
		const router = new SessionRouter({ agentDir, deps: { createIndex: () => index } });

		const status = await router.generationStatus("plan-race-session", 7);
		expect(raced).toBe(true);
		expect(["current", "retired"]).toContain(status.status);
		expect((await router.generationStatus("plan-race-session", 7)).status).toBe("retired");
	});

	test("fails closed without probing when unresolved identity history exceeds the budget", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-generation-probe-budget-"));
		tempDirs.push(agentDir);
		let probes = 0;
		const index = await new SessionIndex(
			agentDir,
			{},
			{
				retainProcess: () => {
					probes += 1;
					return { incarnation: fixtureProcessIncarnation, isRunning: () => true };
				},
			},
		).open();
		for (let generation = 1; generation <= 33; generation++)
			await register(
				index,
				{ cwd: agentDir, worktreeRoot: null, stateRoot: path.join(agentDir, `state-${generation}`) },
				"probe-budget-session",
				generation,
			);
		const router = new SessionRouter({ agentDir, deps: { createIndex: () => index } });

		expect(await router.generationStatus("probe-budget-session", 1)).toEqual({
			status: "unknown",
			reason: "reconciliation_incomplete",
			evidence: { source: "session_index", observedIndexSeq: 33 },
		});
		expect(probes).toBe(0);
	});

	test("fails generation reuse and wrap-like races closed instead of returning retired", async () => {
		const { index, locator, router } = await fixture();
		await register(index, locator, "reused-session", 11, { hostIncarnation: "linux:100" });
		await retire(index, locator, "reused-session", 11, "host_unregistered", {
			hostIncarnation: "linux:100",
		});
		await register(index, locator, "reused-session", 11, { hostIncarnation: "linux:200" });

		expect(await router.generationStatus("reused-session", 11)).toEqual({
			status: "unknown",
			reason: "generation_reused",
			evidence: { source: "session_index", observedIndexSeq: 3 },
		});

		await register(index, locator, "wrapped-session", Number.MAX_SAFE_INTEGER);
		await retire(index, locator, "wrapped-session", Number.MAX_SAFE_INTEGER, "host_unregistered");
		await register(index, locator, "wrapped-session", 1);
		expect(await router.generationStatus("wrapped-session", Number.MAX_SAFE_INTEGER)).toEqual({
			status: "unknown",
			reason: "generation_reused",
			evidence: { source: "session_index", observedIndexSeq: 6 },
		});
	});

	test("duplicate queries are immutable, redacted, and race safely with close", async () => {
		const { index, locator, router } = await fixture();
		await register(index, locator, "racing-session", 12);
		const duringClose = router.generationStatus("racing-session", 12);
		await retire(index, locator, "racing-session", 12, "host_unregistered");
		const raced = await duringClose;
		const afterClose = await router.generationStatus("racing-session", 12);
		const duplicate = await router.generationStatus("racing-session", 12);

		expect(["current", "retired"]).toContain(raced.status);
		expect(afterClose).toEqual(duplicate);
		expect(afterClose.status).toBe("retired");
		const serialized = JSON.stringify(afterClose);
		expect(serialized).not.toContain("token");
		expect(serialized).not.toContain("url");
		expect(serialized).not.toContain("pid");
		expect(serialized).not.toContain(locator.cwd);
		expect(serialized).not.toContain("endpointMtime");
		expect(serialized).not.toContain("incarnation");
		expect(serialized).not.toContain("lifecycleRequest");
		expect(serialized).not.toContain("authority");
	});

	test("retirement survives process restart until retention evicts the whole session", async () => {
		let now = 1;
		const policy = { clock: () => now, maxAgeMs: 10, maxRows: 100, tombstoneRule: "expire" as const };
		const { agentDir, index, locator, router } = await fixture(policy);
		await register(index, locator, "retained-session", 13, { ts: now });
		await retire(index, locator, "retained-session", 13, "host_unregistered", { ts: now });

		const restartedIndex = await new SessionIndex(agentDir, policy).open();
		const restartedRouter = new SessionRouter({ agentDir, deps: { createIndex: () => restartedIndex } });
		expect((await restartedRouter.generationStatus("retained-session", 13)).status).toBe("retired");

		now = 100;
		await register(index, locator, "retention-anchor", 1, { ts: now });
		await index.compact();
		const expiredIndex = await new SessionIndex(agentDir, policy).open();
		const expiredRouter = new SessionRouter({ agentDir, deps: { createIndex: () => expiredIndex } });
		expect(await expiredRouter.generationStatus("retained-session", 13)).toMatchObject({
			status: "unknown",
			reason: "session_not_observed",
		});

		await router.stop();
		await restartedRouter.stop();
		await expiredRouter.stop();
	});

	test("bounds public delete proof even when audit tombstones are retained", async () => {
		let now = 1;
		const policy = { clock: () => now, maxAgeMs: 10, maxRows: 100, tombstoneRule: "retain" as const };
		const { index, locator, router } = await fixture(policy);
		await register(index, locator, "delete-proof-expiry", 14, { ts: now });
		await retire(index, locator, "delete-proof-expiry", 14, "session_deleted", { ts: now });
		expect((await router.generationStatus("delete-proof-expiry", 14)).status).toBe("retired");

		now = 100;
		expect(await router.generationStatus("delete-proof-expiry", 14)).toEqual({
			status: "unknown",
			reason: "proof_expired",
			evidence: { source: "session_index", observedIndexSeq: 2 },
		});
	});
});
