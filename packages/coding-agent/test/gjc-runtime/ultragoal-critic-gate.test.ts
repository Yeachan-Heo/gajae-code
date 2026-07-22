import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { verifyUltragoalDurableCompletionState } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	CRITIC_GATE_HARD_STOP_EVENT,
	computeCriticVerdictPlanGeneration,
	countNonOkayTerminalCriticVerdicts,
	findCleanPauseCriticVerdict,
	TERMINAL_CRITIC_CEILING,
	terminalCriticCeilingReached,
	terminalCriticHardStopReached,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-receipt-freshness";
import {
	appendLedger,
	countUltragoalNudges,
	createUltragoalPlan,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalBlockerClassification,
	recordUltragoalCriticGateOverride,
	recordUltragoalCriticVerdict,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "ultragoal-critic-gate-test-session";
const ORIGINAL_GJC_SESSION_ID = process.env.GJC_SESSION_ID;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-critic-gate-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = new Uint32Array(256).map((_, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function pngCrc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeBytes = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 0);
	return Buffer.concat([length, typeBytes, data, crc]);
}

function syntheticPng(): Buffer {
	const width = 320;
	const height = 180;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		for (let x = 0; x < width; x++) {
			const pixel = row + 1 + x * 3;
			raw[pixel] = (x * 3 + y * 5) % 256;
			raw[pixel + 1] = (x * 7 + y * 11) % 256;
			raw[pixel + 2] = (x * 13 + y * 17) % 256;
		}
	}
	const idat = pngChunk("IDAT", deflateSync(raw));
	const padding = idat.length < 4096 ? pngChunk("tEXt", Buffer.alloc(4096 - idat.length, 0)) : Buffer.alloc(0);
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), idat, padding, pngChunk("IEND")]);
}

async function writeStructuralArtifacts(root: string): Promise<void> {
	await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
	await Bun.write(
		path.join(root, "artifacts", "browser-run.json"),
		JSON.stringify({
			schemaVersion: 1,
			surface: "gui/web",
			tool: "browser",
			actions: [{ timestamp: 1000, type: "goto", url: "http://127.0.0.1:3000" }],
			assertions: [{ timestamp: 1001, selector: "text/Success", status: "passed" }],
		}),
	);
	await Bun.write(path.join(root, "artifacts", "gui-screenshot.png"), syntheticPng());
	await Bun.write(path.join(root, "artifacts", "adversarial-report.txt"), "adversarial boundary evidence");
}

function passingLiveQualityGate(): Record<string, unknown> {
	return {
		architectReview: {
			architectureStatus: "CLEAR",
			productStatus: "CLEAR",
			codeStatus: "CLEAR",
			recommendation: "APPROVE",
			evidence: "architect reviewed architecture, product behavior, and code changes",
			commands: ["architect-review"],
			blockers: [],
		},
		executorQa: {
			status: "passed",
			e2eStatus: "passed",
			redTeamStatus: "passed",
			evidence: "executor built and ran e2e plus red-team QA suite",
			e2eCommands: ["bun test:e2e"],
			redTeamCommands: ["bun test:red-team"],
			blockers: [],
			artifactRefs: [
				{
					id: "browser-run",
					kind: "browser-automation",
					path: "artifacts/browser-run.json",
					description: "Browser automation transcript",
				},
				{
					id: "gui-screenshot",
					kind: "screenshot",
					path: "artifacts/gui-screenshot.png",
					description: "Screenshot evidence",
				},
				{
					id: "adversarial-report",
					kind: "failure-mode-test",
					path: "artifacts/adversarial-report.txt",
					description: "Adversarial report",
				},
			],
			contractCoverage: [
				{
					id: "contract-goal",
					contractRef: "approved-plan:goal",
					obligation: "The completed story satisfies the approved user-facing contract",
					status: "covered",
					surfaceEvidenceRefs: ["surface-gui"],
					adversarialCaseRefs: ["case-invalid-input"],
				},
			],
			surfaceEvidence: [
				{
					id: "surface-gui",
					surface: "gui/web",
					contractRef: "approved-plan:goal",
					invocation: "Open the user-facing flow in a browser and verify the visible result",
					verdict: "passed",
					artifactRefs: ["browser-run", "gui-screenshot"],
				},
			],
			adversarialCases: [
				{
					id: "case-invalid-input",
					contractRef: "approved-plan:goal",
					scenario: "Submit invalid input",
					expectedBehavior: "The implementation handles invalid input according to the approved contract",
					verdict: "passed",
					artifactRefs: ["adversarial-report"],
				},
			],
		},
		iteration: {
			status: "passed",
			evidence: "no verification findings remain after steering iterations",
			fullRerun: true,
			rerunCommands: ["bun test:e2e"],
			blockers: [],
		},
		criticReview: { verdict: "OKAY", evidence: "critic approved final aggregate", blockers: [] },
	};
}

async function checkpoint(root: string, gate: Record<string, unknown>) {
	return runNativeUltragoalCommand(
		[
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"final story verified with targeted regression coverage",
			"--quality-gate-json",
			JSON.stringify(gate),
		],
		root,
	);
}

describe("ultragoal terminal critic gate", () => {
	it("requires a clean OKAY criticReview for a single-goal final aggregate", async () => {
		const root = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await writeStructuralArtifacts(root);
		const cases: Array<[string, (gate: Record<string, unknown>) => void]> = [
			[
				"missing",
				gate => {
					delete gate.criticReview;
				},
			],
			[
				"ITERATE",
				gate => {
					(gate.criticReview as Record<string, unknown>).verdict = "ITERATE";
				},
			],
			[
				"REJECT",
				gate => {
					(gate.criticReview as Record<string, unknown>).verdict = "REJECT";
				},
			],
			[
				"blockers",
				gate => {
					(gate.criticReview as Record<string, unknown>).blockers = ["Fix the risk"];
				},
			],
			[
				"empty evidence",
				gate => {
					(gate.criticReview as Record<string, unknown>).evidence = " ";
				},
			],
		];
		for (const [name, mutate] of cases) {
			await createUltragoalPlan({ cwd: root, brief: `Ship ${name}` });
			await startNextUltragoalGoal({ cwd: root });
			const gate = passingLiveQualityGate();
			mutate(gate);
			const result = await checkpoint(root, gate);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("criticReview");
			await fs.rm(path.join(root, ".gjc"), { recursive: true, force: true });
		}
		await createUltragoalPlan({ cwd: root, brief: "Ship accepted gate" });
		await startNextUltragoalGoal({ cwd: root });
		const accepted = await checkpoint(root, passingLiveQualityGate());
		expect(accepted.status).toBe(0);
	});

	it("counts run-level non-OKAY critic verdicts independently from nudges", async () => {
		const root = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd: root, brief: "Ship the story" });
		await recordUltragoalCriticVerdict({
			cwd: root,
			terminus: "completion",
			verdict: "OKAY",
			evidence: "first critic review",
		});
		await recordUltragoalCriticVerdict({
			cwd: root,
			terminus: "completion",
			verdict: "REJECT",
			evidence: "second critic review",
			blockers: ["Fix risk"],
		});
		let ledger = await readUltragoalLedger(root);
		expect(countNonOkayTerminalCriticVerdicts(ledger)).toBe(1);
		expect(countUltragoalNudges(ledger, "G001")).toBe(0);
		await appendLedger(root, {
			event: "critic_verdict",
			terminus: "completion",
			verdict: "REJECT",
			evidence: "historical critic review",
			blockers: ["Historical risk"],
			planGeneration: "different-generation",
		});
		await appendLedger(root, { event: "nudge", goalId: "G001", surface: "pause", attempt: 1 });
		ledger = await readUltragoalLedger(root);
		expect(countNonOkayTerminalCriticVerdicts(ledger)).toBe(2);
		expect(countUltragoalNudges(ledger, "G001")).toBe(1);
		await appendLedger(root, { event: "nudge", goalId: "G001", surface: "pause", attempt: 2 });
		ledger = await readUltragoalLedger(root);
		expect(countNonOkayTerminalCriticVerdicts(ledger)).toBe(2);
		expect(countUltragoalNudges(ledger, "G001")).toBe(2);
	});

	it("accumulates completion verdicts across reopened plan generations and hard-stops on the fifth", async () => {
		const root = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd: root, brief: "Ship the story" });
		const generations: string[] = [];
		for (let attempt = 1; attempt <= TERMINAL_CRITIC_CEILING; attempt++) {
			const verdict = await recordUltragoalCriticVerdict({
				cwd: root,
				terminus: "completion",
				verdict: "REJECT",
				evidence: `Completion critic cycle ${attempt} found a release blocker`,
				blockers: [`Resolve release blocker ${attempt}`],
			});
			generations.push(verdict.planGeneration as string);
			const steer = await runNativeUltragoalCommand(
				[
					"steer",
					"--kind",
					"add_subgoal",
					"--title",
					`Resolve critic finding ${attempt}`,
					"--objective",
					`Resolve completion critic finding ${attempt} and verify it.`,
					"--evidence",
					`Completion critic rejection ${attempt} requires a reopen cycle.`,
					"--rationale",
					"The new required goal addresses the critic finding.",
				],
				root,
			);
			expect(steer.status).toBe(0);
		}
		const ledger = await readUltragoalLedger(root);
		expect(new Set(generations).size).toBe(TERMINAL_CRITIC_CEILING);
		expect(countNonOkayTerminalCriticVerdicts(ledger)).toBe(TERMINAL_CRITIC_CEILING);
		expect(terminalCriticCeilingReached(ledger)).toBe(true);
		expect(terminalCriticHardStopReached(ledger)).toBe(true);
		expect(ledger.some(event => event.event === CRITIC_GATE_HARD_STOP_EVENT)).toBe(true);
	});

	it("rejects final aggregate completion at the hard stop until a gate override is recorded", async () => {
		const root = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "Ship the story" });
		await startNextUltragoalGoal({ cwd: root });
		for (let attempt = 1; attempt <= TERMINAL_CRITIC_CEILING; attempt++) {
			await recordUltragoalCriticVerdict({
				cwd: root,
				terminus: "completion",
				verdict: "REJECT",
				evidence: `Completion critic review ${attempt} found a release blocker`,
				blockers: [`Resolve release blocker ${attempt}`],
			});
		}
		const blocked = await checkpoint(root, passingLiveQualityGate());
		expect(blocked.status).toBe(1);
		expect(blocked.stderr).toContain(
			"terminal-critic ceiling reached; requires human/leader gjc ultragoal record-critic-gate-override",
		);

		await recordUltragoalCriticGateOverride({
			cwd: root,
			evidence: "Leader reviewed the five findings and approved final aggregation.",
		});
		const accepted = await checkpoint(root, passingLiveQualityGate());
		expect(accepted.status).toBe(0);
	});

	it("revalidates the terminal critic ceiling before honoring a durable final receipt", async () => {
		const root = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "Ship the story" });
		await startNextUltragoalGoal({ cwd: root });
		expect((await checkpoint(root, passingLiveQualityGate())).status).toBe(0);
		expect((await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID })).state).toBe(
			"active_verified_complete",
		);

		for (let attempt = 1; attempt <= TERMINAL_CRITIC_CEILING; attempt++) {
			await recordUltragoalCriticVerdict({
				cwd: root,
				terminus: "completion",
				verdict: "REJECT",
				evidence: `Post-receipt terminal critic review ${attempt} found a release blocker`,
				blockers: [`Resolve post-receipt release blocker ${attempt}`],
			});
		}
		const blockedLedger = await readUltragoalLedger(root);
		expect(terminalCriticHardStopReached(blockedLedger)).toBe(true);
		expect((await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID })).state).toBe(
			"active_missing_final_receipt",
		);

		await recordUltragoalCriticGateOverride({
			cwd: root,
			evidence: "Leader reviewed the post-receipt findings and approved final aggregation.",
		});
		expect((await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID })).state).toBe(
			"active_verified_complete",
		);
	});

	it("stales a pause critic verdict after add_subgoal changes the required-goal set", async () => {
		const root = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd: root, brief: "Ship the story" });
		const classification = await recordUltragoalBlockerClassification({
			cwd: root,
			classification: "human_blocked",
			evidence: "User must approve the production release",
		});
		await recordUltragoalCriticVerdict({
			cwd: root,
			terminus: "pause",
			verdict: "OKAY",
			evidence: "critic approves current pause",
			classificationEventId: classification.eventId,
		});
		const beforePlan = (await readUltragoalPlan(root))!;
		const beforeLedger = await readUltragoalLedger(root);
		const beforeGeneration = computeCriticVerdictPlanGeneration(beforePlan);
		expect(findCleanPauseCriticVerdict(beforePlan, beforeLedger, classification.eventId!)).not.toBeNull();
		const result = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"add_subgoal",
				"--title",
				"Verify the fix",
				"--objective",
				"Run focused verification.",
				"--evidence",
				"review found missing coverage",
				"--rationale",
				"coverage closes the risk",
			],
			root,
		);
		expect(result.status).toBe(0);
		const afterPlan = (await readUltragoalPlan(root))!;
		const afterLedger = await readUltragoalLedger(root);
		expect(computeCriticVerdictPlanGeneration(afterPlan)).not.toBe(beforeGeneration);
		expect(findCleanPauseCriticVerdict(afterPlan, afterLedger, classification.eventId!)).toBeNull();
	});

	it("records a well-formed critic verdict ledger event", async () => {
		const root = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd: root, brief: "Ship the story" });
		const event = await recordUltragoalCriticVerdict({
			cwd: root,
			terminus: "completion",
			verdict: "REJECT",
			evidence: "critic found a release blocker",
			blockers: ["Resolve release blocker"],
			goalId: "G001",
		});
		expect(event).toMatchObject({
			event: "critic_verdict",
			terminus: "completion",
			verdict: "REJECT",
			evidence: "critic found a release blocker",
			blockers: ["Resolve release blocker"],
			goalId: "G001",
		});
		expect(event.planGeneration).toEqual(expect.any(String));
	});
});
