import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { modeStatePath as sessionModeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	createUltragoalPlan,
	readUltragoalLedger,
	readUltragoalPlan,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let savedSessionId: string | undefined;

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`);
}

beforeAll(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-review-"));
	tempRoots.push(dir);
	await runGit(dir, ["init"]);
	await runGit(dir, ["config", "user.email", "test@example.com"]);
	await runGit(dir, ["config", "user.name", "Test User"]);
	await Bun.write(path.join(dir, "README.md"), "initial\n");
	await runGit(dir, ["add", "README.md"]);
	await runGit(dir, ["commit", "-m", "initial"]);
	return dir;
}

afterEach(async () => {
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
	if (savedSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = savedSessionId;
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

function syntheticPng(width: number, height: number): Buffer {
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
			actions: [
				{ timestamp: 1000, type: "goto", url: "http://127.0.0.1:3000" },
				{ timestamp: 1001, type: "click", selector: "button.submit" },
				{ timestamp: 1002, type: "assert", selector: "text/Success" },
			],
			assertions: [{ timestamp: 1003, selector: "text/Success", status: "passed" }],
		}),
	);
	await Bun.write(path.join(root, "artifacts", "gui-screenshot.png"), syntheticPng(320, 180));
	await Bun.write(path.join(root, "artifacts", "adversarial-report.txt"), "adversarial boundary evidence");
}

function validExecutorQa(): Record<string, unknown> {
	return {
		status: "passed",
		e2eStatus: "passed",
		redTeamStatus: "passed",
		evidence: "executor built and ran e2e plus red-team QA suite",
		e2eCommands: ["red-team surface check"],
		redTeamCommands: ["red-team artifact check"],
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
				scenario: "Submit invalid or boundary input through the user-facing surface",
				expectedBehavior: "The implementation rejects or handles the case according to the approved contract",
				verdict: "passed",
				artifactRefs: ["adversarial-report"],
			},
		],
		blockers: [],
	};
}

function invalidInlineOnlyExecutorQa(): Record<string, unknown> {
	const qa = validExecutorQa();
	qa.artifactRefs = [
		{
			id: "browser-run",
			kind: "browser-automation",
			description: "Inline fake browser run",
			inlineEvidence: "Browser automation allegedly passed with no real artifact.",
		},
		{
			id: "gui-screenshot",
			kind: "screenshot",
			description: "Inline fake screenshot",
			inlineEvidence: "Screenshot allegedly showed the success state with no real file.",
		},
		{
			id: "adversarial-report",
			kind: "failure-mode-test",
			path: "artifacts/adversarial-report.txt",
			description: "Adversarial report",
		},
	];
	return qa;
}

async function writeQa(root: string, qa: Record<string, unknown>): Promise<string> {
	const file = path.join(root, "executor-qa.json");
	await Bun.write(file, JSON.stringify(qa));
	return file;
}

async function review(root: string, args: string[]): Promise<Record<string, unknown>> {
	const result = await runNativeUltragoalCommand(["review", ...args, "--json"], root);
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout ?? "{}");
}

function modeStatePath(root: string): string {
	return sessionModeStatePath(root, TEST_SESSION_ID, "ultragoal");
}

async function readModeState(root: string): Promise<Record<string, unknown>> {
	return JSON.parse(await Bun.file(modeStatePath(root)).text());
}

function passingQualityGate(): Record<string, unknown> {
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
		executorQa: validExecutorQa(),
		iteration: {
			status: "passed",
			evidence: "no verification findings remain after steering iterations",
			fullRerun: true,
			rerunCommands: ["bun test:e2e"],
			blockers: [],
		},
		criticReview: {
			verdict: "OKAY",
			evidence: "critic approved final aggregate",
			blockers: [],
		},
	};
}

async function completeSingleGoal(root: string): Promise<void> {
	await writeStructuralArtifacts(root);
	await createUltragoalPlan({ cwd: root, brief: "Ship review reconcile" });
	await startNextUltragoalGoal({ cwd: root });
	const checkpoint = await runNativeUltragoalCommand(
		[
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"final story verified with targeted regression coverage",
			"--quality-gate-json",
			JSON.stringify(passingQualityGate()),
		],
		root,
	);
	expect(checkpoint.status).toBe(0);
}

describe("ultragoal review command", () => {
	it("parses branch and worktree sources and falls back when gh cannot resolve a pr", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const qaPath = await writeQa(root, validExecutorQa());
		expect((await review(root, ["--executor-qa-json", qaPath])).source).toMatchObject({ kind: "worktree" });
		expect((await review(root, ["--branch", "HEAD", "--executor-qa-json", qaPath])).source).toMatchObject({
			kind: "branch",
		});
		expect((await review(root, ["--pr", "999999999", "--executor-qa-json", qaPath])).source).toMatchObject({
			kind: "pr",
			prSource: "gh-unavailable",
		});
	}, 15_000);

	it("uses spec override as a strong contract and allows clean pass", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const qaPath = await writeQa(root, validExecutorQa());
		await Bun.write(path.join(root, "spec.md"), "Strong acceptance criteria");
		const output = await review(root, ["--spec", "spec.md", "--executor-qa-json", qaPath]);
		expect(output.contractStrength).toBe("strong");
		expect(output.verdict).toBe("pass");
		expect(output.cleanPassEligible).toBe(true);
	});

	it("review-only emits findings without creating goals or ledger entries", async () => {
		const root = await tempDir();
		const output = await review(root, ["--executor-qa-json", await writeQa(root, invalidInlineOnlyExecutorQa())]);
		expect(output.verdict).toBe("fail");
		expect((output.findings as unknown[]).length).toBeGreaterThan(0);
		expect(await readUltragoalPlan(root)).toBeNull();
		expect(await readUltragoalLedger(root)).toEqual([]);
	});

	it("review-start records blocker goals on findings", async () => {
		const root = await tempDir();
		const output = await review(root, [
			"--mode",
			"review-start",
			"--executor-qa-json",
			await writeQa(root, invalidInlineOnlyExecutorQa()),
		]);
		const plan = await readUltragoalPlan(root);
		expect(output.verdict).toBe("fail");
		expect((output.blockerGoalIds as unknown[]).length).toBeGreaterThan(0);
		expect(plan?.goals[0]?.status).toBe("pending");
		expect(plan?.goals[0]?.steering?.kind).toBe("review_blocker");
	});

	it("review --mode review-start reconciles mode-state after recording blocker goals (#643)", async () => {
		const root = await tempDir();
		await completeSingleGoal(root);

		const before = await readModeState(root);
		expect(before.active).toBe(false);
		expect(before.current_phase).toBe("complete");

		const output = await review(root, [
			"--mode",
			"review-start",
			"--executor-qa-json",
			await writeQa(root, invalidInlineOnlyExecutorQa()),
		]);
		expect((output.blockerGoalIds as unknown[]).length).toBeGreaterThan(0);

		const plan = await readUltragoalPlan(root);
		const pendingBlockers = (plan?.goals ?? []).filter(
			goal => goal.steering?.kind === "review_blocker" && goal.status === "pending",
		);
		expect(pendingBlockers.length).toBeGreaterThan(0);

		const after = await readModeState(root);
		expect(after.active).toBe(true);
		expect(after.current_phase).toBe("pending");
	});

	it("review --mode review-start does not duplicate blocker goals on repeat (#643)", async () => {
		const root = await tempDir();
		const qaPath = await writeQa(root, invalidInlineOnlyExecutorQa());

		const first = await review(root, ["--mode", "review-start", "--executor-qa-json", qaPath]);
		const second = await review(root, ["--mode", "review-start", "--executor-qa-json", qaPath]);

		const plan = await readUltragoalPlan(root);
		const blockerGoals = (plan?.goals ?? []).filter(goal => goal.steering?.kind === "review_blocker");
		const objectives = blockerGoals.map(goal => goal.objective);
		expect(new Set(objectives).size).toBe(objectives.length);
		expect(blockerGoals.length).toBe((first.blockerGoalIds as unknown[]).length);
		expect(second.blockerGoalIds).toEqual(first.blockerGoalIds);
	});

	it("rejects the same invalid live artifact as checkpoint", async () => {
		const root = await tempDir();
		const qa = invalidInlineOnlyExecutorQa();
		const reviewOutput = await review(root, ["--executor-qa-json", await writeQa(root, qa)]);
		await createUltragoalPlan({ cwd: root, brief: "Ship review gate" });
		await startNextUltragoalGoal({ cwd: root });
		const checkpoint = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"review gate parity check",
				"--quality-gate-json",
				JSON.stringify({
					architectReview: {
						architectureStatus: "CLEAR",
						productStatus: "CLEAR",
						codeStatus: "CLEAR",
						recommendation: "APPROVE",
						evidence: "architect reviewed architecture, product behavior, and code changes",
						commands: ["architect-review"],
						blockers: [],
					},
					executorQa: qa,
					iteration: {
						status: "passed",
						evidence: "no verification findings remain after steering iterations",
						fullRerun: true,
						rerunCommands: ["bun test:e2e"],
						blockers: [],
					},
					criticReview: {
						verdict: "OKAY",
						evidence: "critic approved final aggregate",
						blockers: [],
					},
				}),
			],
			root,
		);
		expect(checkpoint.status).toBe(1);
		expect((reviewOutput.findings as Array<Record<string, unknown>>)[0]?.message).toContain(
			"inlineEvidence and typed verifiedReceipt do not prove live surfaces",
		);
		expect(checkpoint.stderr).toContain("inlineEvidence and typed verifiedReceipt do not prove live surfaces");
	});

	it("caps thin contracts at inconclusive weak-contract even with zero findings", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const output = await review(root, ["--executor-qa-json", await writeQa(root, validExecutorQa())]);
		expect(output.contractStrength).toBe("thin-derived");
		expect(output.verdict).toBe("inconclusive: weak-contract");
		expect(output.cleanPassEligible).toBe(false);
		expect(output.weakContractCapApplied).toBe(true);
	});
});
