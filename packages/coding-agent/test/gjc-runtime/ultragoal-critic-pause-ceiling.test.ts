import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isUltragoalPauseBlocked } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	CRITIC_GATE_HARD_STOP_EVENT,
	CRITIC_GATE_OVERRIDE_EVENT,
	computeCriticVerdictPlanGeneration,
	countNonOkayTerminalCriticVerdicts,
	findCleanPauseCriticVerdict,
	TERMINAL_CRITIC_CEILING,
	terminalCriticCeilingReached,
	terminalCriticGateOverridden,
	terminalCriticHardStopReached,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-receipt-freshness";
import {
	appendLedger,
	createUltragoalPlan,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalBlockerClassification,
	recordUltragoalCriticVerdict,
	runNativeUltragoalCommand,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "ultragoal-critic-pause-ceiling-test-session";
const ORIGINAL_GJC_SESSION_ID = process.env.GJC_SESSION_ID;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-critic-pause-ceiling-"));
	tempRoots.push(dir);
	return dir;
}

async function createActiveRun(brief = "Ship the story"): Promise<string> {
	const cwd = await tempDir();
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	await createUltragoalPlan({ cwd, brief });
	return cwd;
}

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("ultragoal critic pause ceiling", () => {
	it("allows pause after a human_blocked classification receives a bound clean OKAY verdict", async () => {
		const cwd = await createActiveRun();
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must approve the production release",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "Critic confirms this blocker requires human approval",
			classificationEventId: classification.eventId,
		});

		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);
	});

	it("uses the latest pause verdict for the current classification", async () => {
		const cwd = await createActiveRun();
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must approve the production release",
		});
		const recordPauseVerdict = async (verdict: "OKAY" | "ITERATE" | "REJECT") =>
			recordUltragoalCriticVerdict({
				cwd,
				terminus: "pause",
				verdict,
				evidence: `Critic ${verdict.toLowerCase()} verdict for the human-only blocker`,
				blockers: verdict === "OKAY" ? [] : ["Await a clean current pause verdict"],
				classificationEventId: classification.eventId,
			});

		await recordPauseVerdict("OKAY");
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);
		await recordPauseVerdict("REJECT");
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(true);
		await recordPauseVerdict("OKAY");
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);
		await recordPauseVerdict("ITERATE");
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(true);
		await recordPauseVerdict("OKAY");
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);
	});

	it("rejects a pause approval bound to an earlier classification and accepts the latest binding", async () => {
		const cwd = await createActiveRun();
		const earlier = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "Initial approval request needs a human",
		});
		const latest = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "A newer approval request needs a human",
		});
		await expect(
			recordUltragoalCriticVerdict({
				cwd,
				terminus: "pause",
				verdict: "OKAY",
				evidence: "Critic approved only the earlier classification",
				classificationEventId: earlier.eventId,
			}),
		).rejects.toThrow(/name the latest human_blocked classification/);
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "Critic approves the current human-only blocker",
			classificationEventId: latest.eventId,
		});

		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);
	});

	it("requires a clean bound pause verdict to occur after its classification", async () => {
		const cwd = await createActiveRun();
		const plan = (await readUltragoalPlan(cwd))!;
		const classificationEventId = "classification-after-verdict";
		await appendLedger(cwd, {
			event: "critic_verdict",
			terminus: "pause",
			verdict: "OKAY",
			evidence: "A syntactically clean verdict recorded too early",
			blockers: [],
			planGeneration: computeCriticVerdictPlanGeneration(plan),
			classificationEventId,
		});
		await appendLedger(cwd, {
			event: "blocker_classified",
			eventId: classificationEventId,
			classification: "human_blocked",
			evidence: "A human must approve the production release",
		});
		const ledger = await readUltragoalLedger(cwd);

		expect(findCleanPauseCriticVerdict(plan, ledger, classificationEventId)).toBeNull();
		expect(findCleanPauseCriticVerdict(plan, ledger, "absent-classification")).toBeNull();
	});

	it("validates pause verdict blockers and classification bindings", async () => {
		const cwd = await createActiveRun();
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "A human must approve the production release",
		});
		await expect(
			recordUltragoalCriticVerdict({
				cwd,
				terminus: "pause",
				verdict: "OKAY",
				evidence: "Critic approval",
				blockers: ["This must be empty"],
				classificationEventId: classification.eventId,
			}),
		).rejects.toThrow(/OKAY critic verdict must have empty blockers/);
		await expect(
			recordUltragoalCriticVerdict({
				cwd,
				terminus: "pause",
				verdict: "OKAY",
				evidence: "Critic approval",
			}),
		).rejects.toThrow(/classification-event-id is required/);
	});

	it("records a hard stop on the fifth non-OKAY verdict and keeps pause blocked", async () => {
		const cwd = await createActiveRun();
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must decide the unresolved production risk",
		});
		for (let attempt = 1; attempt <= TERMINAL_CRITIC_CEILING; attempt++) {
			await recordUltragoalCriticVerdict({
				cwd,
				terminus: attempt % 2 === 0 ? "completion" : "pause",
				verdict: "REJECT",
				evidence: `Critic rejection ${attempt} identifies a remaining risk`,
				blockers: [`Resolve risk ${attempt}`],
				...(attempt % 2 === 0 ? {} : { classificationEventId: classification.eventId }),
			});
		}
		const ledger = await readUltragoalLedger(cwd);
		expect(countNonOkayTerminalCriticVerdicts(ledger)).toBe(TERMINAL_CRITIC_CEILING);
		expect(terminalCriticCeilingReached(ledger)).toBe(true);
		expect(ledger.filter(event => event.event === CRITIC_GATE_HARD_STOP_EVENT).length).toBe(1);
		expect(terminalCriticHardStopReached(ledger)).toBe(true);
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "Critic now approves the human-only pause",
			classificationEventId: classification.eventId,
		});
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(true);
	});

	it("rejects a preemptive override and lets a post-hard-stop override recover a valid human-blocked pause", async () => {
		const cwd = await createActiveRun();
		const preemptiveOverride = await runNativeUltragoalCommand(
			["record-critic-gate-override", "--evidence", "Leader approval before any hard stop", "--json"],
			cwd,
		);
		expect(preemptiveOverride.status).not.toBe(0);
		expect(preemptiveOverride.stderr).toContain("requires a durably recorded terminal critic hard stop");
		let ledger = await readUltragoalLedger(cwd);
		expect(ledger.some(event => event.event === CRITIC_GATE_OVERRIDE_EVENT)).toBe(false);

		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "A leader must approve the release exception",
		});
		for (let attempt = 1; attempt <= TERMINAL_CRITIC_CEILING; attempt++) {
			await recordUltragoalCriticVerdict({
				cwd,
				terminus: "completion",
				verdict: "REJECT",
				evidence: `Completion review ${attempt} found an unresolved release risk`,
				blockers: [`Resolve release risk ${attempt}`],
			});
		}
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "Critic confirms only the leader approval remains",
			classificationEventId: classification.eventId,
		});
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(true);

		const override = await runNativeUltragoalCommand(
			["record-critic-gate-override", "--evidence", "Leader approved another terminal attempt", "--json"],
			cwd,
		);
		expect(override.status).toBe(0);
		expect(JSON.parse(override.stdout ?? "{}")).toMatchObject({
			ok: true,
			event: CRITIC_GATE_OVERRIDE_EVENT,
			event_id: expect.any(String),
		});
		ledger = await readUltragoalLedger(cwd);
		expect(terminalCriticGateOverridden(ledger)).toBe(true);
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);
	});

	it("defaults omitted completion blockers, rejects wrong shapes, and binds pause verdicts", async () => {
		const cwd = await createActiveRun();
		const completion = await runNativeUltragoalCommand(
			[
				"record-critic-verdict",
				"--terminus",
				"completion",
				"--verdict",
				"OKAY",
				"--evidence",
				"Critic confirms the completion evidence is current",
				"--json",
			],
			cwd,
		);
		expect(completion.status).toBe(0);
		expect(JSON.parse(completion.stdout ?? "{}")).toMatchObject({
			ok: true,
			event: "critic_verdict",
			terminus: "completion",
			verdict: "OKAY",
		});
		let ledger = await readUltragoalLedger(cwd);
		expect(ledger).toContainEqual(
			expect.objectContaining({
				event: "critic_verdict",
				terminus: "completion",
				verdict: "OKAY",
				blockers: [],
			}),
		);

		const malformed = await runNativeUltragoalCommand(
			[
				"record-critic-verdict",
				"--terminus",
				"completion",
				"--verdict",
				"OKAY",
				"--evidence",
				"Critic malformed blockers must not append a verdict",
				"--blockers-json",
				"{}",
				"--json",
			],
			cwd,
		);
		expect(malformed.status).not.toBe(0);
		expect(malformed.stderr).toBe("record-critic-verdict --blockers-json must be a JSON string array\n");
		ledger = await readUltragoalLedger(cwd);
		expect(ledger.filter(event => event.event === "critic_verdict")).toHaveLength(1);

		const classification = await runNativeUltragoalCommand(
			[
				"classify-blocker",
				"--classification",
				"human_blocked",
				"--evidence",
				"A human must approve the production release",
				"--json",
			],
			cwd,
		);
		expect(classification.status).toBe(0);
		const receipt = JSON.parse(classification.stdout ?? "{}") as { event_id?: unknown };
		expect(receipt.event_id).toEqual(expect.any(String));

		const verdict = await runNativeUltragoalCommand(
			[
				"record-critic-verdict",
				"--terminus",
				"pause",
				"--verdict",
				"OKAY",
				"--evidence",
				"Critic confirms the blocker requires human action",
				"--classification-event-id",
				receipt.event_id as string,
				"--blockers-json",
				"[]",
				"--json",
			],
			cwd,
		);
		expect(verdict.status).toBe(0);
		expect(JSON.parse(verdict.stdout ?? "{}")).toMatchObject({ ok: true, event: "critic_verdict" });
		expect((await isUltragoalPauseBlocked(cwd)).blocked).toBe(false);
	});
});
