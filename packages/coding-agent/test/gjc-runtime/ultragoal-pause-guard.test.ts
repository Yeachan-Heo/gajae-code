import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isUltragoalPauseBlocked } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	createUltragoalPlan,
	recordUltragoalBlockerClassification,
	recordUltragoalCriticVerdict,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "ultragoal-pause-guard-test-session";
const ORIGINAL_GJC_SESSION_ID = process.env.GJC_SESSION_ID;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-pause-guard-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ultragoal pause guard", () => {
	it("does not block pause when no durable ultragoal state exists", async () => {
		const cwd = await tempDir();
		delete process.env.GJC_SESSION_ID;
		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(false);
	});

	it("blocks pause when an ultragoal run is active and no blocker is classified", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
		expect(diagnostic.reason).toContain("human_blocked");
	});

	it("allows pause after a human_blocked classification has a bound clean critic verdict", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "critic confirms human-only blocker",
			classificationEventId: classification.eventId,
		});
		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(false);
	});

	it("blocks pause when human_blocked has no critic verdict", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
		expect(diagnostic.reason).toContain("fresh clean pause terminal critic OKAY verdict");
	});

	it("blocks pause when the bound critic verdict is REJECT", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "REJECT",
			evidence: "critic found unresolved risk",
			blockers: ["Resolve the risk"],
			classificationEventId: classification.eventId,
		});
		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
		expect(diagnostic.reason).toContain("fresh clean pause terminal critic OKAY verdict");
	});

	it("still blocks pause when the latest classification is resolvable", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "resolvable",
			evidence: "Failing unit test the agent can fix",
		});
		const diagnostic = await isUltragoalPauseBlocked(cwd);
		expect(diagnostic.blocked).toBe(true);
	});

	it("rejects an empty evidence classification", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await expect(
			recordUltragoalBlockerClassification({ cwd, classification: "human_blocked", evidence: "   " }),
		).rejects.toThrow(/evidence is required/);
	});
});
