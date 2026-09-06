import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import * as stateWriter from "@gajae-code/coding-agent/gjc-runtime/state-writer";
import {
	checkpointUltragoalGoal,
	createUltragoalPlan,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalReviewBlockers,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import {
	adoptUltragoalSuccession,
	offerUltragoalSuccession,
	readUltragoalSuccessionAdoption,
	readUltragoalSuccessionFence,
	ULTRAGOAL_SUCCESSION_FENCE_SCHEMA,
	UltragoalSuccessionError,
	type UltragoalSuccessionErrorCode,
	ultragoalSuccessionAdoptionPath,
	ultragoalSuccessionFencePath,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-succession";

const SOURCE_SESSION = "succession-source-session";
const TARGET_SESSION = "succession-target-session";

const tempRoots: string[] = [];
let savedSessionId: string | undefined;
let savedSessionFile: string | undefined;

beforeEach(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	savedSessionFile = process.env.GJC_SESSION_FILE;
	process.env.GJC_SESSION_ID = SOURCE_SESSION;
	delete process.env.GJC_SESSION_FILE;
});

afterEach(async () => {
	if (savedSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = savedSessionId;
	if (savedSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
	else process.env.GJC_SESSION_FILE = savedSessionFile;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Synthetic git repository. Two of these stand in for the "source repository A /
 * target repository B" pair the feature exists for; no production state is ever
 * touched.
 */
async function tempRepo(label: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ultragoal-succession-${label}-`)));
	tempRoots.push(dir);
	await Bun.$`git init -q`.cwd(dir).quiet();
	await Bun.$`git config user.email fixture@example.invalid`.cwd(dir).quiet();
	await Bun.$`git config user.name Fixture`.cwd(dir).quiet();
	await Bun.write(path.join(dir, "README.md"), `${label}\n`);
	await Bun.$`git add -A`.cwd(dir).quiet();
	await Bun.$`git commit -q -m init`.cwd(dir).quiet();
	return dir;
}

const SOURCE_BRIEF = [
	"Ship the payment reconciliation service.",
	"",
	"Constraint: settlement rows must stay immutable once posted.",
	"Constraint: every refund needs a dual-control approval trail.",
	"",
	"@goal: Land the ledger writer",
	"Persist settlement rows through the audited writer only.",
	"",
	"@goal: Land the refund approval path",
	"Dual-control approval must be enforced server side, not in the client.",
	"",
	"@goal: Land the reconciliation report",
	"Daily report must reconcile against the upstream processor totals.",
].join("\n");

async function seedSourcePlan(cwd: string): Promise<void> {
	process.env.GJC_SESSION_ID = SOURCE_SESSION;
	await createUltragoalPlan({ cwd, brief: SOURCE_BRIEF, sessionId: SOURCE_SESSION });
}

function sourceArtifactPaths(cwd: string): { brief: string; goals: string; ledger: string } {
	const dir = sessionUltragoalDir(cwd, SOURCE_SESSION);
	return {
		brief: path.join(dir, "brief.md"),
		goals: path.join(dir, "goals.json"),
		ledger: path.join(dir, "ledger.jsonl"),
	};
}

async function sha256File(filePath: string): Promise<string> {
	return createHash("sha256")
		.update(await fs.readFile(filePath))
		.digest("hex");
}

async function sourceDigests(cwd: string): Promise<Record<string, string>> {
	const paths = sourceArtifactPaths(cwd);
	return {
		brief: await sha256File(paths.brief),
		goals: await sha256File(paths.goals),
		ledger: await sha256File(paths.ledger),
	};
}

const AUTHORIZATION = "Leader authorized moving the refund and reconciliation stories to the payments-api repository.";
const AUTHORIZED_BY = "human:release-lead";

async function offer(
	sourceRepo: string,
	targetRepo: string,
	goalIds: string[],
	overrides: { authorization?: string; authorizedBy?: string } = {},
) {
	process.env.GJC_SESSION_ID = SOURCE_SESSION;
	return await offerUltragoalSuccession({
		cwd: sourceRepo,
		sessionId: SOURCE_SESSION,
		targetRepositoryPath: targetRepo,
		goalIds,
		authorization: overrides.authorization ?? AUTHORIZATION,
		authorizedBy: overrides.authorizedBy ?? AUTHORIZED_BY,
	});
}

async function adopt(targetRepo: string, offerPath: string, sessionId = TARGET_SESSION) {
	process.env.GJC_SESSION_ID = sessionId;
	return await adoptUltragoalSuccession({ cwd: targetRepo, sessionId, offerPath });
}

async function expectSuccessionError(
	promise: Promise<unknown>,
	code: UltragoalSuccessionErrorCode,
): Promise<UltragoalSuccessionError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(UltragoalSuccessionError);
	const error = caught as UltragoalSuccessionError;
	expect(error.code).toBe(code);
	return error;
}

/**
 * Write a fence by hand at the documented durable path. These tests pin the
 * on-disk admission contract independently of the writer that produces it: a
 * fence present on disk must stop the source from executing the fenced goal.
 */
async function plantFence(cwd: string, goalIds: string[]): Promise<void> {
	const fencePath = ultragoalSuccessionFencePath(cwd, SOURCE_SESSION);
	await fs.mkdir(path.dirname(fencePath), { recursive: true });
	await Bun.write(
		fencePath,
		`${JSON.stringify(
			{
				schema: ULTRAGOAL_SUCCESSION_FENCE_SCHEMA,
				operationId: "f".repeat(64),
				createdAt: new Date().toISOString(),
				sourceSessionId: SOURCE_SESSION,
				sourceRepository: { schema: "gjc.repository_binding.v1", worktreeRoot: cwd, commonDir: null },
				targetRepository: {
					schema: "gjc.repository_binding.v1",
					worktreeRoot: path.join(cwd, "..", "elsewhere"),
					commonDir: null,
				},
				selectedGoalIds: goalIds,
				sourceArtifacts: { briefSha256: "", goalsSha256: "", ledgerSha256: "" },
				offerPath: path.join(cwd, "offer.json"),
				offerSha256: "0".repeat(64),
			},
			null,
			2,
		)}\n`,
	);
}

describe("ultragoal succession — source ownership fence is honored by admission", () => {
	it("refuses to schedule a fenced goal", async () => {
		const source = await tempRepo("source");
		await seedSourcePlan(source);

		await plantFence(source, ["G001"]);

		await expect(startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION })).rejects.toThrow(
			/handed off|succession|fence/iu,
		);
	});

	it("refuses to checkpoint a fenced goal", async () => {
		const source = await tempRepo("source");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });

		await plantFence(source, ["G001"]);

		await expect(
			checkpointUltragoalGoal({
				cwd: source,
				goalId: "G001",
				status: "blocked",
				evidence: "waiting on the successor run",
			}),
		).rejects.toThrow(/handed off|succession|fence/iu);
	});

	it("leaves goals outside the fenced selection schedulable", async () => {
		const source = await tempRepo("source");
		await seedSourcePlan(source);

		await plantFence(source, ["G002", "G003"]);

		const started = await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
		expect(started.goal?.id).toBe("G001");
	});
});

/**
 * Suspend the first sanctioned write to one durable goals.json, so a test can
 * hold a caller inside its critical section and schedule a second caller
 * against it deterministically. The barrier only delays the real writer; it
 * disables no guard.
 */
function barrierOnGoalsWrite(goalsPath: string): {
	entered: Promise<void>;
	release: () => void;
	restore: () => void;
} {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const original = stateWriter.writeGuardedJsonAtomic;
	let intercepted = false;
	const spy = spyOn(stateWriter, "writeGuardedJsonAtomic").mockImplementation(async (file, value, options) => {
		if (file === goalsPath && !intercepted) {
			intercepted = true;
			entered.resolve();
			await release.promise;
		}
		return await original(file, value, options);
	});
	return {
		entered: entered.promise,
		release: () => release.resolve(),
		restore: () => {
			release.resolve();
			spy.mockRestore();
		},
	};
}

/** Resolve to `"blocked"` when `promise` is still pending after a real delay. */
async function stillPendingAfter(promise: Promise<unknown>, ms: number): Promise<"blocked" | "settled"> {
	return await Promise.race([promise.then(() => "settled" as const), Bun.sleep(ms).then(() => "blocked" as const)]);
}

describe("ultragoal succession — source ownership is exclusive against in-flight execution", () => {
	it("refuses an offer that races an already in-flight source start, leaving exactly one owner", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const barrier = barrierOnGoalsWrite(sourceArtifactPaths(source).goals);

		try {
			// The source start has passed its fence check and is inside its writer,
			// but has not yet committed `active`. Point-in-time quiescence would read
			// `pending` here and wrongly conclude the run is idle.
			const startPromise = startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
			const observedStart = startPromise.then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);
			await barrier.entered;

			const offerPromise = offer(source, target, ["G001"]).then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);

			// Exclusion, not luck: the offer cannot reach a verdict at all while the
			// source start holds ownership of the plan.
			expect(await stillPendingAfter(offerPromise, 300)).toBe("blocked");

			barrier.release();
			const started = await observedStart;
			const offered = await offerPromise;

			expect(started.ok).toBe(true);
			expect(offered.ok).toBe(false);
			if (!offered.ok) {
				expect(offered.error).toBeInstanceOf(UltragoalSuccessionError);
				expect((offered.error as UltragoalSuccessionError).code).toBe("source_not_quiescent");
			}
			// One owner: the source kept the goal and no fence was ever issued.
			expect(await readUltragoalSuccessionFence(source, SOURCE_SESSION)).toBeNull();
			const plan = await readUltragoalPlan(source, SOURCE_SESSION);
			expect(plan?.goals[0]?.status).toBe("active");
		} finally {
			barrier.restore();
		}
	});

	it("refuses a fenced goal before completion validation runs", async () => {
		const source = await tempRepo("source");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
		await plantFence(source, ["G001"]);

		// Refusal is decided up front, so a handed-off goal never pays for a
		// completion capture. The quality gate below is deliberate nonsense: reaching
		// it at all would mean the pre-check no longer runs before validation.
		await expectSuccessionError(
			checkpointUltragoalGoal({
				cwd: source,
				goalId: "G001",
				status: "complete",
				evidence: "completed after the goal was handed off",
				qualityGateJson: JSON.stringify({ not: "a quality gate" }),
			}),
			"goal_handed_off",
		);
	});

	it("refuses to commit a checkpoint for a goal fenced after its pre-checks", async () => {
		const source = await tempRepo("source");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });

		// Completion validation is slow, and only an *active* goal blocks an offer:
		// a goal checkpointed from `failed`, or one whose validation outlasts the
		// status it was read at, can legitimately be fenced in that window. An offer
		// writes no source bytes, so the plan's compare-and-swap cannot observe the
		// fence — the commit must re-assert ownership itself. Planting at the moment
		// the commit takes the plan lock reproduces exactly that window.
		const original = stateWriter.withWorkflowStateLock;
		let planted = false;
		const spy = spyOn(stateWriter, "withWorkflowStateLock").mockImplementation(async (file, fn, options) => {
			if (file === sourceArtifactPaths(source).goals && !planted) {
				planted = true;
				await plantFence(source, ["G001"]);
			}
			return await original(file, fn, options);
		});

		try {
			await expectSuccessionError(
				checkpointUltragoalGoal({
					cwd: source,
					goalId: "G001",
					status: "blocked",
					evidence: "checkpointed while a successor claimed the goal",
				}),
				"goal_handed_off",
			);
		} finally {
			spy.mockRestore();
		}

		expect(planted).toBe(true);
		// The handed-off goal keeps the status the successor inherited; the source
		// records neither the checkpoint nor a ledger event for it.
		const plan = await readUltragoalPlan(source, SOURCE_SESSION);
		expect(plan?.goals[0]?.status).toBe("active");
		const ledger = await readUltragoalLedger(source);
		expect(ledger.some(event => event.event === "goal_checkpointed")).toBe(false);
	});

	it("refuses an in-flight source checkpoint that races an offer, leaving the plan consistent", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
		const barrier = barrierOnGoalsWrite(sourceArtifactPaths(source).goals);

		try {
			const checkpointPromise = checkpointUltragoalGoal({
				cwd: source,
				goalId: "G001",
				status: "blocked",
				evidence: "paused while the successor question is decided",
			}).then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);
			await barrier.entered;

			const offerPromise = offer(source, target, ["G001"]).then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);
			expect(await stillPendingAfter(offerPromise, 300)).toBe("blocked");

			barrier.release();
			expect((await checkpointPromise).ok).toBe(true);
			const offered = await offerPromise;

			// The checkpoint committed `blocked`, which is adoptable, so the offer is
			// now legitimate — but it only ever decided against the committed plan.
			expect(offered.ok).toBe(true);
			const plan = await readUltragoalPlan(source, SOURCE_SESSION);
			expect(plan?.goals[0]?.status).toBe("blocked");
			const fence = await readUltragoalSuccessionFence(source, SOURCE_SESSION);
			expect(fence?.selectedGoalIds).toEqual(["G001"]);
		} finally {
			barrier.restore();
		}
	});

	it("never resets target progress when identical same-session adoption retries race a started run", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002", "G003"]);
		await adopt(target, offered.offerPath);

		process.env.GJC_SESSION_ID = TARGET_SESSION;
		await startNextUltragoalGoal({ cwd: target, sessionId: TARGET_SESSION });
		const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(target, TARGET_SESSION), "goals.json")).text();

		const retries = await Promise.allSettled([
			adoptUltragoalSuccession({ cwd: target, sessionId: TARGET_SESSION, offerPath: offered.offerPath }),
			adoptUltragoalSuccession({ cwd: target, sessionId: TARGET_SESSION, offerPath: offered.offerPath }),
		]);
		for (const outcome of retries) {
			expect(outcome.status).toBe("fulfilled");
			if (outcome.status === "fulfilled") expect(outcome.value.reconciled).toBe(true);
		}

		// The started goal must survive both retries byte-for-byte.
		const plan = await readUltragoalPlan(target, TARGET_SESSION);
		expect(plan?.goals[0]?.status).toBe("active");
		expect(await Bun.file(path.join(sessionUltragoalDir(target, TARGET_SESSION), "goals.json")).text()).toBe(
			beforeGoals,
		);
	});

	it("publishes one plan that matches its own recorded digest when two first adoptions race in one session", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		// Two first-time adoptions, same session, no prior claim. Each would
		// otherwise pin its own `plannedAt`, publish a different plan, and record a
		// digest for a plan the other one overwrote — leaving the adoption record
		// describing bytes that are not on disk, which is exactly what pending-replay
		// reconciliation trusts.
		process.env.GJC_SESSION_ID = TARGET_SESSION;
		const outcomes = await Promise.allSettled([
			adoptUltragoalSuccession({ cwd: target, sessionId: TARGET_SESSION, offerPath: offered.offerPath }),
			adoptUltragoalSuccession({ cwd: target, sessionId: TARGET_SESSION, offerPath: offered.offerPath }),
		]);
		expect(outcomes.filter(outcome => outcome.status === "fulfilled").length).toBe(2);

		const adoption = await readUltragoalSuccessionAdoption(target, TARGET_SESSION);
		expect(adoption).not.toBeNull();
		expect(adoption?.status).toBe("published");
		const plannedAt = adoption?.plannedAt ?? "";
		expect(plannedAt).not.toBe("");
		const publishedPlan = await readUltragoalPlan(target, TARGET_SESSION);
		expect(publishedPlan).not.toBeNull();
		// The published plan must be the one the adoption record describes; two
		// unsynchronised publications would leave the record pinned to bytes the
		// other caller overwrote.
		expect(publishedPlan?.createdAt).toBe(plannedAt);
		expect(publishedPlan?.goals.map(goal => goal.createdAt)).toEqual([plannedAt]);
	});
});

describe("ultragoal succession — offer preserves the source and requires bounded authorization", () => {
	it("writes a fence and an offer without changing one byte of the source brief, goals or ledger", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const before = await sourceDigests(source);

		const result = await offer(source, target, ["G002", "G003"]);

		expect(result.reconciled).toBe(false);
		expect(result.operationId).toMatch(/^[0-9a-f]{64}$/u);
		expect(await sourceDigests(source)).toEqual(before);

		const fence = await readUltragoalSuccessionFence(source, SOURCE_SESSION);
		expect(fence?.operationId).toBe(result.operationId);
		expect(fence?.selectedGoalIds).toEqual(["G002", "G003"]);
		expect(fence?.sourceArtifacts.goalsSha256).toBe(before.goals);
	});

	it("records the source and target identity, the selection and verified source digests", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const digests = await sourceDigests(source);

		const { offer: document } = await offer(source, target, ["G002"]);

		expect(document.source.sessionId).toBe(SOURCE_SESSION);
		expect(document.source.repository.worktreeRoot).toBe(source);
		expect(document.target.repository.worktreeRoot).toBe(target);
		expect(document.selection.goalIds).toEqual(["G002"]);
		expect(document.source.artifacts).toEqual({
			briefSha256: digests.brief,
			goalsSha256: digests.goals,
			ledgerSha256: digests.ledger,
		});
		expect(document.authorization.statement).toBe(AUTHORIZATION);
		expect(document.authorization.authorizedBy).toBe(AUTHORIZED_BY);
	});

	it("carries the full source brief and every unresolved obligation, never a shrunken summary", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
		await checkpointUltragoalGoal({
			cwd: source,
			goalId: "G001",
			status: "blocked",
			evidence: "upstream processor sandbox credentials are not provisioned",
		});
		await runNativeUltragoalCommand(
			[
				"classify-blocker",
				"--classification",
				"human_blocked",
				"--evidence",
				"a human must provision the processor sandbox credentials",
				"--goal-id",
				"G001",
			],
			source,
		);

		const { offer: document } = await offer(source, target, ["G001"]);

		expect(document.carryover.brief).toBe(SOURCE_BRIEF);
		const carried = document.carryover.goals[0];
		expect(carried?.sourceGoalId).toBe("G001");
		expect(carried?.objective).toBe("Persist settlement rows through the audited writer only.");
		expect(carried?.sourceStatusAtOffer).toBe("blocked");
		expect(carried?.unresolvedObligations.join("\n")).toContain(
			"upstream processor sandbox credentials are not provisioned",
		);
		expect(carried?.unresolvedObligations.join("\n")).toContain(
			"a human must provision the processor sandbox credentials",
		);
	});

	it("carries unresolved terminal-critic blockers forward instead of dropping them with the receipts", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
		await checkpointUltragoalGoal({
			cwd: source,
			goalId: "G001",
			status: "failed",
			evidence: "terminal critic rejected the run",
		});
		const recorded = await runNativeUltragoalCommand(
			[
				"record-critic-verdict",
				"--terminus",
				"completion",
				"--verdict",
				"REJECT",
				"--evidence",
				"the settlement writer still bypasses the audited path",
				"--goal-id",
				"G001",
				"--blockers-json",
				JSON.stringify([
					"settlement rows are still written through the unaudited path",
					"refund dual-control is enforced only in the client",
				]),
			],
			source,
		);
		expect(recorded.status).toBe(0);

		const offered = await offer(source, target, ["G001"]);
		const carried = offered.offer.carryover.goals[0];
		// The critic verdict itself is authority and stays behind; the blockers it
		// recorded are unmet requirements and must travel.
		expect(carried?.unresolvedObligations.join("\n")).toContain(
			"settlement rows are still written through the unaudited path",
		);
		expect(carried?.unresolvedObligations.join("\n")).toContain("refund dual-control is enforced only in the client");

		const adopted = await adopt(target, offered.offerPath);
		expect(adopted.plan.goals[0]?.objective).toContain(
			"settlement rows are still written through the unaudited path",
		);
		// No inherited critic authority: the successor ledger carries no verdict.
		const ledger = await readUltragoalLedger(target, TARGET_SESSION);
		expect(ledger.some(event => event.event === "critic_verdict")).toBe(false);
	});

	it("rejects an empty, missing or completed selection and unknown goal ids", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);

		await expectSuccessionError(offer(source, target, []), "invalid_selection");
		await expectSuccessionError(offer(source, target, ["G404"]), "invalid_selection");

		// Complete G001 through the ordinary runtime path, then try to select it.
		const plan = await readUltragoalPlan(source, SOURCE_SESSION);
		expect(plan).not.toBeNull();
		if (plan) {
			plan.goals[0].status = "complete";
			plan.goals[0].completedAt = new Date().toISOString();
			await Bun.write(sourceArtifactPaths(source).goals, `${JSON.stringify(plan, null, 2)}\n`);
		}
		await expectSuccessionError(offer(source, target, ["G001"]), "invalid_selection");
	});

	it("requires a quiescent source run and refuses while any goal is active", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });

		await expectSuccessionError(offer(source, target, ["G002"]), "source_not_quiescent");
	});

	it("requires an explicit bounded authorization statement and authorizing identity", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);

		await expectSuccessionError(offer(source, target, ["G002"], { authorization: "   " }), "authorization_required");
		await expectSuccessionError(offer(source, target, ["G002"], { authorizedBy: "" }), "authorization_required");
	});

	it("refuses a target that is the source repository itself", async () => {
		const source = await tempRepo("source");
		await seedSourcePlan(source);

		await expectSuccessionError(offer(source, source, ["G002"]), "unsafe_target");
	});

	it("refuses a selection that takes only part of a source validation batch", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		process.env.GJC_SESSION_ID = SOURCE_SESSION;
		await createUltragoalPlan({
			cwd: source,
			brief: SOURCE_BRIEF,
			sessionId: SOURCE_SESSION,
			validationBatches: [{ schemaVersion: 1, batchId: "B1", memberIds: ["G002", "G003"], finalGoalId: "G003" }],
		});

		const error = await expectSuccessionError(offer(source, target, ["G002"]), "invalid_selection");
		expect(error.message).toContain("B1");
		expect(error.message).toContain("G003");

		// Taking the whole group is allowed, and the obligation travels with it.
		const offered = await offer(source, target, ["G002", "G003"]);
		expect(offered.offer.carryover.goals[0]?.dependencyGroups).toEqual([
			{ kind: "validation-batch", groupId: "B1", memberSourceGoalIds: ["G002", "G003"], finalSourceGoalId: "G003" },
		]);

		await adopt(target, offered.offerPath);
		const plan = await readUltragoalPlan(target, TARGET_SESSION);
		// The requirement survives with explicit source -> target id mapping, while
		// the source's own batch metadata and receipts do not.
		expect(plan?.goals[0]?.objective).toContain("Validation group B1");
		expect(plan?.goals[0]?.objective).toContain("G002 -> G001");
		expect(plan?.goals[0]?.objective).toContain("G003 -> G002");
		expect(plan?.goals.every(goal => goal.validationBatch === undefined)).toBe(true);
	});

	it("refuses to split an unresolved review blocker from the goal it blocks", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
		await checkpointUltragoalGoal({
			cwd: source,
			goalId: "G001",
			status: "review_blocked",
			evidence: "review found an unresolved dual-control gap",
		});
		await recordUltragoalReviewBlockers({
			cwd: source,
			goalId: "G001",
			title: "Resolve review blockers",
			objective: "Close the dual-control gap the review found",
			evidence: "review findings recorded against G001",
		});

		const plan = await readUltragoalPlan(source, SOURCE_SESSION);
		const blocker = plan?.goals.find(goal => goal.steering?.kind === "review_blocker");
		expect(blocker).toBeDefined();

		const error = await expectSuccessionError(offer(source, target, [blocker?.id ?? ""]), "invalid_selection");
		expect(error.message).toContain("G001");
	});

	it("never writes to the source while reading a legacy plan shape, and rejects an unreadable one without writes", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);

		// A legacy-shaped plan: enumerated aggregate objective plus alias list, the
		// exact shape that historically attracted a read-time migration writer.
		const goalsPath = sourceArtifactPaths(source).goals;
		const legacy = JSON.parse(await fs.readFile(goalsPath, "utf-8")) as Record<string, unknown>;
		legacy.gjcObjective = "Complete goals G001, G002, G003 of the ultragoal run";
		legacy.gjcObjectiveAliases = ["Complete all ultragoal goals"];
		await Bun.write(goalsPath, `${JSON.stringify(legacy, null, 2)}\n`);
		const before = await sourceDigests(source);

		const offered = await offer(source, target, ["G002"]);
		expect(await sourceDigests(source)).toEqual(before);
		await adopt(target, offered.offerPath);
		expect(await sourceDigests(source)).toEqual(before);

		// An unsupported shape must reject without writing anything either.
		const broken = await tempRepo("broken");
		await seedSourcePlan(broken);
		const brokenGoals = sourceArtifactPaths(broken).goals;
		await Bun.write(brokenGoals, "{ this is not valid json\n");
		const brokenBefore = await sourceDigests(broken);
		await expect(offer(broken, target, ["G002"])).rejects.toThrow();
		expect(await sourceDigests(broken)).toEqual(brokenBefore);
	});

	it("refuses a target path that does not exist", async () => {
		const source = await tempRepo("source");
		await seedSourcePlan(source);

		await expectSuccessionError(offer(source, path.join(source, "..", "absent-repo"), ["G002"]), "unsafe_target");
	});

	it("reconciles an identical retry and fails closed on a divergent one", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		const other = await tempRepo("other");
		await seedSourcePlan(source);

		const first = await offer(source, target, ["G002", "G003"]);
		const retry = await offer(source, target, ["G003", "G002"]);
		expect(retry.reconciled).toBe(true);
		expect(retry.operationId).toBe(first.operationId);

		await expectSuccessionError(offer(source, target, ["G002"]), "divergent_operation");
		await expectSuccessionError(offer(source, other, ["G002", "G003"]), "divergent_operation");
	});
});

describe("ultragoal succession — adoption establishes fresh target authority", () => {
	it("publishes a successor plan bound to the target repository with fresh pending goals", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const before = await sourceDigests(source);

		const offered = await offer(source, target, ["G002", "G003"]);
		const adopted = await adopt(target, offered.offerPath);

		expect(adopted.reconciled).toBe(false);
		expect(adopted.goalMap).toEqual([
			{ sourceGoalId: "G002", targetGoalId: "G001" },
			{ sourceGoalId: "G003", targetGoalId: "G002" },
		]);

		const plan = await readUltragoalPlan(target, TARGET_SESSION);
		expect(plan?.repositoryBinding?.worktreeRoot).toBe(target);
		expect(plan?.goals.map(goal => goal.status)).toEqual(["pending", "pending"]);
		expect(plan?.goals.every(goal => goal.completionVerification === undefined)).toBe(true);
		expect(plan?.goals.every(goal => goal.validationBatch === undefined)).toBe(true);
		expect(plan?.goals.every(goal => goal.evidence === undefined)).toBe(true);
		expect(plan?.goals.every(goal => goal.steering === undefined)).toBe(true);
		expect(plan?.goals.every(goal => goal.completedAt === undefined)).toBe(true);

		// The successor is a real successor: the original objectives survive verbatim.
		expect(plan?.goals[0]?.objective).toContain(
			"Dual-control approval must be enforced server side, not in the client.",
		);
		expect(plan?.brief).toContain(SOURCE_BRIEF);

		// The source is untouched, and its own binding is unchanged.
		expect(await sourceDigests(source)).toEqual(before);
		const sourcePlan = await readUltragoalPlan(source, SOURCE_SESSION);
		expect(sourcePlan?.repositoryBinding?.worktreeRoot).toBe(source);
		expect(sourcePlan?.goals.map(goal => goal.id)).toEqual(["G001", "G002", "G003"]);
	});

	it("records provenance without granting the successor any inherited completion authority", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const digests = await sourceDigests(source);

		const offered = await offer(source, target, ["G002"]);
		await adopt(target, offered.offerPath);

		const adoption = await readUltragoalSuccessionAdoption(target, TARGET_SESSION);
		expect(adoption?.status).toBe("published");
		expect(adoption?.operationId).toBe(offered.operationId);
		expect(adoption?.targetSessionId).toBe(TARGET_SESSION);
		expect(adoption?.targetRepository.worktreeRoot).toBe(target);
		expect(adoption?.source.sessionId).toBe(SOURCE_SESSION);
		expect(adoption?.source.repository.worktreeRoot).toBe(source);
		expect(adoption?.source.artifacts.goalsSha256).toBe(digests.goals);
		expect(adoption?.goalMap).toEqual([{ sourceGoalId: "G002", targetGoalId: "G001" }]);
	});

	it("fails closed when the offered work itself changed after the offer was recorded", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		// Rewrite the objective of a *selected* goal: the carryover is no longer a
		// truthful account of what the target would be adopting.
		const goalsPath = sourceArtifactPaths(source).goals;
		const plan = JSON.parse(await fs.readFile(goalsPath, "utf-8")) as {
			goals: Array<{ id: string; objective: string }>;
		};
		const selected = plan.goals.find(goal => goal.id === "G002");
		if (selected) selected.objective = `${selected.objective} Additionally, approvals may be client side.`;
		await Bun.write(goalsPath, `${JSON.stringify(plan, null, 2)}\n`);

		await expectSuccessionError(adopt(target, offered.offerPath), "source_changed");
	});

	it("fails closed when a selected goal gains a new unresolved obligation after the offer", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		await fs.appendFile(
			sourceArtifactPaths(source).ledger,
			`${JSON.stringify({
				eventId: "late-blocker",
				event: "blocker_classified",
				goalId: "G002",
				classification: "human_blocked",
				evidence: "legal must sign off on the dual-control flow",
			})}\n`,
		);

		await expectSuccessionError(adopt(target, offered.offerPath), "source_changed");
	});

	it("does not strand the offer when the source makes progress on goals it did not hand off", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		// G001 was never handed off, so the source rightly keeps working on it.
		// That moves whole-file goals.json and ledger.jsonl digests.
		await startNextUltragoalGoal({ cwd: source, sessionId: SOURCE_SESSION });
		await checkpointUltragoalGoal({
			cwd: source,
			goalId: "G001",
			status: "blocked",
			evidence: "unrelated source progress after the handoff was recorded",
		});
		const driftedDigests = await sourceDigests(source);
		expect(driftedDigests.goals).not.toBe(offered.offer.source.artifacts.goalsSha256);

		const adopted = await adopt(target, offered.offerPath);
		expect(adopted.reconciled).toBe(false);

		// The drift is not hidden — it is recorded as provenance in the adoption.
		const adoption = await readUltragoalSuccessionAdoption(target, TARGET_SESSION);
		expect(adoption?.source.unselectedDrift).toEqual(["goals.json", "ledger.jsonl"]);
		expect(adoption?.source.artifacts.goalsSha256).toBe(offered.offer.source.artifacts.goalsSha256);
		expect(adoption?.source.artifactsAtAdoption.goalsSha256).toBe(driftedDigests.goals);
	});

	it("fails closed when a single character of carried requirement text is tampered with", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		const document = JSON.parse(await fs.readFile(offered.offerPath, "utf-8")) as {
			carryover: { goals: Array<{ objective: string }> };
		};
		document.carryover.goals[0].objective = document.carryover.goals[0].objective.replace("not in the client", "");
		await Bun.write(offered.offerPath, `${JSON.stringify(document, null, 2)}\n`);

		await expectSuccessionError(adopt(target, offered.offerPath), "offer_untrusted");
	});

	it("fails closed when the source fence is absent, so a copied offer alone never authorizes adoption", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		await fs.rm(ultragoalSuccessionFencePath(source, SOURCE_SESSION));

		await expectSuccessionError(adopt(target, offered.offerPath), "fence_missing");
	});

	it("fails closed when adopted in a repository the offer does not name", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		const wrong = await tempRepo("wrong");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		const error = await expectSuccessionError(adopt(wrong, offered.offerPath), "target_mismatch");
		// An unrelated repository fails the repository-identity check, not the
		// narrower worktree pin below; the two guards must stay distinguishable.
		expect(error.message).toContain("is not the target the succession offer names");
		expect(error.message).not.toContain("shares a repository");
	});

	it("refuses a linked worktree of the named target, so one operation cannot take two local claims", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		// A linked worktree shares the target's git identity, so the binding match
		// alone would admit it — but it keeps its own .gjc, so the repository-wide
		// claim would not be repository-wide at all.
		const linked = path.join(path.dirname(target), `${path.basename(target)}-linked`);
		tempRoots.push(linked);
		await Bun.$`git worktree add -q -b succession-linked ${linked}`.cwd(target).quiet();

		const error = await expectSuccessionError(
			adoptUltragoalSuccession({ cwd: linked, sessionId: TARGET_SESSION, offerPath: offered.offerPath }),
			"target_mismatch",
		);
		expect(error.message).toContain("shares a repository");

		// The named worktree still adopts cleanly, and it is the only owner.
		const adopted = await adopt(target, offered.offerPath);
		expect(adopted.reconciled).toBe(false);
		expect(await readUltragoalPlan(linked, TARGET_SESSION)).toBeNull();
	});

	it("fails closed on an occupied target session", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		process.env.GJC_SESSION_ID = TARGET_SESSION;
		await createUltragoalPlan({ cwd: target, brief: "Unrelated existing run.", sessionId: TARGET_SESSION });

		await expectSuccessionError(adopt(target, offered.offerPath), "target_occupied");
	});

	it("rejects an offer path that escapes the source worktree through a symlink", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		const outside = await tempRepo("outside");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		const smuggled = path.join(outside, "offer.json");
		await fs.copyFile(offered.offerPath, smuggled);
		const link = path.join(source, "linked-offer.json");
		await fs.symlink(smuggled, link);

		await expectSuccessionError(adopt(target, link), "offer_path_escape");
	});

	it("reconciles an identical adoption retry and fails closed on a divergent one", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		const first = await adopt(target, offered.offerPath);
		const retry = await adopt(target, offered.offerPath);
		expect(retry.reconciled).toBe(true);
		expect(retry.operationId).toBe(first.operationId);

		const plan = await readUltragoalPlan(target, TARGET_SESSION);
		expect(plan?.goals).toHaveLength(1);

		// A different recorded operation must never be resumed into this claim.
		const adoptionPath = ultragoalSuccessionAdoptionPath(target, TARGET_SESSION);
		const claim = JSON.parse(await fs.readFile(adoptionPath, "utf-8")) as { operationId: string };
		claim.operationId = "a".repeat(64);
		await Bun.write(adoptionPath, `${JSON.stringify(claim, null, 2)}\n`);

		await expectSuccessionError(adopt(target, offered.offerPath), "duplicate_adoption");
	});

	it("rejects a sequential second-session adoption in the same target repository", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		await adopt(target, offered.offerPath, TARGET_SESSION);

		await expectSuccessionError(adopt(target, offered.offerPath, "second-target-session"), "duplicate_adoption");
	});

	it("creates exactly one owner when two sessions adopt the same operation simultaneously", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);

		// Genuinely simultaneous. A scan-then-claim implementation lets both
		// sessions observe an empty registry and each create its own session-local
		// claim, producing two owners for one operation.
		delete process.env.GJC_SESSION_ID;
		const outcomes = await Promise.allSettled(
			[TARGET_SESSION, `${TARGET_SESSION}-second`].map(sessionId =>
				adoptUltragoalSuccession({ cwd: target, sessionId, offerPath: offered.offerPath }),
			),
		);

		expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
		const refused = outcomes.find(outcome => outcome.status === "rejected");
		expect(refused?.status).toBe("rejected");
		if (refused?.status === "rejected") {
			expect((refused.reason as UltragoalSuccessionError).code).toBe("duplicate_adoption");
		}
	});

	it("refuses to execute a target whose adoption is still pending publication", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);
		await adopt(target, offered.offerPath);

		// A crash between publishing goals.json and marking the claim published
		// leaves a visible plan with an unpublished claim. The plan is not
		// admission evidence.
		const adoptionPath = ultragoalSuccessionAdoptionPath(target, TARGET_SESSION);
		const claim = JSON.parse(await fs.readFile(adoptionPath, "utf-8")) as Record<string, unknown>;
		claim.status = "pending";
		delete claim.publishedAt;
		await Bun.write(adoptionPath, `${JSON.stringify(claim, null, 2)}\n`);

		const targetPaths = {
			goals: path.join(sessionUltragoalDir(target, TARGET_SESSION), "goals.json"),
			ledger: path.join(sessionUltragoalDir(target, TARGET_SESSION), "ledger.jsonl"),
		};
		const before = await Promise.all([
			fs.readFile(targetPaths.goals, "utf-8"),
			fs.readFile(targetPaths.ledger, "utf-8"),
		]);

		await expect(startNextUltragoalGoal({ cwd: target, sessionId: TARGET_SESSION })).rejects.toThrow(
			/pending|unpublished|adoption/iu,
		);
		await expect(
			checkpointUltragoalGoal({ cwd: target, goalId: "G001", status: "blocked", evidence: "should be refused" }),
		).rejects.toThrow(/pending|unpublished|adoption/iu);

		// A refused admission must not have mutated durable workflow state.
		expect(
			await Promise.all([fs.readFile(targetPaths.goals, "utf-8"), fs.readFile(targetPaths.ledger, "utf-8")]),
		).toEqual(before);
	});

	it("never lets a matching pending operation id overwrite unrelated target work", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);
		await adopt(target, offered.offerPath);

		const adoptionPath = ultragoalSuccessionAdoptionPath(target, TARGET_SESSION);
		const claim = JSON.parse(await fs.readFile(adoptionPath, "utf-8")) as Record<string, unknown>;
		claim.status = "pending";
		delete claim.publishedAt;
		await Bun.write(adoptionPath, `${JSON.stringify(claim, null, 2)}\n`);

		// Real operator work now occupies the plan this operation once wrote.
		const goalsPath = path.join(sessionUltragoalDir(target, TARGET_SESSION), "goals.json");
		const plan = JSON.parse(await fs.readFile(goalsPath, "utf-8")) as {
			brief: string;
			goals: Array<{ objective: string }>;
		};
		plan.brief = "Unrelated target work must not be overwritten";
		plan.goals[0].objective = "Preserve unrelated operator work";
		await Bun.write(goalsPath, `${JSON.stringify(plan, null, 2)}\n`);
		const before = await fs.readFile(goalsPath, "utf-8");

		await expectSuccessionError(adopt(target, offered.offerPath), "publication_conflict");
		expect(await fs.readFile(goalsPath, "utf-8")).toBe(before);
	});

	it("refuses to reconstruct a published plan whose files have disappeared", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002"]);
		await adopt(target, offered.offerPath);

		// A published run may have been cleared deliberately; resurrecting it would
		// contradict whatever retired it.
		await fs.rm(path.join(sessionUltragoalDir(target, TARGET_SESSION), "goals.json"));

		await expectSuccessionError(adopt(target, offered.offerPath), "published_plan_missing");
	});

	it("reconciles the exact recorded operation after a crash between claim and publication", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);
		const offered = await offer(source, target, ["G002", "G003"]);

		await adopt(target, offered.offerPath);

		// Simulate a crash after the claim was taken but before publication completed:
		// roll the claim back to `pending` and drop the published plan.
		const adoptionPath = ultragoalSuccessionAdoptionPath(target, TARGET_SESSION);
		const claim = JSON.parse(await fs.readFile(adoptionPath, "utf-8")) as Record<string, unknown>;
		claim.status = "pending";
		delete claim.publishedAt;
		await Bun.write(adoptionPath, `${JSON.stringify(claim, null, 2)}\n`);
		await fs.rm(path.join(sessionUltragoalDir(target, TARGET_SESSION), "goals.json"));

		const recovered = await adopt(target, offered.offerPath);
		expect(recovered.reconciled).toBe(true);
		expect(recovered.operationId).toBe(offered.operationId);

		const plan = await readUltragoalPlan(target, TARGET_SESSION);
		expect(plan?.goals.map(goal => goal.id)).toEqual(["G001", "G002"]);
		expect(plan?.repositoryBinding?.worktreeRoot).toBe(target);
	});
});

describe("ultragoal succession — CLI surface", () => {
	it("publishes the verb in help with its subcommands", async () => {
		const top = await runNativeUltragoalCommand(["--help"], process.cwd());
		expect(top.status).toBe(0);
		expect(top.stdout).toContain("succession offer");
		expect(top.stdout).toContain("succession adopt");
		expect(top.stdout).toContain("succession status");

		const help = await runNativeUltragoalCommand(["succession", "--help"], process.cwd());
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("--target-repo=<value>");
		expect(help.stdout).toContain("--goal-id=<value>");
		expect(help.stdout).toContain("--authorize=<value>");
		expect(help.stdout).toContain("--authorized-by=<value>");
		expect(help.stdout).toContain("--offer=<value>");
	});

	it("runs offer, status and adopt end to end and reports failures on stderr", async () => {
		const source = await tempRepo("source");
		const target = await tempRepo("target");
		await seedSourcePlan(source);

		process.env.GJC_SESSION_ID = SOURCE_SESSION;
		const offered = await runNativeUltragoalCommand(
			[
				"succession",
				"offer",
				"--target-repo",
				target,
				"--goal-id",
				"G002",
				"--authorize",
				AUTHORIZATION,
				"--authorized-by",
				AUTHORIZED_BY,
				"--json",
			],
			source,
		);
		expect(offered.status).toBe(0);
		const offerPayload = JSON.parse(offered.stdout ?? "{}") as { ok: boolean; offer_path: string };
		expect(offerPayload.ok).toBe(true);

		const status = await runNativeUltragoalCommand(["succession", "status", "--json"], source);
		expect(status.status).toBe(0);
		expect(JSON.parse(status.stdout ?? "{}")).toMatchObject({ fenced: true, selected_goal_ids: ["G002"] });

		process.env.GJC_SESSION_ID = TARGET_SESSION;
		const adopted = await runNativeUltragoalCommand(
			["succession", "adopt", "--offer", offerPayload.offer_path, "--json"],
			target,
		);
		expect(adopted.status).toBe(0);
		expect(JSON.parse(adopted.stdout ?? "{}")).toMatchObject({ ok: true, reconciled: false });

		const unknown = await runNativeUltragoalCommand(["succession", "nope"], source);
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain("succession");
	});
});
