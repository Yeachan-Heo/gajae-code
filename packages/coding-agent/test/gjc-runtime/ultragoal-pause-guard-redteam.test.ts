import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	assertUltragoalPauseAllowed,
	isUltragoalPauseBlocked,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	createUltragoalPlan,
	recordUltragoalBlockerClassification,
	recordUltragoalCriticVerdict,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "ultragoal-pause-guard-redteam-session";
const ORIGINAL_GJC_SESSION_ID = process.env.GJC_SESSION_ID;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-pause-guard-redteam-"));
	tempRoots.push(dir);
	return dir;
}

async function createActiveRun(): Promise<string> {
	const cwd = await tempDir();
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	// Disable the pre-gate try-harder nudge so these tests isolate the underlying
	// human_blocked pause gate (the nudge layer has its own dedicated coverage in
	// ultragoal-nudge-guard.test.ts).
	await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
	await fs.writeFile(path.join(cwd, ".gjc", "settings.json"), JSON.stringify({ "gjc.ultragoal.nudgeBudget": 0 }));
	await createUltragoalPlan({ cwd, brief: "Implement the story" });
	return cwd;
}

function ultragoalPath(cwd: string, file: "goals.json" | "ledger.jsonl"): string {
	return path.join(cwd, ".gjc", `_session-${TEST_SESSION_ID}`, "ultragoal", file);
}

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ultragoal pause guard red-team coverage", () => {
	it("treats a human_blocked classification as stale after a later classification", async () => {
		const cwd = await createActiveRun();
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production credentials",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "critic confirms the blocker requires human action",
			classificationEventId: classification.eventId,
		});
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);

		await recordUltragoalBlockerClassification({
			cwd,
			classification: "resolvable",
			evidence: "Agent can add a missing focused regression test",
		});

		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
		expect(diagnostic.reason).toContain("latest blocker_classified event");
	});

	it("assertUltragoalPauseAllowed throws while blocked and resolves with a bound human_blocked classification", async () => {
		const cwd = await createActiveRun();
		await expect(assertUltragoalPauseAllowed(cwd)).rejects.toThrow(/Pausing requires/);

		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must perform manual production approval",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "critic confirms the blocker requires human action",
			classificationEventId: classification.eventId,
		});

		await expect(assertUltragoalPauseAllowed(cwd)).resolves.toBeUndefined();
	});

	it("rejects an invalid blocker classification value", async () => {
		const cwd = await createActiveRun();
		await expect(
			recordUltragoalBlockerClassification({
				cwd,
				classification: "waiting_on_human" as "human_blocked",
				evidence: "User must provide a required secret",
			}),
		).rejects.toThrow(/classification must be/);
	});

	it("fails closed when goals.json is missing even if the latest ledger row is human_blocked", async () => {
		const cwd = await createActiveRun();
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production credentials",
		});
		await fs.rm(ultragoalPath(cwd, "goals.json"));

		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
		expect(diagnostic.reason).toContain("Unable to verify current durable Ultragoal state");
		expect(diagnostic.reason).toContain("goals.json is missing");
	});

	it("fails closed when goals.json is corrupt even if the latest ledger row is human_blocked", async () => {
		const cwd = await createActiveRun();
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production credentials",
		});
		await Bun.write(ultragoalPath(cwd, "goals.json"), "{not-json");

		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
		expect(diagnostic.reason).toContain("Unable to verify current durable Ultragoal state");
	});

	it("fails closed when the ledger is corrupt instead of trusting stale classifications", async () => {
		const cwd = await createActiveRun();
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production credentials",
		});
		await fs.appendFile(ultragoalPath(cwd, "ledger.jsonl"), "{not-json\n");

		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
		expect(diagnostic.reason).toContain("Unable to verify current durable Ultragoal state");
	});
	it("does not throw when no active ultragoal run exists", async () => {
		const cwd = await tempDir();
		delete process.env.GJC_SESSION_ID;
		await expect(assertUltragoalPauseAllowed(cwd)).resolves.toBeUndefined();
	});
});
