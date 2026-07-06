import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import {
	activeEntryPath,
	activeSnapshotPath,
	modeStatePath as sessionModeStatePath,
	sessionStateDir,
	sessionUltragoalDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { reconcileWorkflowSkillState } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { validateCompletionReceipt } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";

import {
	addUltragoalSubgoal,
	buildUltragoalHudSummary,
	checkpointUltragoalGoal,
	createUltragoalPlan,
	getUltragoalStatus,
	hashStructuredValue,
	readUltragoalLedger,
	readUltragoalPlan,
	resolveGitBase,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
	type UltragoalCommandResult,
	validateExecutorQaRedTeamEvidenceForReview,
	waitForReplayProcessWithTimeout,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { readVisibleSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];

let savedSessionId: string | undefined;
let savedSessionFile: string | undefined;

beforeEach(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	savedSessionFile = process.env.GJC_SESSION_FILE;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	delete process.env.GJC_SESSION_FILE;
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-runtime-"));
	tempRoots.push(dir);
	return dir;
}

let savedCiDevChangedPaths: { value: string | undefined } | undefined;

/**
 * Root for validation-batch tests, hermetically OUTSIDE the enclosing git
 * repository. `computeCheckpointChangeSet` walks git from the checkpoint cwd,
 * so a root inside this repo sweeps the contributor's actual branch diff /
 * dirty working tree into the computed change set and breaks the hardcoded
 * `batchChangeSetPaths()` coverage on any branch other than the one that
 * introduced these tests. Outside a git work tree the runtime falls back to
 * `CI_DEV_CHANGED_PATHS`, which we pin to the declared batch change-set paths.
 */
async function batchTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-runtime-batch-"));
	tempRoots.push(dir);
	savedCiDevChangedPaths ??= { value: process.env.CI_DEV_CHANGED_PATHS };
	process.env.CI_DEV_CHANGED_PATHS = batchChangeSetPaths()
		.map(row => row.path)
		.join("\n");
	return dir;
}

afterEach(async () => {
	if (savedSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = savedSessionId;
	if (savedSessionFile === undefined) delete process.env.GJC_SESSION_FILE;
	else process.env.GJC_SESSION_FILE = savedSessionFile;
	if (savedCiDevChangedPaths) {
		if (savedCiDevChangedPaths.value === undefined) delete process.env.CI_DEV_CHANGED_PATHS;
		else process.env.CI_DEV_CHANGED_PATHS = savedCiDevChangedPaths.value;
		savedCiDevChangedPaths = undefined;
	}
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function captureStderrWrites(): { writes: string[]; restore: () => void } {
	const writes: string[] = [];
	const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { writes, restore: () => spy.mockRestore() };
}

function passingQualityGate(): string {
	return JSON.stringify({
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
			artifactRefs: [
				{
					id: "browser-run",
					kind: "browser-automation",
					path: "artifacts/browser-run.json",
					description: "Playwright/Pandawright browser run that invokes the approved user-facing flow",
					inlineEvidence:
						"Browser automation executed the approved flow, asserted the expected visible result, and captured the final DOM state.",
				},
				{
					id: "gui-screenshot",
					kind: "screenshot",
					path: "artifacts/gui-screenshot.png",
					description: "Screenshot evidence for the GUI/web surface verdict",
					inlineEvidence:
						"Screenshot review confirmed the approved screen state, including the success message and absence of regression indicators.",
				},
				{
					id: "adversarial-report",
					kind: "failure-mode-test",
					path: "artifacts/adversarial-report.txt",
					description: "Adversarial boundary and failure-mode test output",
					inlineEvidence:
						"Adversarial boundary cases exercised invalid input, missing state, and repeated submission without violating the contract.",
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
		},
		iteration: {
			status: "passed",
			evidence: "no verification findings remain after steering iterations",
			fullRerun: true,
			rerunCommands: ["bun test:e2e", "bun test:red-team"],
			blockers: [],
		},
	});
}

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

function syntheticPng(width: number, height: number, mode: "gradient" | "solid"): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const pixel = row + 1 + x * 3;
			const value = mode === "gradient" ? (x * 3 + y * 5) % 256 : 7;
			raw[pixel] = value;
			raw[pixel + 1] = mode === "gradient" ? (x * 7 + y * 11) % 256 : 7;
			raw[pixel + 2] = mode === "gradient" ? (x * 13 + y * 17) % 256 : 7;
		}
	}
	const idat = pngChunk("IDAT", deflateSync(raw));
	const padding = idat.length < 4096 ? pngChunk("tEXt", Buffer.alloc(4096 - idat.length, 0)) : Buffer.alloc(0);
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), idat, padding, pngChunk("IEND")]);
}

function fakeUnsupportedImage(kind: "gif" | "bmp" | "webp"): Buffer {
	const bytes = Buffer.alloc(4096, 31);
	if (kind === "gif") {
		bytes.write("GIF89a", 0, "ascii");
		bytes.writeUInt16LE(320, 6);
		bytes.writeUInt16LE(180, 8);
	} else if (kind === "bmp") {
		bytes.write("BM", 0, "ascii");
		bytes.writeUInt32LE(40, 14);
		bytes.writeInt32LE(320, 18);
		bytes.writeInt32LE(180, 22);
	} else {
		bytes.write("RIFF", 0, "ascii");
		bytes.write("WEBP", 8, "ascii");
		bytes.write("VP8X", 12, "ascii");
		bytes.writeUIntLE(319, 24, 3);
		bytes.writeUIntLE(179, 27, 3);
	}
	return bytes;
}

function fakeHeaderOnlyJpeg(): Buffer {
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x03, 0x01, 0x11, 0x00]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9]), Buffer.alloc(4096, 23)]);
}

function validAutomationTranscript(surface = "gui/web"): Record<string, unknown> {
	return {
		schemaVersion: 1,
		surface,
		tool: "browser",
		actions: [
			{ timestamp: 1000, type: "goto", url: "http://127.0.0.1:3000" },
			{ timestamp: 1001, type: "click", selector: "button.submit" },
			{ timestamp: 1002, type: "assert", selector: "text/Success" },
		],
		assertions: [{ timestamp: 1003, selector: "text/Success", status: "passed" }],
	};
}

async function writeStructuralArtifacts(root: string): Promise<void> {
	await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
	await Bun.write(path.join(root, "artifacts", "browser-run.json"), JSON.stringify(validAutomationTranscript()));
	await Bun.write(path.join(root, "artifacts", "gui-screenshot.png"), syntheticPng(320, 180, "gradient"));
	await Bun.write(path.join(root, "artifacts", "blank-screenshot.png"), syntheticPng(320, 180, "solid"));
	await Bun.write(path.join(root, "artifacts", "tiny-screenshot.png"), syntheticPng(1, 1, "gradient"));
	await Bun.write(
		path.join(root, "artifacts", "garbage-screenshot.png"),
		Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4096, 17)]),
	);
	await Bun.write(path.join(root, "artifacts", "fake-screenshot.gif"), fakeUnsupportedImage("gif"));
	await Bun.write(path.join(root, "artifacts", "fake-screenshot.bmp"), fakeUnsupportedImage("bmp"));
	await Bun.write(path.join(root, "artifacts", "fake-screenshot.webp"), fakeUnsupportedImage("webp"));
	await Bun.write(path.join(root, "artifacts", "fake-screenshot.jpg"), fakeHeaderOnlyJpeg());
	await Bun.write(path.join(root, "artifacts", "adversarial-report.txt"), "adversarial boundary evidence");
	await Bun.write(
		path.join(root, "artifacts", "pty-capture.txt"),
		`${"\x1b[?1049h\x1b[2J\x1b[H"}Native terminal rendered successful flow\r${"\x1b[H"}${"x".repeat(520)}`,
	);
	await Bun.write(
		path.join(root, "artifacts", "plain-pty.txt"),
		`Plain terminal log without control codes ${"x".repeat(520)}`,
	);
}

function executorQaWithSurface(surface: string, artifactRefs: Record<string, unknown>[]): Record<string, unknown> {
	const artifactIds = artifactRefs.map(ref => String(ref.id));
	return {
		status: "passed",
		e2eStatus: "passed",
		redTeamStatus: "passed",
		evidence: "executor built and ran e2e plus red-team QA suite",
		e2eCommands: ["red-team surface check"],
		redTeamCommands: ["red-team artifact check"],
		artifactRefs: [
			...artifactRefs,
			{
				id: "adversarial-report",
				kind: "failure-mode-test",
				path: "artifacts/adversarial-report.txt",
				description: "Adversarial boundary and failure-mode test output",
			},
		],
		contractCoverage: [
			{
				id: "contract-goal",
				contractRef: "approved-plan:goal",
				obligation: "The completed story satisfies the approved user-facing contract",
				status: "covered",
				surfaceEvidenceRefs: ["surface-live"],
				adversarialCaseRefs: ["case-invalid-input"],
			},
		],
		surfaceEvidence: [
			{
				id: "surface-live",
				surface,
				contractRef: "approved-plan:goal",
				invocation: "Exercise the user-facing surface and verify the result",
				verdict: "passed",
				artifactRefs: artifactIds,
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

function cliReplayArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "cli-replay",
		kind: "cli-replay",
		description: "Runtime argv replay for CLI surface",
		replay: {
			schemaVersion: 1,
			kind: "cli-replay",
			replaySafe: true,
			command: ["bun", "-e", 'console.log("ultragoal-cli-ok")'],
			recordedStdout: "ultragoal-cli-ok\n",
			...overrides,
		},
	};
}

function cliExecutorQa(artifactRefs: Record<string, unknown>[]): Record<string, unknown> {
	return executorQaWithSurface("cli", artifactRefs);
}

async function expectRejectedExecutorQa(root: string, executorQa: Record<string, unknown>): Promise<string> {
	await createUltragoalPlan({ cwd: root, brief: "Ship CLI replay" });
	await startNextUltragoalGoal({ cwd: root });
	const result = await runNativeUltragoalCommand(
		[
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"focused CLI replay gate check",
			"--quality-gate-json",
			JSON.stringify({ ...JSON.parse(passingQualityGate()), executorQa }),
		],
		root,
	);
	expect(result.status).toBe(1);
	return result.stderr ?? "";
}

async function expectAcceptedExecutorQa(root: string, executorQa: Record<string, unknown>): Promise<void> {
	await createUltragoalPlan({ cwd: root, brief: "Ship CLI replay" });
	await startNextUltragoalGoal({ cwd: root });
	const result = await runNativeUltragoalCommand(
		[
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"focused CLI replay gate check",
			"--quality-gate-json",
			JSON.stringify({ ...JSON.parse(passingQualityGate()), executorQa }),
		],
		root,
	);
	expect(result.status).toBe(0);
}
function webExecutorQa(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return executorQaWithSurface(
		"gui/web",
		[
			{
				id: "browser-run",
				kind: "browser-automation",
				path: "artifacts/browser-run.json",
				description: "Browser automation transcript that invokes the approved user-facing flow",
			},
			{
				id: "gui-screenshot",
				kind: "screenshot",
				path: "artifacts/gui-screenshot.png",
				description: "Screenshot evidence for the GUI/web surface verdict",
			},
		].map(ref => ({ ...ref, ...((overrides[ref.id] as Record<string, unknown> | undefined) ?? {}) })),
	);
}

async function passingLiveQualityGate(root: string): Promise<string> {
	await writeStructuralArtifacts(root);
	return passingQualityGate();
}

function batchChangeSetPaths(): Array<{ path: string; status: string }> {
	return [
		{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts", status: "modified" },
		{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-guard.ts", status: "modified" },
		{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-receipt-freshness.ts", status: "added" },
		{ path: "packages/coding-agent/test/gjc-runtime/ultragoal-runtime.test.ts", status: "modified" },
		{ path: "packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md", status: "modified" },
		{ path: "packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md", status: "modified" },
		{ path: "packages/coding-agent/src/prompts/system/system-prompt.md", status: "modified" },
		{ path: "packages/coding-agent/test/default-gjc-definitions.test.ts", status: "modified" },
		{ path: "packages/coding-agent/src/gjc-runtime/workflow-manifest.generated.json", status: "modified" },
		{ path: "packages/coding-agent/src/gjc-runtime/workflow-manifest.ts", status: "modified" },
	];
}

function deferredBatchGate(
	goalId: string,
	validationBatch: { batchId: string; memberIds: string[]; finalGoalId: string; metadataHash: string },
): string {
	const paths = batchChangeSetPaths();
	return JSON.stringify({
		deferredToBatch: {
			schemaVersion: 1,
			kind: "validation-batch-deferred",
			batchId: validationBatch.batchId,
			memberIds: validationBatch.memberIds,
			finalGoalId: validationBatch.finalGoalId,
			metadataHash: validationBatch.metadataHash,
			deferredLanes: ["architectReview", "executorQa"],
			targetedVerification: {
				status: "passed",
				commands: ["bun test validation batch"],
				evidence: `Targeted verification passed for ${goalId}.`,
			},
			aiSlopCleaner: { status: "passed", evidence: `Cleaner found no blockers for ${goalId}.` },
			iteration: {
				status: "passed",
				fullRerun: true,
				rerunCommands: ["bun test validation batch"],
				evidence: "Rerun passed after cleaner.",
				blockers: [],
			},
			changeSet: {
				memberGoalId: goalId,
				cumulativeFromBase: true,
				paths,
				changeSetHash: hashStructuredValue(paths.map(row => ({ ...row, oldPath: undefined }))),
			},
		},
	});
}

function batchCloseGate(plan: NonNullable<Awaited<ReturnType<typeof readUltragoalPlan>>>): string {
	const finalGoal = plan.goals.find(goal => goal.id === "G003")!;
	const validationBatch = finalGoal.validationBatch!;
	const paths = batchChangeSetPaths();
	const memberChangeSetHashes: Record<string, string> = {};
	const memberMetadataHashes: Record<string, string> = {};
	const memberReceipts = [];
	for (const goal of plan.goals) {
		memberMetadataHashes[goal.id] = goal.validationBatch!.metadataHash;
		if (
			goal.id !== validationBatch.finalGoalId &&
			goal.completionVerification?.validationBatch?.role === "deferred-member"
		) {
			memberChangeSetHashes[goal.id] = goal.completionVerification.validationBatch.changeSetHash;
			memberReceipts.push({
				goalId: goal.id,
				receiptId: goal.completionVerification.receiptId,
				checkpointLedgerEventId: goal.completionVerification.checkpointLedgerEventId,
				qualityGateHash: goal.completionVerification.qualityGateHash,
				changeSetHash: goal.completionVerification.validationBatch.changeSetHash,
				role: "deferred-member",
			});
		}
	}
	memberChangeSetHashes[validationBatch.finalGoalId] = hashStructuredValue(
		paths.map(row => ({ ...row, oldPath: undefined })),
	);
	const baseGate = JSON.parse(passingQualityGate());
	return JSON.stringify({
		...baseGate,
		validationBatchClose: {
			schemaVersion: 1,
			kind: "validation-batch-close",
			batchId: validationBatch.batchId,
			finalGoalId: validationBatch.finalGoalId,
			memberIds: validationBatch.memberIds,
			memberMetadataHashes,
			memberReceipts,
			unionChangeSet: {
				source: "validation-batch",
				memberChangeSetHashes,
				paths,
				unionHash: hashStructuredValue({
					memberChangeSetHashes,
					paths: paths.map(row => ({ ...row, oldPath: undefined })),
				}),
			},
			coverageEvidence: "Union validation covered the validation batch.",
		},
	});
}

async function appendTestLedgerEntry(root: string, entry: Record<string, unknown>): Promise<void> {
	const ledgerPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl");
	await fs.appendFile(
		ledgerPath,
		`${JSON.stringify({ eventId: `test-${Date.now()}-${Math.random()}`, timestamp: new Date().toISOString(), ...entry })}\n`,
	);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
	return (await Bun.file(filePath).json()) as Record<string, unknown>;
}

async function seedStaleUltragoalWorkflowState(root: string): Promise<void> {
	const stateDir = sessionStateDir(root, TEST_SESSION_ID);
	await fs.mkdir(stateDir, { recursive: true });
	const staleAt = "2026-01-01T00:00:00.000Z";
	await Bun.write(
		path.join(stateDir, "ultragoal-state.json"),
		JSON.stringify(
			{
				skill: "ultragoal",
				version: 1,
				active: true,
				current_phase: "goal-planning",
				updated_at: staleAt,
			},
			null,
			2,
		),
	);
	await Bun.write(
		path.join(stateDir, "skill-active-state.json"),
		JSON.stringify(
			{
				version: 1,
				active: true,
				skill: "ultragoal",
				phase: "goal-planning",
				updated_at: staleAt,
				active_skills: [
					{
						skill: "ultragoal",
						phase: "goal-planning",
						active: true,
						updated_at: staleAt,
						hud: {
							version: 1,
							chips: [{ label: "status", value: "goal-planning" }],
						},
					},
				],
			},
			null,
			2,
		),
	);
}

async function seedStaleUltragoalActiveEntry(root: string): Promise<void> {
	const stateDir = sessionStateDir(root, TEST_SESSION_ID);
	await fs.mkdir(path.join(stateDir, "active"), { recursive: true });
	const staleAt = "2026-01-01T00:00:00.000Z";
	const entry = {
		skill: "ultragoal",
		phase: "goal-planning",
		active: true,
		updated_at: staleAt,
		hud: {
			version: 1,
			chips: [{ label: "status", value: "goal-planning" }],
		},
	};
	await Bun.write(activeEntryPath(root, TEST_SESSION_ID, "ultragoal"), JSON.stringify(entry, null, 2));
	await Bun.write(
		path.join(stateDir, "skill-active-state.json"),
		JSON.stringify(
			{
				version: 1,
				active: true,
				skill: "ultragoal",
				phase: "goal-planning",
				updated_at: staleAt,
				active_skills: [entry],
			},
			null,
			2,
		),
	);
}

function mutateQualityGate(mutator: (gate: Record<string, Record<string, unknown>>) => void): string {
	const gate = JSON.parse(passingQualityGate()) as Record<string, Record<string, unknown>>;
	mutator(gate);
	return JSON.stringify(gate);
}

async function mutateLiveQualityGate(
	root: string,
	mutator: (gate: Record<string, Record<string, unknown>>) => void,
): Promise<string> {
	const gate = JSON.parse(await passingLiveQualityGate(root)) as Record<string, Record<string, unknown>>;
	mutator(gate);
	return JSON.stringify(gate);
}

async function expectRejectedCompleteGate(
	root: string,
	_created: { gjcObjective: string },
	qualityGateJson: string,
): Promise<string> {
	const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
	const beforeLedger = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text();
	const result = await runNativeUltragoalCommand(
		[
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"tests passed",
			"--quality-gate-json",
			qualityGateJson,
		],
		root,
	);
	expect(result.status).toBe(1);
	expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(beforeGoals);
	expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text()).toBe(
		beforeLedger,
	);
	return result.stderr ?? "";
}

async function expectRejectedSteering(root: string, args: string[], kind: string): Promise<string> {
	const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
	const beforeLedger = await readUltragoalLedger(root);
	const result = await runNativeUltragoalCommand(args, root);
	const afterLedger = await readUltragoalLedger(root);
	const rejection = afterLedger.at(-1);

	expect(result.status).toBe(1);
	expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(beforeGoals);
	expect(afterLedger).toHaveLength(beforeLedger.length + 1);
	expect(rejection).toMatchObject({ event: "steering_rejected", kind });
	return result.stderr ?? "";
}

describe("ultragoal CLI replay validation", () => {
	it("accepts replaySafe allowlisted bun -e argv replay with matching stdout", async () => {
		const root = await tempDir();
		await expectAcceptedExecutorQa(root, cliExecutorQa([cliReplayArtifact()]));
	});

	it("rejects string commands and unallowlisted argv commands", async () => {
		const stringRoot = await tempDir();
		const stringError = await expectRejectedExecutorQa(
			stringRoot,
			cliExecutorQa([cliReplayArtifact({ command: 'bun -e "console.log(1)"' })]),
		);
		expect(stringError).toContain("argv string array");

		const unallowlistedRoot = await tempDir();
		const unallowlistedError = await expectRejectedExecutorQa(
			unallowlistedRoot,
			cliExecutorQa([cliReplayArtifact({ command: ["bun", "install"] })]),
		);
		expect(unallowlistedError).toContain("allowlist");
		expect(unallowlistedError).toContain('command "bun" with 1 arg is blocked');
		expect(unallowlistedError).not.toContain("install");
		expect(unallowlistedError).toContain("Allowed replay commands");
		expect(unallowlistedError).toContain("replayExempt metadata");
	});

	it("rejects execution-affecting env and git side-effect flags", async () => {
		const envRoot = await tempDir();
		const envError = await expectRejectedExecutorQa(
			envRoot,
			cliExecutorQa([cliReplayArtifact({ env: { NODE_OPTIONS: "--require ./evil.js" } })]),
		);
		expect(envError).toContain("env.NODE_OPTIONS");
		expect(envError).toContain("safe environment allowlist");

		const gitRoot = await tempDir();
		const gitError = await expectRejectedExecutorQa(
			gitRoot,
			cliExecutorQa([
				cliReplayArtifact({
					command: ["git", "diff", "--output=artifact.txt"],
					recordedStdout: "",
				}),
			]),
		);
		expect(gitError).toContain("allowlist");
		expect(gitError).toContain('command "git" with 2 args is blocked');
		expect(gitError).not.toContain("--output=artifact.txt");
	});

	it("rejects path-qualified or case-spoofed replay executables", async () => {
		const root = await tempDir();
		for (const command of [
			["./git", "status"],
			["/tmp/npm", "--version"],
			["scripts/node", "--version"],
			["GIT", "status"],
		]) {
			const error = await expectRejectedExecutorQa(
				root,
				cliExecutorQa([cliReplayArtifact({ command, recordedStdout: "" })]),
			);
			expect(error).toContain("allowlist");
		}
	});

	it("kills SIGTERM-ignoring CLI replay processes during timeout escalation", async () => {
		let killedWith: string | undefined;
		let exit!: (code: number) => void;
		const exited = new Promise<number>(resolve => {
			exit = resolve;
		});
		const fakeProcess = {
			exited,
			kill(signal?: number | NodeJS.Signals) {
				killedWith = typeof signal === "string" ? signal : undefined;
				if (signal === "SIGKILL") exit(137);
			},
		};
		await expect(waitForReplayProcessWithTimeout(fakeProcess, 1, 1)).rejects.toThrow("timeout");
		expect(killedWith).toBe("SIGKILL");
	});

	it("rejects stdout mismatches", async () => {
		const root = await tempDir();
		const error = await expectRejectedExecutorQa(
			root,
			cliExecutorQa([cliReplayArtifact({ recordedStdout: "wrong\n" })]),
		);
		expect(error).toContain("stdout did not match");
	});

	it("accepts audited replayExempt with structurally-valid fallback and rejects invalid exemptions", async () => {
		const acceptedRoot = await tempDir();
		await writeStructuralArtifacts(acceptedRoot);
		await expectAcceptedExecutorQa(
			acceptedRoot,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					description: "Unsafe CLI replay exemption with fallback",
					replay: {
						schemaVersion: 1,
						kind: "cli-replay",
						replayExempt: {
							reasonCode: "requires_network",
							reason:
								"Command depends on a live external service and cannot be deterministically replayed in the gate.",
							approvedBy: "executor-qa",
							fallbackArtifactRefs: ["pty-capture"],
						},
					},
				},
				{
					id: "pty-capture",
					kind: "pty-capture",
					path: "artifacts/pty-capture.txt",
					description: "Structurally-valid terminal fallback capture",
				},
			]),
		);

		const invalidReasonCodeRoot = await tempDir();
		await writeStructuralArtifacts(invalidReasonCodeRoot);
		const invalidReasonCodeError = await expectRejectedExecutorQa(
			invalidReasonCodeRoot,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					description: "Invalid reasonCode CLI replay exemption",
					replay: {
						schemaVersion: 1,
						kind: "cli-replay",
						replayExempt: {
							reasonCode: "network_required",
							reason:
								"Command depends on a live external service and cannot be deterministically replayed in the gate.",
							approvedBy: "executor-qa",
							fallbackArtifactRefs: ["pty-capture"],
						},
					},
				},
				{
					id: "pty-capture",
					kind: "pty-capture",
					path: "artifacts/pty-capture.txt",
					description: "Structurally-valid terminal fallback capture",
				},
			]),
		);
		expect(invalidReasonCodeError).toContain("reasonCode must be one of");
		expect(invalidReasonCodeError).toContain("requires_network");
		expect(invalidReasonCodeError).toContain("platform_unavailable");

		const missingReasonRoot = await tempDir();
		await writeStructuralArtifacts(missingReasonRoot);
		const missingReasonError = await expectRejectedExecutorQa(
			missingReasonRoot,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					description: "Invalid CLI replay exemption",
					replay: {
						schemaVersion: 1,
						kind: "cli-replay",
						replayExempt: {
							reasonCode: "requires_network",
							approvedBy: "executor-qa",
							fallbackArtifactRefs: ["pty-capture"],
						},
					},
				},
				{
					id: "pty-capture",
					kind: "pty-capture",
					path: "artifacts/pty-capture.txt",
					description: "Structurally-valid terminal fallback capture",
				},
			]),
		);
		expect(missingReasonError).toContain("reason");

		const invalidFallbackRoot = await tempDir();
		await writeStructuralArtifacts(invalidFallbackRoot);
		const invalidFallbackError = await expectRejectedExecutorQa(
			invalidFallbackRoot,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					description: "Invalid fallback CLI replay exemption",
					replay: {
						schemaVersion: 1,
						kind: "cli-replay",
						replayExempt: {
							reasonCode: "requires_network",
							reason:
								"Command depends on a live external service and cannot be deterministically replayed in the gate.",
							approvedBy: "executor-qa",
							fallbackArtifactRefs: ["plain-pty"],
						},
					},
				},
				{
					id: "plain-pty",
					kind: "pty-capture",
					path: "artifacts/plain-pty.txt",
					description: "Invalid plain terminal fallback capture",
				},
			]),
		);
		expect(invalidFallbackError).toContain("control sequences");
	});

	it("honors substring regex and not_substring invariants instead of full stdout equality", async () => {
		const root = await tempDir();
		await expectAcceptedExecutorQa(
			root,
			cliExecutorQa([
				cliReplayArtifact({
					recordedStdout: "intentionally different\n",
					invariants: [
						{ type: "substring", value: "ultragoal-cli-ok" },
						{ type: "regex", value: "ULTRAGOAL-CLI-OK", flags: "i" },
						{ type: "not_substring", value: "should-not-appear" },
					],
				}),
			]),
		);
	});
});

describe("native GJC ultragoal runtime", () => {
	it("reports missing status from a fresh repo", async () => {
		const root = await tempDir();

		const result = await runNativeUltragoalCommand(["status"], root);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(0);
		expect(result.stderr).toBeUndefined();
		expect(result.stdout).toContain("No ultragoal plan found");
		expect(status.exists).toBe(false);
		expect(status.status).toBe("missing");
	});

	it("creates a durable aggregate plan and ledger", async () => {
		const root = await tempDir();

		const plan = await createUltragoalPlan({ cwd: root, brief: "Fix native ultragoal status" });
		const goalsRaw = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
		const ledgerRaw = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text();

		expect(plan.gjcGoalMode).toBe("aggregate");
		expect(plan.gjcObjective).toContain(".gjc/ultragoal/goals.json");
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]).toMatchObject({ id: "G001", status: "pending" });
		expect(goalsRaw).toContain("Fix native ultragoal status");
		expect(ledgerRaw).toContain("plan_created");
	});

	it("prints receipt-only json for create-goals", async () => {
		const root = await tempDir();

		const result = await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix", "--json"], root);
		const receipt = JSON.parse(result.stdout ?? "{}");

		expect(result.status).toBe(0);
		expect(receipt).toEqual({
			ok: true,
			goals_count: 1,
			goal_ids: ["G001"],
			goals_path: path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
		});
		expect(receipt).not.toHaveProperty("brief");
		expect(receipt).not.toHaveProperty("goals");
	});

	it("validation batch: accepts valid --validation-batch-json and persists validationBatch on all members", async () => {
		const root = await tempDir();
		const metadata = JSON.stringify([
			{ schemaVersion: 1, batchId: "VB001", memberIds: ["G003", "G001", "G002"], finalGoalId: "G003" },
		]);

		const create = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--brief",
				"@goal: A\na\n@goal: B\nb\n@goal: C\nc",
				"--validation-batch-json",
				metadata,
				"--json",
			],
			root,
		);
		const plan = await readUltragoalPlan(root);
		const batches = plan?.goals.map(goal => goal.validationBatch);

		expect(create.status).toBe(0);
		expect(batches).toHaveLength(3);
		expect(batches?.every(batch => batch !== undefined)).toBe(true);
		expect(batches?.map(batch => batch?.memberIds)).toEqual([
			["G001", "G002", "G003"],
			["G001", "G002", "G003"],
			["G001", "G002", "G003"],
		]);
		expect(batches?.map(batch => batch?.finalGoalId)).toEqual(["G003", "G003", "G003"]);
		expect(new Set(batches?.map(batch => batch?.metadataHash))).toHaveProperty("size", 1);
		expect(batches?.[0]).toMatchObject({ schemaVersion: 1, batchId: "VB001", mode: "aggregate-only" });
	});

	it("validation batch: rejects per-story mode", async () => {
		const root = await tempDir();
		const result = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--gjc-goal-mode",
				"per-story",
				"--brief",
				"@goal: A\na\n@goal: B\nb",
				"--validation-batch-json",
				JSON.stringify([{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002"], finalGoalId: "G002" }]),
			],
			root,
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("validation batches require aggregate ultragoal mode");
	});

	it("validation batch: rejects simultaneous --validation-batch-json and --goal-metadata-json", async () => {
		const root = await tempDir();
		const result = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--brief",
				"@goal: A\na\n@goal: B\nb",
				"--validation-batch-json",
				JSON.stringify([{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002"], finalGoalId: "G002" }]),
				"--goal-metadata-json",
				JSON.stringify([
					{
						schemaVersion: 1,
						goalId: "G001",
						source: "original_plan_graph",
						targets: { files: ["a.ts"], surfaces: ["a"] },
					},
				]),
			],
			root,
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--validation-batch-json and --goal-metadata-json are mutually exclusive");
	});

	it("validation batch: rejects invalid metadata", async () => {
		const cases: Array<[string, string]> = [
			[
				JSON.stringify([{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G003"], finalGoalId: "G001" }]),
				"unknown member G003",
			],
			[
				JSON.stringify([{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G001"], finalGoalId: "G001" }]),
				"duplicate memberIds",
			],
			[
				JSON.stringify([{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001"], finalGoalId: "G002" }]),
				"memberIds must contain finalGoalId G002",
			],
			[
				JSON.stringify([
					{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002"], finalGoalId: "G002" },
					{ schemaVersion: 1, batchId: "VB002", memberIds: ["G002"], finalGoalId: "G002" },
				]),
				"belongs to more than one validation batch",
			],
		];
		for (const [metadata, error] of cases) {
			const root = await tempDir();
			const result = await runNativeUltragoalCommand(
				["create-goals", "--brief", "@goal: A\na\n@goal: B\nb", "--validation-batch-json", metadata],
				root,
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(error);
		}

		const root = await tempDir();
		await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb",
			validationBatches: [{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002"], finalGoalId: "G002" }],
		});
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[0].validationBatch.metadataHash = "stale";
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);

		await expect(readUltragoalPlan(root)).rejects.toThrow("Goal G001 has stale validation batch metadata hash");
	});

	it("validation batch deferred: uses CI changed paths when git diff is unavailable", async () => {
		const savedChangedPaths = process.env.CI_DEV_CHANGED_PATHS;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-runtime-ci-paths-"));
		tempRoots.push(root);
		process.env.CI_DEV_CHANGED_PATHS = batchChangeSetPaths()
			.map(row => row.path)
			.join("\n");
		try {
			await writeStructuralArtifacts(root);
			const plan = await createUltragoalPlan({
				cwd: root,
				brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
				validationBatches: [
					{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
				],
			});
			await startNextUltragoalGoal({ cwd: root });
			const uncovered = JSON.parse(deferredBatchGate("G001", plan.goals[0]!.validationBatch!));
			uncovered.deferredToBatch.changeSet.paths = [
				{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts", status: "modified" },
			];
			uncovered.deferredToBatch.changeSet.changeSetHash = hashStructuredValue(
				uncovered.deferredToBatch.changeSet.paths.map((row: Record<string, unknown>) => ({
					...row,
					oldPath: undefined,
				})),
			);
			await expect(
				checkpointUltragoalGoal({
					cwd: root,
					goalId: "G001",
					status: "complete",
					evidence: "uncovered path",
					qualityGateJson: JSON.stringify(uncovered),
				}),
			).rejects.toThrow("does not cover computed checkpoint change-set path");
			await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "targeted verification passed",
				qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
			});
		} finally {
			if (savedChangedPaths === undefined) delete process.env.CI_DEV_CHANGED_PATHS;
			else process.env.CI_DEV_CHANGED_PATHS = savedChangedPaths;
		}
	});
	it("validation batch deferred: accepts deferred gate and rejects strict keys/uncovered paths", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		const plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "fake strict gate",
				qualityGateJson: JSON.stringify({
					...JSON.parse(deferredBatchGate("G001", plan.goals[0]!.validationBatch!)),
					architectReview: {},
				}),
			}),
		).rejects.toThrow("unsupported keys");
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "fake executor qa",
				qualityGateJson: JSON.stringify({
					...JSON.parse(deferredBatchGate("G001", plan.goals[0]!.validationBatch!)),
					executorQa: { status: "passed" },
				}),
			}),
		).rejects.toThrow("unsupported keys");
		const uncovered = JSON.parse(deferredBatchGate("G001", plan.goals[0]!.validationBatch!));
		uncovered.deferredToBatch.changeSet.paths = [
			{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts", status: "modified" },
		];
		uncovered.deferredToBatch.changeSet.changeSetHash = hashStructuredValue(
			uncovered.deferredToBatch.changeSet.paths.map((row: Record<string, unknown>) => ({
				...row,
				oldPath: undefined,
			})),
		);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "uncovered path",
				qualityGateJson: JSON.stringify(uncovered),
			}),
		).rejects.toThrow("does not cover computed checkpoint change-set path");
		const accepted = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "targeted verification passed",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		expect(accepted.goals[0]!.completionVerification?.validationBatch?.role).toBe("deferred-member");
		expect(
			validateCompletionReceipt({
				plan: accepted,
				ledger: await readUltragoalLedger(root),
				goal: accepted.goals[0]!,
				receiptKind: "per-goal",
			}).state,
		).toBe("active_missing_final_receipt");
	});

	it("validation batch close: rejects out-of-order, accepts close, keeps members deferred, and stales after member mutation", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		let plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[2].status = "active";
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "premature close",
				qualityGateJson: batchCloseGate(plan),
			}),
		).rejects.toThrow("cannot close before G002 is complete");
		saved.goals[2].status = "pending";
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "g002 same cumulative path",
			qualityGateJson: deferredBatchGate("G002", plan.goals[1]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G003",
			status: "complete",
			evidence: "batch close",
			qualityGateJson: batchCloseGate(plan),
		});
		const ledger = await readUltragoalLedger(root);
		expect(plan.goals[2]!.completionVerification?.validationBatch?.role).toBe("batch-close");
		expect(plan.goals[0]!.completionVerification?.validationBatch?.role).toBe("deferred-member");
		expect(
			validateCompletionReceipt({ plan, ledger, goal: plan.goals[2]!, receiptKind: "final-aggregate" }).state,
		).toBe("active_verified_complete");
		expect(validateCompletionReceipt({ plan, ledger, goal: plan.goals[0]!, receiptKind: "per-goal" }).state).toBe(
			"active_verified_complete",
		);
		plan.goals[0]!.updatedAt = new Date(Date.now() + 1000).toISOString();
		expect(
			validateCompletionReceipt({ plan, ledger, goal: plan.goals[2]!, receiptKind: "final-aggregate" }).state,
		).toBe("active_stale_receipt");
	});

	it("validation batch idempotent replay rejects stale durable metadata before early return", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		let plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[0].validationBatch.memberIds = ["G001", "G003"];
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "g001 deferred",
				qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
			}),
		).rejects.toThrow("stale validation batch metadata hash");
	});

	it("validation batch idempotent replay rejects deleted durable metadata before early return", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		let plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		delete saved.goals[0].validationBatch;
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "g001 deferred",
				qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
			}),
		).rejects.toThrow("stale validation batch completion receipt");
	});

	it("validation batch close rejects receipt-stale deferred member", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		let plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "g002 deferred",
			qualityGateJson: deferredBatchGate("G002", plan.goals[1]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[0].updatedAt = new Date(Date.now() + 1000).toISOString();
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "batch close",
				qualityGateJson: batchCloseGate(plan),
			}),
		).rejects.toThrow("receipt generation is stale");
	});

	it("validation batch close idempotent replay rejects changed member basis", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		let plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "g002 deferred",
			qualityGateJson: deferredBatchGate("G002", plan.goals[1]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G003",
			status: "complete",
			evidence: "batch close",
			qualityGateJson: batchCloseGate(plan),
		});
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[0].updatedAt = new Date(Date.now() + 1000).toISOString();
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "batch close",
				qualityGateJson: batchCloseGate(plan),
			}),
		).rejects.toThrow("receipt generation is stale");
	});

	it("validation batch close idempotent replay rejects stale final receipt", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		let plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "g002 deferred",
			qualityGateJson: deferredBatchGate("G002", plan.goals[1]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G003",
			status: "complete",
			evidence: "batch close",
			qualityGateJson: batchCloseGate(plan),
		});
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[2].updatedAt = new Date(Date.now() + 1000).toISOString();
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "batch close",
				qualityGateJson: batchCloseGate(plan),
			}),
		).rejects.toThrow("receipt generation is stale");
	});

	it("validation batch close rejects member durable receipt when ledger payload differs", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		let plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "g002 deferred",
			qualityGateJson: deferredBatchGate("G002", plan.goals[1]!.validationBatch!),
		});
		await startNextUltragoalGoal({ cwd: root });
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[0].completionVerification.receiptId = "tampered-receipt-id";
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		const tamperedPlan = (await readUltragoalPlan(root))!;
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "batch close",
				qualityGateJson: batchCloseGate(tamperedPlan),
			}),
		).rejects.toThrow("receipt ledger event is missing");
	});

	it("validation batch steering invalidation rejects after deferred receipt and allows before deferred receipt", async () => {
		const splitArgs = [
			"steer",
			"--kind",
			"split_subgoal",
			"--goal-id",
			"G002",
			"--replacements-json",
			JSON.stringify([
				{ title: "Replacement A", objective: "Do replacement A." },
				{ title: "Replacement B", objective: "Do replacement B." },
			]),
			"--evidence",
			"batch member needs split",
			"--rationale",
			"split before validation is safe",
			"--json",
		];
		const allowedRoot = await batchTempDir();
		await createUltragoalPlan({
			cwd: allowedRoot,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		const allowed = await runNativeUltragoalCommand(splitArgs, allowedRoot);
		expect(allowed.status).toBe(0);
		const allowedPlan = await readUltragoalPlan(allowedRoot);
		expect(allowedPlan?.goals.find(goal => goal.id === "G001")?.validationBatch).toBeUndefined();
		expect(allowedPlan?.goals.find(goal => goal.id === "G002")?.validationBatch).toBeUndefined();
		expect(allowedPlan?.goals.find(goal => goal.id === "G003")?.validationBatch).toBeUndefined();
		expect(allowedPlan?.goals.find(goal => goal.id === "G004")?.validationBatch).toBeUndefined();
		await startNextUltragoalGoal({ cwd: allowedRoot });
		const activeAfterClear = (await readUltragoalPlan(allowedRoot))!.goals.find(goal => goal.status === "active")!;
		expect(activeAfterClear.validationBatch).toBeUndefined();
		await expect(
			checkpointUltragoalGoal({
				cwd: allowedRoot,
				goalId: activeAfterClear.id,
				status: "complete",
				evidence: "cannot force close",
				qualityGateJson: JSON.stringify({ ...JSON.parse(passingQualityGate()), validationBatchClose: {} }),
			}),
		).rejects.toThrow("unsupported keys");

		const rejectedRoot = await batchTempDir();
		await writeStructuralArtifacts(rejectedRoot);
		let plan = await createUltragoalPlan({
			cwd: rejectedRoot,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: rejectedRoot });
		plan = await checkpointUltragoalGoal({
			cwd: rejectedRoot,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		const split = await runNativeUltragoalCommand(splitArgs, rejectedRoot);
		expect(split.status).toBe(1);
		expect(split.stderr).toContain("validation batch VB001");
		expect(split.stderr).toContain("member G001");
		const revise = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"revise_pending_wording",
				"--goal-id",
				"G002",
				"--title",
				"Revised B",
				"--evidence",
				"batch member wording changed",
				"--rationale",
				"wording would invalidate batch",
				"--json",
			],
			rejectedRoot,
		);
		expect(revise.status).toBe(1);
		expect(revise.stderr).toContain("validation batch VB001");
		await checkpointUltragoalGoal({
			cwd: rejectedRoot,
			goalId: "G003",
			status: "blocked",
			evidence: "final goal obsolete",
		});
		const supersede = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"mark_blocked_superseded",
				"--goal-id",
				"G003",
				"--evidence",
				"final goal replacement requested",
				"--rationale",
				"supersede would invalidate batch",
				"--json",
			],
			rejectedRoot,
		);
		expect(supersede.status).toBe(1);
		expect(supersede.stderr).toContain("validation batch VB001");
	});

	it("stores explicit pipeline metadata and starts one eligible overlap", async () => {
		const root = await tempDir();
		const metadata = JSON.stringify([
			{
				schemaVersion: 1,
				goalId: "G001",
				source: "original_plan_graph",
				dependsOn: [],
				independentOf: ["G002"],
				targets: { files: ["packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts"], surfaces: ["runtime"] },
			},
			{
				schemaVersion: 1,
				goalId: "G002",
				source: "original_plan_graph",
				dependsOn: [],
				independentOf: ["G001"],
				targets: {
					files: ["packages/coding-agent/test/gjc-runtime/ultragoal-runtime.test.ts"],
					surfaces: ["tests"],
				},
			},
		]);

		const create = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--brief",
				"@goal: Runtime\nImplement runtime\n@goal: Tests\nImplement tests",
				"--goal-metadata-json",
				metadata,
				"--json",
			],
			root,
		);
		await runNativeUltragoalCommand(["complete-goals", "--json"], root);
		const start = await runNativeUltragoalCommand(
			[
				"start-pipeline-overlap",
				"--prior-goal-id",
				"G001",
				"--next-goal-id",
				"G002",
				"--review-handles-json",
				JSON.stringify([{ id: "architect-G001", agent: "architect" }]),
				"--qa-handles-json",
				JSON.stringify([{ id: "executor-qa-G001", agent: "executor" }]),
				"--implementation-handle-json",
				JSON.stringify({ id: "executor-G002", agent: "executor" }),
				"--json",
			],
			root,
		);
		const receipt = JSON.parse(start.stdout ?? "{}");
		const plan = await readUltragoalPlan(root);
		const ledger = await readUltragoalLedger(root);

		expect(create.status).toBe(0);
		expect(start.status).toBe(0);
		expect(receipt).toMatchObject({
			ok: true,
			event: "pipeline_overlap_started",
			prior_goal_id: "G001",
			next_goal_id: "G002",
			status: "open",
			next_goal_status: "active",
		});
		expect(receipt).not.toHaveProperty("goals");
		expect(plan?.goals.map(goal => [goal.id, goal.status, goal.pipelineMetadata?.overlap])).toEqual([
			["G001", "active", "open"],
			["G002", "active", "open"],
		]);
		expect(plan?.goals.every(goal => goal.pipelineMetadata?.eligible === true)).toBe(true);
		expect(ledger.some(event => event.event === "pipeline_overlap_started" && event.priorGoalId === "G001")).toBe(
			true,
		);
	});

	it("rejects unsafe pipeline metadata and per-story overlap", async () => {
		const root = await tempDir();
		const malformed = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--brief",
				"@goal: A\na\n@goal: B\nb",
				"--goal-metadata-json",
				JSON.stringify([
					{
						schemaVersion: 1,
						goalId: "G003",
						source: "original_plan_graph",
						targets: { files: ["a.ts"], surfaces: ["a"] },
					},
				]),
				"--json",
			],
			root,
		);
		expect(malformed.status).toBe(1);
		expect(malformed.stderr).toContain("unknown goal id G003");
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).exists()).toBe(false);
		const emptyTargets = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--brief",
				"@goal: A\na\n@goal: B\nb",
				"--goal-metadata-json",
				JSON.stringify([
					{
						schemaVersion: 1,
						goalId: "G001",
						source: "original_plan_graph",
						targets: { files: [], surfaces: [] },
					},
				]),
				"--json",
			],
			root,
		);
		expect(emptyTargets.status).toBe(1);
		expect(emptyTargets.stderr).toContain("requires files or surfaces");
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).exists()).toBe(false);
		const duplicateTargets = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--brief",
				"@goal: A\na\n@goal: B\nb",
				"--goal-metadata-json",
				JSON.stringify([
					{
						schemaVersion: 1,
						goalId: "G001",
						source: "original_plan_graph",
						targets: { files: ["a.ts", "a.ts"], surfaces: ["a"] },
					},
				]),
				"--json",
			],
			root,
		);
		expect(duplicateTargets.status).toBe(1);
		expect(duplicateTargets.stderr).toContain("duplicate normalized paths");
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).exists()).toBe(false);
		const unsafeTraversal = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--brief",
				"@goal: A\na\n@goal: B\nb",
				"--goal-metadata-json",
				JSON.stringify([
					{
						schemaVersion: 1,
						goalId: "G001",
						source: "original_plan_graph",
						targets: { files: ["safe/../target.ts"], surfaces: ["a"] },
					},
				]),
				"--json",
			],
			root,
		);
		expect(unsafeTraversal.status).toBe(1);
		expect(unsafeTraversal.stderr).toContain("unsafe path");
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).exists()).toBe(false);

		const metadata = JSON.stringify([
			{
				schemaVersion: 1,
				goalId: "G001",
				source: "original_plan_graph",
				independentOf: ["G002"],
				targets: { files: ["a.ts"], surfaces: ["a"] },
			},
			{
				schemaVersion: 1,
				goalId: "G002",
				source: "original_plan_graph",
				independentOf: ["G001"],
				targets: { files: ["b.ts"], surfaces: ["b"] },
			},
		]);
		const create = await runNativeUltragoalCommand(
			[
				"create-goals",
				"--gjc-goal-mode",
				"per-story",
				"--brief",
				"@goal: A\na\n@goal: B\nb",
				"--goal-metadata-json",
				metadata,
			],
			root,
		);
		await runNativeUltragoalCommand(["complete-goals"], root);
		const overlap = await runNativeUltragoalCommand(
			[
				"start-pipeline-overlap",
				"--prior-goal-id",
				"G001",
				"--next-goal-id",
				"G002",
				"--review-handles-json",
				JSON.stringify([{ id: "review" }]),
				"--qa-handles-json",
				JSON.stringify([{ id: "qa" }]),
				"--implementation-handle-json",
				JSON.stringify({ id: "impl" }),
			],
			root,
		);

		expect(create.status).toBe(0);
		expect(overlap.status).toBe(1);
		expect(overlap.stderr).toContain("aggregate ultragoal mode");
	});

	it("fails closed for open and quarantined pipeline checkpoints", async () => {
		const root = await tempDir();
		const metadata = JSON.stringify([
			{
				schemaVersion: 1,
				goalId: "G001",
				source: "original_plan_graph",
				independentOf: ["G002"],
				targets: { files: ["a.ts"], surfaces: ["a"] },
			},
			{
				schemaVersion: 1,
				goalId: "G002",
				source: "original_plan_graph",
				independentOf: ["G001"],
				targets: { files: ["b.ts"], surfaces: ["b"] },
			},
		]);
		await runNativeUltragoalCommand(
			["create-goals", "--brief", "@goal: A\na\n@goal: B\nb", "--goal-metadata-json", metadata],
			root,
		);
		await runNativeUltragoalCommand(["complete-goals"], root);
		const start = await runNativeUltragoalCommand(
			[
				"start-pipeline-overlap",
				"--prior-goal-id",
				"G001",
				"--next-goal-id",
				"G002",
				"--review-handles-json",
				JSON.stringify([{ id: "review" }]),
				"--qa-handles-json",
				JSON.stringify([{ id: "qa" }]),
				"--implementation-handle-json",
				JSON.stringify({ id: "impl" }),
				"--json",
			],
			root,
		);
		const overlapId = JSON.parse(start.stdout ?? "{}").overlap_id as string;
		const openCheckpoint = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "tests passed"],
			root,
		);
		const join = await runNativeUltragoalCommand(
			[
				"join-pipeline-overlap",
				"--overlap-id",
				overlapId,
				"--review-result-json",
				JSON.stringify({
					status: "failed",
					evidence: "review failed without structured blocker footprints",
					blockers: [],
				}),
				"--qa-result-json",
				JSON.stringify({ status: "passed", evidence: "qa passed", blockers: [] }),
				"--json",
			],
			root,
		);
		const quarantinedCheckpoint = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G002", "--status", "complete", "--evidence", "tests passed"],
			root,
		);
		const rebaseline = await runNativeUltragoalCommand(
			[
				"rebaseline-pipeline-overlap",
				"--overlap-id",
				overlapId,
				"--goal-id",
				"G002",
				"--evidence",
				"Rebaselined quarantined G002 after rerunning focused verification successfully.",
				"--target-state-json",
				JSON.stringify({ files: ["b.ts"], surfaces: ["b"] }),
				"--json",
			],
			root,
		);
		const plan = await readUltragoalPlan(root);

		expect(openCheckpoint.status).toBe(1);
		expect(openCheckpoint.stderr).toContain("pipeline overlap");
		expect(join.status).toBe(0);
		expect(JSON.parse(join.stdout ?? "{}")).toMatchObject({
			event: "pipeline_overlap_quarantined",
			status: "quarantine_required",
		});
		expect(quarantinedCheckpoint.status).toBe(1);
		expect(quarantinedCheckpoint.stderr).toContain("requires rebaseline");
		expect(rebaseline.status).toBe(0);
		expect(plan?.goals.find(goal => goal.id === "G002")?.pipelineMetadata?.overlap).toBe("rebaseline_complete");
	});

	it("clean joins permit prior checkpoint without starting a third goal", async () => {
		const root = await tempDir();
		const metadata = JSON.stringify([
			{
				schemaVersion: 1,
				goalId: "G001",
				source: "original_plan_graph",
				independentOf: ["G002"],
				targets: { files: ["packages"], surfaces: ["a"] },
			},
			{
				schemaVersion: 1,
				goalId: "G002",
				source: "original_plan_graph",
				independentOf: ["G001"],
				targets: { files: ["b.ts"], surfaces: ["b"] },
			},
			{
				schemaVersion: 1,
				goalId: "G003",
				source: "original_plan_graph",
				independentOf: [],
				targets: { files: ["c.ts"], surfaces: ["c"] },
			},
		]);
		await runNativeUltragoalCommand(
			["create-goals", "--brief", "@goal: A\na\n@goal: B\nb\n@goal: C\nc", "--goal-metadata-json", metadata],
			root,
		);
		await runNativeUltragoalCommand(["complete-goals"], root);
		const start = await runNativeUltragoalCommand(
			[
				"start-pipeline-overlap",
				"--prior-goal-id",
				"G001",
				"--next-goal-id",
				"G002",
				"--review-handles-json",
				JSON.stringify([{ id: "review" }]),
				"--qa-handles-json",
				JSON.stringify([{ id: "qa" }]),
				"--implementation-handle-json",
				JSON.stringify({ id: "impl" }),
				"--json",
			],
			root,
		);
		const overlapId = JSON.parse(start.stdout ?? "{}").overlap_id as string;
		const secondOverlap = await runNativeUltragoalCommand(
			[
				"start-pipeline-overlap",
				"--prior-goal-id",
				"G002",
				"--next-goal-id",
				"G003",
				"--review-handles-json",
				JSON.stringify([{ id: "review-2" }]),
				"--qa-handles-json",
				JSON.stringify([{ id: "qa-2" }]),
				"--implementation-handle-json",
				JSON.stringify({ id: "impl-2" }),
			],
			root,
		);
		const join = await runNativeUltragoalCommand(
			[
				"join-pipeline-overlap",
				"--overlap-id",
				overlapId,
				"--review-result-json",
				JSON.stringify({
					status: "passed",
					handleIds: ["review"],
					evidence: "Architect review passed with complete clean join evidence.",
					blockers: [],
				}),
				"--qa-result-json",
				JSON.stringify({
					status: "passed",
					handleIds: ["qa"],
					evidence: "Executor QA passed with complete clean join evidence.",
					blockers: [],
				}),
				"--json",
			],
			root,
		);
		const checkpoint = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"pipeline prior goal verified cleanly",
				"--quality-gate-json",
				await passingLiveQualityGate(root),
				"--json",
			],
			root,
		);
		const receipt = JSON.parse(checkpoint.stdout ?? "{}");
		const plan = await readUltragoalPlan(root);

		expect(secondOverlap.status).toBe(1);
		expect(secondOverlap.stderr).toContain("another overlap is already open");
		expect(join.status).toBe(0);
		expect(JSON.parse(join.stdout ?? "{}")).toMatchObject({
			event: "pipeline_overlap_joined",
			status: "joined_clean",
		});
		expect(checkpoint.status).toBe(0);
		expect(receipt).toMatchObject({
			goal_id: "G001",
			all_complete: false,
			next_goal_id: "G002",
			next_goal_status: "active",
			started_next: false,
		});
		expect(plan?.goals.map(goal => [goal.id, goal.status])).toEqual([
			["G001", "complete"],
			["G002", "active"],
			["G003", "pending"],
		]);
	});

	it("prints receipt-only json for complete-goals", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

		const result = await runNativeUltragoalCommand(["complete-goals", "--json"], root);
		const receipt = JSON.parse(result.stdout ?? "{}");

		expect(result.status).toBe(0);
		expect(receipt).toMatchObject({
			ok: true,
			all_complete: false,
			next_action: "execute-goal",
			goal_id: "G001",
			goal_status: "active",
			gjc_objective: created.gjcObjective,
			goals_path: path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
		});
		expect(receipt).not.toHaveProperty("plan");
		expect(receipt).not.toHaveProperty("goal");
	});

	it("prints receipt-only json for checkpoint", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				await passingLiveQualityGate(root),
				"--json",
			],
			root,
		);
		const receipt = JSON.parse(result.stdout ?? "{}");

		expect(result.status).toBe(0);
		expect(receipt).toMatchObject({
			ok: true,
			goal_id: "G001",
			status: "complete",
			goals_path: path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
			completion_receipt_kind: "final-aggregate",
		});
		expect(receipt.quality_gate_hash).toEqual(expect.any(String));
		expect(receipt).not.toHaveProperty("goals");
	});

	it("prints checkpoint-specific help with receipt guidance", async () => {
		const root = await tempDir();

		const result = await runNativeUltragoalCommand(["checkpoint", "--help"], root);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("gjc ultragoal checkpoint --goal-id");
		expect(result.stdout).toContain("--quality-gate-json");
		expect(result.stdout).toContain("COMPLETE CHECKPOINT RECEIPTS");
		expect(result.stdout).toContain("obligation");
	});

	it("prints top-level and command-specific help for classify-blocker", async () => {
		const root = await tempDir();

		const topLevel = await runNativeUltragoalCommand(["--help"], root);
		const commandSpecific = await runNativeUltragoalCommand(["classify-blocker", "--help"], root);

		expect(topLevel.status).toBe(0);
		expect(topLevel.stdout).toContain("classify-blocker");
		expect(topLevel.stdout).toContain("gjc ultragoal classify-blocker --help");
		expect(commandSpecific.status).toBe(0);
		expect(commandSpecific.stdout).toContain("--classification <human_blocked|resolvable>");
		expect(commandSpecific.stdout).toContain("--evidence <text>");
		expect(commandSpecific.stdout).toContain("--goal-id=<value>");
	});

	it("prints receipt-only json for steering", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

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
				"--json",
			],
			root,
		);
		const receipt = JSON.parse(result.stdout ?? "{}");

		expect(result.status).toBe(0);
		expect(receipt).toEqual({
			ok: true,
			kind: "add_subgoal",
			goal_id: "G002",
			goals_path: path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
		});
		expect(receipt).not.toHaveProperty("goals");
	});

	it("supports split_subgoal steering with replacement ids and compact receipts", async () => {
		const root = await tempDir();
		await createUltragoalPlan({
			cwd: root,
			brief: ["@goal: First", "Complete first story.", "", "@goal: Second", "Complete second story."].join("\n"),
		});

		const result = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"split_subgoal",
				"--goal-id",
				"G001",
				"--replacements-json",
				JSON.stringify([
					{ title: "Fix parser", objective: "Resolve the parser blocker." },
					{ title: "Verify parser", objective: "Run focused parser verification." },
				]),
				"--evidence",
				"implementation investigation found two independently verifiable parser risks",
				"--rationale",
				"split keeps each replacement story independently auditable",
				"--json",
			],
			root,
		);
		const receipt = JSON.parse(result.stdout ?? "{}");
		const plan = await readUltragoalPlan(root);
		const accepted = (await readUltragoalLedger(root)).at(-1);

		expect(result.status).toBe(0);
		expect(receipt).toMatchObject({
			ok: true,
			kind: "split_subgoal",
			goal_id: "G001",
			replacement_goal_ids: ["G003", "G004"],
			goals_path: path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
		});
		expect(receipt).not.toHaveProperty("goals");
		expect(plan?.goals.map(goal => [goal.id, goal.status])).toEqual([
			["G001", "superseded"],
			["G003", "pending"],
			["G004", "pending"],
			["G002", "pending"],
		]);
		expect(accepted).toMatchObject({
			event: "steering_accepted",
			kind: "split_subgoal",
			replacementGoalIds: ["G003", "G004"],
		});
	});

	it("supports reorder, wording revision, ledger annotation, and blocked supersession", async () => {
		const root = await tempDir();
		await createUltragoalPlan({
			cwd: root,
			brief: [
				"@goal: First",
				"Complete first story.",
				"",
				"@goal: Second",
				"Complete second story.",
				"",
				"@goal: Third",
				"Complete third story.",
			].join("\n"),
		});
		await startNextUltragoalGoal({ cwd: root });

		const reorder = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"reorder_pending",
				"--order-json",
				JSON.stringify(["G003", "G002"]),
				"--evidence",
				"dependency investigation showed third story must precede second story",
				"--rationale",
				"pending-only reorder preserves active and terminal goal positions",
				"--json",
			],
			root,
		);
		expect(reorder.status).toBe(0);
		expect((await readUltragoalPlan(root))?.goals.map(goal => goal.id)).toEqual(["G001", "G003", "G002"]);

		const revise = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"revise_pending_wording",
				"--goal-id",
				"G003",
				"--title",
				"Third story clarified",
				"--evidence",
				"review found the pending story title was too vague",
				"--rationale",
				"clear pending wording improves execution handoff without changing status",
				"--json",
			],
			root,
		);
		expect(revise.status).toBe(0);
		expect((await readUltragoalPlan(root))?.goals.find(goal => goal.id === "G003")?.title).toBe(
			"Third story clarified",
		);

		const goalsBeforeAnnotation = await Bun.file(
			path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
		).text();
		const annotation = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"annotate_ledger",
				"--evidence",
				"user changed release ordering while preserving the aggregate objective",
				"--rationale",
				"recording the runtime direction keeps the durable ledger auditable",
				"--json",
			],
			root,
		);
		expect(annotation.status).toBe(0);
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(
			goalsBeforeAnnotation,
		);

		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "blocked",
			evidence: "blocked by obsolete dependency",
		});
		const supersede = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"mark_blocked_superseded",
				"--goal-id",
				"G002",
				"--evidence",
				"replacement evidence shows this blocked sub-goal is no longer required",
				"--rationale",
				"no replacement is needed because remaining required goals cover the aggregate objective",
				"--json",
			],
			root,
		);
		const supersededGoal = (await readUltragoalPlan(root))?.goals.find(goal => goal.id === "G002");
		expect(supersede.status).toBe(0);
		expect(supersededGoal).toMatchObject({ status: "superseded", steering: { noReplacementRequired: true } });
	});

	it("rejects blocked supersession when it would remove the final required goal", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Complete the only story" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "blocked",
			evidence: "blocked by obsolete dependency",
		});

		const stderr = await expectRejectedSteering(
			root,
			[
				"steer",
				"--kind",
				"mark_blocked_superseded",
				"--goal-id",
				"G001",
				"--evidence",
				"replacement evidence shows this blocked sub-goal is no longer required",
				"--rationale",
				"negative test verifies the final required goal cannot be superseded without replacement",
			],
			"mark_blocked_superseded",
		);

		expect(stderr).toContain("only remaining required goal");
	});

	it("allows blocked supersession when another required goal remains", async () => {
		const root = await tempDir();
		await createUltragoalPlan({
			cwd: root,
			brief: ["@goal: First", "Complete first story.", "", "@goal: Second", "Complete second story."].join("\n"),
		});
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "blocked",
			evidence: "blocked by obsolete dependency",
		});

		const supersede = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"mark_blocked_superseded",
				"--goal-id",
				"G001",
				"--evidence",
				"replacement evidence shows this blocked sub-goal is no longer required",
				"--rationale",
				"remaining required goal covers the aggregate objective",
				"--json",
			],
			root,
		);
		const plan = await readUltragoalPlan(root);

		expect(supersede.status).toBe(0);
		expect(plan?.goals.map(goal => [goal.id, goal.status])).toEqual([
			["G001", "superseded"],
			["G002", "pending"],
		]);
	});

	it("audits known-kind steering rejections without mutating goals", async () => {
		const root = await tempDir();
		await createUltragoalPlan({
			cwd: root,
			brief: ["@goal: First", "Complete first story.", "", "@goal: Second", "Complete second story."].join("\n"),
		});
		await startNextUltragoalGoal({ cwd: root });

		await expectRejectedSteering(
			root,
			[
				"steer",
				"--kind",
				"split_subgoal",
				"--goal-id",
				"G001",
				"--replacements-json",
				JSON.stringify([
					{ title: "A", objective: "A objective" },
					{ title: "B", objective: "B objective" },
				]),
				"--evidence",
				"split attempted against active goal status",
				"--rationale",
				"negative test verifies status boundary audit",
			],
			"split_subgoal",
		);
		await expectRejectedSteering(
			root,
			[
				"steer",
				"--kind",
				"reorder_pending",
				"--order-json",
				JSON.stringify(["G001"]),
				"--evidence",
				"reorder attempted with active goal id",
				"--rationale",
				"negative test verifies pending-only ordering audit",
			],
			"reorder_pending",
		);
		await expectRejectedSteering(
			root,
			[
				"steer",
				"--kind",
				"revise_pending_wording",
				"--goal-id",
				"G001",
				"--title",
				"Active rewrite rejected",
				"--evidence",
				"wording revision attempted against active goal status",
				"--rationale",
				"negative test verifies pending-only wording audit",
			],
			"revise_pending_wording",
		);
		await expectRejectedSteering(
			root,
			[
				"steer",
				"--kind",
				"annotate_ledger",
				"--evidence",
				"annotation is missing required rationale for audit completeness",
			],
			"annotate_ledger",
		);
		await expectRejectedSteering(
			root,
			[
				"steer",
				"--kind",
				"mark_blocked_superseded",
				"--goal-id",
				"G002",
				"--evidence",
				"supersession attempted against pending goal status",
				"--rationale",
				"negative test verifies blocked-only supersession audit",
			],
			"mark_blocked_superseded",
		);
	});

	it("prints receipt-only json for review blockers", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"record-review-blockers",
				"--goal-id",
				"G001",
				"--title",
				"Resolve verification blockers",
				"--objective",
				"Fix architect and executor QA findings.",
				"--evidence",
				"architect found product regression",
				"--json",
			],
			root,
		);
		const receipt = JSON.parse(result.stdout ?? "{}");

		expect(result.status).toBe(0);
		expect(receipt).toEqual({
			ok: true,
			goal_id: "G002",
			goals_path: path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
		});
		expect(receipt).not.toHaveProperty("goals");
	});

	it("starts and checkpoints the current goal", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

		const started = await startNextUltragoalGoal({ cwd: root });
		expect(started.goal?.status).toBe("active");
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		const status = await getUltragoalStatus(root);
		const diagnostic = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(plan.goals[0]?.status).toBe("complete");
		expect(status.status).toBe("complete");
		expect(status.counts.complete).toBe(1);
		expect(diagnostic.state).toBe("active_verified_complete");
		expect(plan.goals[0]?.completionVerification).toMatchObject({
			schemaVersion: 1,
			goalId: "G001",
			receiptKind: "final-aggregate",
		});
	});

	it("dedups duplicate checkpoint ledger entries for an unchanged status and evidence (#645)", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const countCheckpoints = async (): Promise<number> =>
			(await readUltragoalLedger(root)).filter(event => event.event === "goal_checkpointed").length;

		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "blocked",
			evidence: "blocked by obsolete dependency",
		});
		expect(await countCheckpoints()).toBe(1);
		const goalsAfterFirst = await Bun.file(goalsPath).text();

		// Re-checkpoint with identical status + evidence: idempotent — no ledger append, no plan rewrite.
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "blocked",
			evidence: "blocked by obsolete dependency",
		});
		expect(await countCheckpoints()).toBe(1);
		expect(await Bun.file(goalsPath).text()).toBe(goalsAfterFirst);

		// Whitespace-only differences still resolve to the same checkpoint (evidence is trimmed).
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "blocked",
			evidence: "  blocked by obsolete dependency  ",
		});
		expect(await countCheckpoints()).toBe(1);
		expect(await Bun.file(goalsPath).text()).toBe(goalsAfterFirst);

		// A genuine change (new evidence) is still recorded as a fresh checkpoint.
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "blocked",
			evidence: "blocked by a different upstream regression",
		});
		expect(await countCheckpoints()).toBe(2);
	});

	it("completes from durable active goal state", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		expect(plan.goals[0]?.status).toBe("complete");
	});

	it("completes without goal snapshot freshness input", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		expect(plan.goals[0]?.status).toBe("complete");
	});

	it("accepts per-story durable active goals for per-story plans", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix", gjcGoalMode: "per-story" });
		await startNextUltragoalGoal({ cwd: root });
		const storyObjective = created.goals[0]?.objective;
		if (!storyObjective) throw new Error("missing story objective");

		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		expect(plan.goals[0]?.status).toBe("complete");
		expect(plan.goals[0]?.completionVerification?.receiptKind).toBe("per-goal");
	});
	it("continues to next ultragoal goal after checkpointing G001 complete", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await addUltragoalSubgoal({
			cwd: root,
			title: "Second stage",
			objective: "Complete the second stage.",
			evidence: "The regression requires a second required goal.",
			rationale: "Cover continuation after the first checkpoint.",
		});
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				await passingLiveQualityGate(root),
			],
			root,
		);
		const status = await getUltragoalStatus(root);
		const ledger = await readUltragoalLedger(root);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Next ultragoal goal: G002");
		expect(status.goals[0]).toMatchObject({ id: "G001", status: "complete" });
		expect(status.goals[1]).toMatchObject({ id: "G002", status: "active" });
		expect(status.status).toBe("active");
		expect(ledger.filter(event => event.event === "goal_started" && event.goalId === "G002")).toHaveLength(1);
	});

	it("keeps per-goal receipt fresh after unrelated next goal starts", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await addUltragoalSubgoal({
			cwd: root,
			title: "Second stage",
			objective: "Complete the second stage.",
			evidence: "The regression requires a second required goal.",
			rationale: "Cover receipt freshness after continuation.",
		});
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				await passingLiveQualityGate(root),
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const plan = await readUltragoalPlan(root);
		if (!plan) throw new Error("missing ultragoal plan");
		const diagnostic = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal: plan.goals[0]!,
			receiptKind: "per-goal",
		});

		expect(plan.goals[1]).toMatchObject({ id: "G002", status: "active" });
		expect(diagnostic.state).toBe("active_verified_complete");
	});

	it("keeps receipts fresh after no-goalId annotate_ledger steering", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		const result = await runNativeUltragoalCommand(
			[
				"steer",
				"--kind",
				"annotate_ledger",
				"--evidence",
				"operator recorded audit-only completion context after verification",
				"--rationale",
				"Audit-only ledger notes must not change completed goal evidence freshness.",
			],
			root,
		);
		const diagnostic = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(result.status).toBe(0);
		expect(diagnostic.state).toBe("active_verified_complete");
	});

	it("keeps receipts fresh after no-goalId nudge ledger events", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		await appendTestLedgerEntry(root, {
			event: "nudge",
			surface: "ask",
			reason: "audit-only stale completion prompt without a selected goal",
		});
		const diagnostic = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(diagnostic.state).toBe("active_verified_complete");
	});

	it("keeps receipts fresh after same-goalId final receipt nudge but stales after real mutation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		await appendTestLedgerEntry(root, {
			event: "nudge",
			goalId: "G001",
			targetKind: "final_aggregate_receipt",
			surface: "premature_complete",
			reason: "refusal bookkeeping for stale final aggregate receipt prompt must not invalidate freshness",
		});
		const afterRefusalNudge = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(afterRefusalNudge.state).toBe("active_verified_complete");

		await appendTestLedgerEntry(root, {
			event: "goal_checkpointed",
			goalId: "G001",
			status: "complete",
			evidence: "real post-receipt checkpoint mutation must invalidate completion freshness",
		});
		const afterMutation = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(afterMutation.state).toBe("active_stale_receipt");
	});

	it("treats receipts as stale after target goal mutation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		const goal = plan.goals[0];
		if (!goal) throw new Error("missing goal");
		goal.updatedAt = "later-manual-edit";

		const diagnostic = validateCompletionReceipt({
			plan,
			ledger: await readUltragoalLedger(root),
			goal,
			receiptKind: "final-aggregate",
		});

		expect(diagnostic.state).toBe("active_stale_receipt");
	});

	it("treats receipts as dirty after quality gate ledger mutation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		const ledger = await readUltragoalLedger(root);
		const checkpointEvent = ledger.find(event => event.event === "goal_checkpointed");
		if (!checkpointEvent) throw new Error("missing checkpoint event");
		checkpointEvent.qualityGateJson = {
			...(checkpointEvent.qualityGateJson as Record<string, unknown>),
			tampered: true,
		};

		const diagnostic = validateCompletionReceipt({
			plan,
			ledger,
			goal: plan.goals[0]!,
			receiptKind: "final-aggregate",
		});

		expect(diagnostic.state).toBe("active_dirty_quality_gate");
		expect(diagnostic.message).toContain("quality-gate hash");
	});

	it("rejects final-aggregate release when a prior per-goal receipt is tampered", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the multi-stage fix" });
		await addUltragoalSubgoal({
			cwd: root,
			title: "Second stage",
			objective: "Complete the second stage.",
			evidence: "Need a prior required goal to tamper.",
			rationale: "Regression coverage for prior per-goal receipt validation.",
		});
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first stage verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		await startNextUltragoalGoal({ cwd: root });
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "second stage verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		const ledger = await readUltragoalLedger(root);
		const priorEvent = ledger.find(event => event.event === "goal_checkpointed" && event.goalId === "G001");
		if (!priorEvent) throw new Error("missing prior checkpoint event");
		priorEvent.qualityGateJson = {
			...(priorEvent.qualityGateJson as Record<string, unknown>),
			tampered: true,
		};

		const diagnostic = validateCompletionReceipt({
			plan,
			ledger,
			goal: plan.goals.find(goal => goal.id === "G002")!,
			receiptKind: "final-aggregate",
		});

		expect(diagnostic.state).not.toBe("active_verified_complete");
		expect(diagnostic.message).toContain("G001");
	});

	it("blocks complete checkpoints without full architect and executor verification", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const missingGate = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "self verified"],
			root,
		);
		const shallowGate = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				JSON.stringify({ verification: { status: "passed" } }),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(missingGate.status).toBe(1);
		expect(missingGate.stderr).toContain("complete checkpoints require --quality-gate-json");
		expect(shallowGate.status).toBe(1);
		expect(shallowGate.stderr).toContain("qualityGate contains unsupported keys");
		expect(status.goals[0]?.status).toBe("active");
		expect(status.counts.complete).toBe(0);
	});

	it("rejects shallow gates with missing command arrays before mutation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
		const beforeLedger = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text();

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				JSON.stringify({
					architectReview: {
						architectureStatus: "CLEAR",
						productStatus: "CLEAR",
						codeStatus: "CLEAR",
						recommendation: "APPROVE",
						evidence: "reviewed",
						commands: [],
						blockers: [],
					},
					executorQa: {
						status: "passed",
						e2eStatus: "passed",
						redTeamStatus: "passed",
						evidence: "tested",
						e2eCommands: ["bun test:e2e"],
						redTeamCommands: ["bun test:red-team"],
						blockers: [],
					},
					iteration: {
						status: "passed",
						evidence: "reran",
						fullRerun: true,
						rerunCommands: ["bun test:e2e"],
						blockers: [],
					},
				}),
			],
			root,
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("architectReview.commands");
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(
			beforeGoals,
		);
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text()).toBe(
			beforeLedger,
		);
	});

	it("rejects complete gates with missing evidence or dirty blockers before mutation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
		const beforeLedger = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text();
		const missingEvidenceGate = JSON.parse(passingQualityGate()) as Record<string, Record<string, unknown>>;
		missingEvidenceGate.architectReview!.evidence = "";
		const dirtyBlockersGate = JSON.parse(passingQualityGate()) as Record<string, Record<string, unknown>>;
		dirtyBlockersGate.executorQa!.blockers = ["regression remains"];
		const missingEvidence = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				JSON.stringify(missingEvidenceGate),
			],
			root,
		);
		const dirtyBlockers = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				JSON.stringify(dirtyBlockersGate),
			],
			root,
		);

		expect(missingEvidence.status).toBe(1);
		expect(missingEvidence.stderr).toContain("architectReview.evidence");
		expect(dirtyBlockers.status).toBe(1);
		expect(dirtyBlockers.stderr).toContain("executorQa.blockers");
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(
			beforeGoals,
		);
		expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text()).toBe(
			beforeLedger,
		);
	});

	it("requires runtime-validated executor QA red-team matrix sections", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const missingMatrix = await mutateLiveQualityGate(root, gate => {
			delete gate.executorQa!.contractCoverage;
		});
		const emptyMatrix = await mutateLiveQualityGate(root, gate => {
			gate.executorQa!.surfaceEvidence = [];
		});

		const missingMatrixError = await expectRejectedCompleteGate(root, created, missingMatrix);
		const emptyMatrixError = await expectRejectedCompleteGate(root, created, emptyMatrix);

		expect(missingMatrixError).toContain("executorQa.contractCoverage");
		expect(emptyMatrixError).toContain("executorQa.surfaceEvidence");
	});

	it("explains that contract coverage descriptions do not replace obligations", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const descriptionOnlyCoverage = await mutateLiveQualityGate(root, gate => {
			const coverage = gate.executorQa!.contractCoverage as Array<Record<string, unknown>>;
			coverage[0]!.description = coverage[0]!.obligation;
			delete coverage[0]!.obligation;
		});

		const coverageError = await expectRejectedCompleteGate(root, created, descriptionOnlyCoverage);

		expect(coverageError).toContain("executorQa.contractCoverage[0].obligation");
		expect(coverageError).toContain("found description");
	});

	it("rejects all-not-applicable contract coverage before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const allNotApplicableCoverage = await mutateLiveQualityGate(root, gate => {
			gate.executorQa!.contractCoverage = [
				{
					id: "contract-goal",
					contractRef: "approved-plan:goal",
					status: "not_applicable",
					reason: "Incorrectly claimed the approved goal contract is not applicable",
				},
			];
		});

		const coverageError = await expectRejectedCompleteGate(root, created, allNotApplicableCoverage);

		expect(coverageError).toContain(
			"executorQa.contractCoverage must include at least one row with status covered, passed, or verified",
		);
	});

	it("rejects missing red-team artifact references before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const missingArtifact = await mutateLiveQualityGate(root, gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.inlineEvidence;
			refs[0]!.path = "artifacts/missing-browser-run.json";
		});

		const artifactError = await expectRejectedCompleteGate(root, created, missingArtifact);

		expect(artifactError).toContain("executorQa.artifactRefs.browser-run");
		expect(artifactError).toContain("automation transcript path must resolve to an existing file");
	});

	it("rejects empty red-team evidence artifacts before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
		await Bun.write(path.join(root, "artifacts", "empty-browser-run.json"), "");
		const emptyArtifact = await mutateLiveQualityGate(root, gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.inlineEvidence;
			refs[0]!.path = "artifacts/empty-browser-run.json";
		});

		const artifactError = await expectRejectedCompleteGate(root, created, emptyArtifact);

		expect(artifactError).toContain("executorQa.artifactRefs.browser-run");
		expect(artifactError).toContain("automation transcript must be valid JSON");
	});

	it("rejects live GUI inlineEvidence-only artifact proof before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const artifactError = await expectRejectedCompleteGate(root, created, passingQualityGate());

		expect(artifactError).toContain("executorQa.artifactRefs.browser-run");
		expect(artifactError).toContain("inlineEvidence and typed verifiedReceipt do not prove live surfaces");
	});

	it("rejects live GUI typed receipt-only artifact proof before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const receiptOnlyGate = await mutateLiveQualityGate(root, gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.inlineEvidence;
			delete refs[0]!.path;
			refs[0]!.verifiedReceipt = { type: "browser-run", id: "receipt-browser-001", status: "verified" };
			delete refs[1]!.path;
		});

		const artifactError = await expectRejectedCompleteGate(root, created, receiptOnlyGate);

		expect(artifactError).toContain("executorQa.artifactRefs.browser-run");
		expect(artifactError).toContain("typed verifiedReceipt do not prove live surfaces");
	});

	it("accepts web surface evidence with valid automation transcript and non-uniform screenshot", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);

		await validateExecutorQaRedTeamEvidenceForReview(root, webExecutorQa());
	});

	it("rejects blank solid and tiny screenshots for web surface evidence", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);

		await expect(
			validateExecutorQaRedTeamEvidenceForReview(
				root,
				webExecutorQa({ "gui-screenshot": { path: "artifacts/blank-screenshot.png" } }),
			),
		).rejects.toThrow(/non-uniform/);
		await expect(
			validateExecutorQaRedTeamEvidenceForReview(
				root,
				webExecutorQa({ "gui-screenshot": { path: "artifacts/tiny-screenshot.png" } }),
			),
		).rejects.toThrow(/320x180/);
		await expect(
			validateExecutorQaRedTeamEvidenceForReview(
				root,
				webExecutorQa({ "gui-screenshot": { path: "artifacts/garbage-screenshot.png" } }),
			),
		).rejects.toThrow(/decodable/);
	});

	it("rejects unsupported or undecodable screenshot formats", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		for (const [file, message] of [
			["artifacts/fake-screenshot.gif", "unsupported/undecodable screenshot format GIF"],
			["artifacts/fake-screenshot.bmp", "unsupported/undecodable screenshot format BMP"],
			["artifacts/fake-screenshot.webp", "unsupported/undecodable screenshot format WebP"],
			["artifacts/fake-screenshot.jpg", "decodable PNG or JPEG"],
		] as const) {
			await expect(
				validateExecutorQaRedTeamEvidenceForReview(root, webExecutorQa({ "gui-screenshot": { path: file } })),
			).rejects.toThrow(message);
		}
	});

	it("rejects invalid automation transcripts with missing timestamps, non-monotonic timestamps, or empty selectors", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const transcriptPath = path.join(root, "artifacts", "browser-run.json");

		const missingTimestamp = validAutomationTranscript();
		delete ((missingTimestamp.actions as Array<Record<string, unknown>>)[1] as Record<string, unknown>).timestamp;
		await Bun.write(transcriptPath, JSON.stringify(missingTimestamp));
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, webExecutorQa())).rejects.toThrow(/timestamp/);

		const nonMonotonic = validAutomationTranscript();
		((nonMonotonic.actions as Array<Record<string, unknown>>)[2] as Record<string, unknown>).timestamp = 999;
		await Bun.write(transcriptPath, JSON.stringify(nonMonotonic));
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, webExecutorQa())).rejects.toThrow(/monotonic/);

		const emptySelector = validAutomationTranscript();
		((emptySelector.actions as Array<Record<string, unknown>>)[1] as Record<string, unknown>).selector = " ";
		await Bun.write(transcriptPath, JSON.stringify(emptySelector));
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, webExecutorQa())).rejects.toThrow(/selector/);
	});

	it("recognizes native desktop and tui surfaces with screenshot, pty, or automation transcript artifacts", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		await Bun.write(
			path.join(root, "artifacts", "native-run.json"),
			JSON.stringify(validAutomationTranscript("native/desktop")),
		);

		await validateExecutorQaRedTeamEvidenceForReview(
			root,
			executorQaWithSurface("native", [
				{
					id: "native-screenshot",
					kind: "screenshot",
					path: "artifacts/gui-screenshot.png",
					description: "Native app screenshot evidence",
				},
			]),
		);
		await validateExecutorQaRedTeamEvidenceForReview(
			root,
			executorQaWithSurface("desktop", [
				{
					id: "desktop-pty",
					kind: "pty-capture",
					path: "artifacts/pty-capture.txt",
					description: "Desktop terminal PTY capture evidence",
				},
			]),
		);
		await validateExecutorQaRedTeamEvidenceForReview(
			root,
			executorQaWithSurface("tui", [
				{
					id: "tui-automation",
					kind: "app-automation-transcript",
					path: "artifacts/native-run.json",
					description: "TUI app automation transcript evidence",
				},
			]),
		);
	});

	it("rejects invalid native pty captures without terminal control codes", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);

		await expect(
			validateExecutorQaRedTeamEvidenceForReview(
				root,
				executorQaWithSurface("tui", [
					{
						id: "plain-pty",
						kind: "pty-capture",
						path: "artifacts/plain-pty.txt",
						description: "Plain terminal log without control sequences",
					},
				]),
			),
		).rejects.toThrow(/terminal control sequences/);
	});

	it("accepts non-live typed receipt or artifact proof but rejects bare inline-only proof", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
		await Bun.write(path.join(root, "artifacts", "api-output.txt"), "api package consumer test output");
		const receiptExecutorQa = JSON.parse(passingQualityGate()).executorQa as Record<string, unknown>;
		receiptExecutorQa.artifactRefs = [
			{
				id: "api-receipt",
				kind: "api-package-test-report",
				description: "API package verified receipt",
				verifiedReceipt: { type: "api-package", id: "receipt-api-001", status: "verified" },
			},
		];
		receiptExecutorQa.surfaceEvidence = [
			{
				id: "surface-api",
				surface: "api/package",
				contractRef: "approved-plan:goal",
				invocation: "Run package consumer verification",
				verdict: "passed",
				artifactRefs: ["api-receipt"],
			},
		];
		receiptExecutorQa.adversarialCases = [
			{
				id: "case-api",
				contractRef: "approved-plan:goal",
				scenario: "Exercise invalid API input",
				expectedBehavior: "The package returns the documented validation error",
				verdict: "passed",
				artifactRefs: ["api-receipt"],
			},
		];
		receiptExecutorQa.contractCoverage = [
			{
				id: "contract-api",
				contractRef: "approved-plan:goal",
				obligation: "The API/package contract is covered",
				status: "covered",
				surfaceEvidenceRefs: ["surface-api"],
				adversarialCaseRefs: ["case-api"],
			},
		];
		await validateExecutorQaRedTeamEvidenceForReview(root, receiptExecutorQa);

		const artifactExecutorQa = JSON.parse(JSON.stringify(receiptExecutorQa)) as Record<string, unknown>;
		artifactExecutorQa.artifactRefs = [
			{
				id: "api-receipt",
				kind: "api-package-test-report",
				description: "API package artifact output",
				path: "artifacts/api-output.txt",
			},
		];
		await validateExecutorQaRedTeamEvidenceForReview(root, artifactExecutorQa);

		const inlineExecutorQa = JSON.parse(JSON.stringify(receiptExecutorQa)) as Record<string, unknown>;
		inlineExecutorQa.artifactRefs = [
			{
				id: "api-receipt",
				kind: "api-package-test-report",
				description: "API package inline-only report",
				inlineEvidence: "API package consumer verification passed with documented behavior and edge cases.",
			},
		];
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, inlineExecutorQa)).rejects.toThrow(
			/inlineEvidence alone is not sufficient/,
		);
	});

	it("accepts live artifact files as proof for completed checkpoints", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const mixedProof = await passingLiveQualityGate(root);

		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			qualityGateJson: mixedProof,
		});

		expect(plan.goals[0]?.status).toBe("complete");
	});

	it("rejects empty or degenerate red-team receipts before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const degenerateReceipt = await mutateLiveQualityGate(root, gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.inlineEvidence;
			delete refs[0]!.path;
			refs[0]!.verifiedReceipt = { status: "verified" };
			delete refs[1]!.path;
		});

		const receiptError = await expectRejectedCompleteGate(root, created, degenerateReceipt);

		expect(receiptError).toContain("executorQa.artifactRefs.browser-run");
		expect(receiptError).toContain("typed verifiedReceipt");
	});

	it("rejects fake or unlinked executor QA red-team evidence before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const missingArtifactMetadata = await mutateLiveQualityGate(root, gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			delete refs[0]!.kind;
		});
		const missingSurfaceArtifact = await mutateLiveQualityGate(root, gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0]!.artifactRefs = ["missing-artifact"];
		});
		const missingCoverageLink = await mutateLiveQualityGate(root, gate => {
			const coverage = gate.executorQa!.contractCoverage as Array<Record<string, unknown>>;
			coverage[0]!.surfaceEvidenceRefs = ["missing-surface"];
		});

		const artifactError = await expectRejectedCompleteGate(root, created, missingArtifactMetadata);
		const surfaceError = await expectRejectedCompleteGate(root, created, missingSurfaceArtifact);
		const coverageError = await expectRejectedCompleteGate(root, created, missingCoverageLink);

		expect(artifactError).toContain("executorQa.artifactRefs[0].kind");
		expect(surfaceError).toContain("executorQa.surfaceEvidence[0].artifactRefs");
		expect(coverageError).toContain("executorQa.contractCoverage[0].surfaceEvidenceRefs");
	});

	it("enforces not-applicable and surface artifact compatibility rules", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const notApplicableWithoutReason = await mutateLiveQualityGate(root, gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0] = {
				id: "surface-gui",
				surface: "gui/web",
				contractRef: "approved-plan:goal",
				status: "not_applicable",
			};
		});
		const adversarialNotApplicable = await mutateLiveQualityGate(root, gate => {
			const cases = gate.executorQa!.adversarialCases as Array<Record<string, unknown>>;
			cases[0]!.status = "not_applicable";
		});
		const guiWithCliOnlyArtifact = await mutateLiveQualityGate(root, gate => {
			const refs = gate.executorQa!.artifactRefs as Array<Record<string, unknown>>;
			refs[0]!.kind = "cli-log";
			refs[1]!.kind = "terminal-transcript";
		});
		const apiWithFailureArtifact = await mutateLiveQualityGate(root, gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0] = {
				id: "surface-api",
				surface: "api/package",
				contractRef: "approved-plan:goal",
				invocation: "Run package consumer verification",
				verdict: "passed",
				artifactRefs: ["adversarial-report"],
			};
		});

		const notApplicableError = await expectRejectedCompleteGate(root, created, notApplicableWithoutReason);
		const adversarialError = await expectRejectedCompleteGate(root, created, adversarialNotApplicable);
		const guiError = await expectRejectedCompleteGate(root, created, guiWithCliOnlyArtifact);
		const apiError = await expectRejectedCompleteGate(root, created, apiWithFailureArtifact);

		expect(notApplicableError).toContain("executorQa.surfaceEvidence[0].reason");
		expect(adversarialError).toContain("executorQa.adversarialCases[0].status");
		expect(guiError).toContain("GUI/web surfaces");
		expect(apiError).toContain("API/package surfaces");
		expect(apiError).toContain("expected at least one artifact kind containing one of");
		expect(apiError).toContain("adversarial-report=failure-mode-test");
	});

	it("rejects failed executor QA matrix row outcomes before mutation", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const failedSurfaceVerdict = await mutateLiveQualityGate(root, gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0]!.verdict = "failed";
		});
		const failedAdversarialResult = await mutateLiveQualityGate(root, gate => {
			const cases = gate.executorQa!.adversarialCases as Array<Record<string, unknown>>;
			delete cases[0]!.verdict;
			cases[0]!.result = "failed";
		});

		const surfaceError = await expectRejectedCompleteGate(root, created, failedSurfaceVerdict);
		const adversarialError = await expectRejectedCompleteGate(root, created, failedAdversarialResult);

		expect(surfaceError).toContain("executorQa.surfaceEvidence[0].status");
		expect(adversarialError).toContain("executorQa.adversarialCases[0].status");
	});

	it("rejects contradictory passed status with failed executor QA outcomes", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const passedStatusFailedSurface = await mutateLiveQualityGate(root, gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0]!.status = "passed";
			surfaceEvidence[0]!.verdict = "failed";
		});
		const passedStatusFailedAdversarial = await mutateLiveQualityGate(root, gate => {
			const cases = gate.executorQa!.adversarialCases as Array<Record<string, unknown>>;
			cases[0]!.status = "passed";
			cases[0]!.result = "failed";
		});

		const surfaceError = await expectRejectedCompleteGate(root, created, passedStatusFailedSurface);
		const adversarialError = await expectRejectedCompleteGate(root, created, passedStatusFailedAdversarial);

		expect(surfaceError).toContain("executorQa.surfaceEvidence[0].status");
		expect(adversarialError).toContain("executorQa.adversarialCases[0].status");
	});

	it("rejects covered contracts linked only to not-applicable surface evidence", async () => {
		const root = await tempDir();
		const created = await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const notApplicableOnlyProof = mutateQualityGate(gate => {
			const surfaceEvidence = gate.executorQa!.surfaceEvidence as Array<Record<string, unknown>>;
			surfaceEvidence[0] = {
				id: "surface-gui",
				contractRef: "approved-plan:goal",
				status: "not_applicable",
				reason: "GUI is not part of this story",
			};
			const coverage = gate.executorQa!.contractCoverage as Array<Record<string, unknown>>;
			delete coverage[0]!.adversarialCaseRefs;
		});

		const coverageError = await expectRejectedCompleteGate(root, created, notApplicableOnlyProof);

		expect(coverageError).toContain("executorQa.contractCoverage[0].surfaceEvidenceRefs.surface-gui.status");
	});

	it("does not require computer-use adversarial cases for prompt-only wording changes", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);

		await validateExecutorQaRedTeamEvidenceForReview(root, webExecutorQa(), {
			mode: "review",
			changeSet: {
				source: "review-worktree",
				trusted: true,
				paths: [
					{
						path: "packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md",
						status: "modified",
					},
				],
			},
		});
	});

	it("requires computer-use adversarial cases for real computer-control surface changes", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);

		await expect(
			validateExecutorQaRedTeamEvidenceForReview(root, webExecutorQa(), {
				mode: "review",
				changeSet: {
					source: "review-worktree",
					trusted: true,
					paths: [
						{
							path: "packages/coding-agent/src/tools/computer.ts",
							status: "modified",
						},
					],
				},
			}),
		).rejects.toThrow(/kill-switch-bypass/);
	});

	it("sources complete checkpoint identity from durable ultragoal state", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--quality-gate-json",
				await passingLiveQualityGate(root),
				"--json",
			],
			root,
		);
		const receipt = JSON.parse(result.stdout ?? "{}");

		expect(result.status).toBe(0);
		expect(receipt.quality_gate_hash).toEqual(expect.any(String));
	});

	it("allows blocked checkpoints without completion quality gates", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"blocked",
				"--evidence",
				"legacy completed GJC goal blocks goal create in this thread",
			],
			root,
		);
		const status = await getUltragoalStatus(root);
		const ledgerRaw = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text();

		expect(result.status).toBe(0);
		expect(status.goals[0]?.status).toBe("blocked");
		expect(ledgerRaw).toContain("legacy completed GJC goal blocks");
	});

	it("unblocks plans after verification blocker stories complete cleanly", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const blockers = await runNativeUltragoalCommand(
			[
				"record-review-blockers",
				"--goal-id",
				"G001",
				"--title",
				"Resolve verification blockers",
				"--objective",
				"Fix architect and executor QA findings.",
				"--evidence",
				"architect found product regression",
			],
			root,
		);
		await startNextUltragoalGoal({ cwd: root });
		const completedBlocker = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "fixed regression and reran full verification",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		const status = await getUltragoalStatus(root);

		expect(blockers.status).toBe(0);
		expect(completedBlocker.goals[0]).toMatchObject({ id: "G001", status: "superseded" });
		expect(completedBlocker.goals[1]).toMatchObject({ id: "G002", status: "complete" });
		expect(status.status).toBe("complete");
		expect(completedBlocker.goals[1]?.completionVerification?.receiptKind).toBe("final-aggregate");
	});

	it("blocks complete checkpoints without the strict architect/executor/iteration quality gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
			}),
		).rejects.toThrow("require --quality-gate-json");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				qualityGateJson: JSON.stringify({
					verification: { status: "passed" },
					codeReview: { recommendation: "APPROVE", architectStatus: "WATCH" },
				}),
			}),
		).rejects.toThrow("legacy codeReview-only gates are not sufficient");

		const status = await getUltragoalStatus(root);
		expect(status.goals[0]?.status).toBe("active");
	});

	it("blocks complete checkpoint commands without the strict quality gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G001", "--status", "complete", "--evidence", "tests passed"],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("require --quality-gate-json");
		expect(status.goals[0]?.status).toBe("active");
	});

	it("rejects mistyped checkpoint statuses instead of silently changing state", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

		const result = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G001", "--status", "complet", "--evidence", "typo"],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("checkpoint --status must be");
		expect(status.goals[0]?.status).toBe("pending");
	});
});

describe("ultragoal @goal decomposition", () => {
	async function goalsFileExists(root: string): Promise<boolean> {
		return await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).exists();
	}

	it("keeps a no-sigil brief as a single goal (backward compatible)", async () => {
		const root = await tempDir();
		const brief = "Ship the native fix\nwith a second line";
		const plan = await createUltragoalPlan({ cwd: root, brief });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]).toMatchObject({ id: "G001", status: "pending" });
		expect(plan.goals[0]?.objective).toBe(brief.trim());
	});

	it("trims a whitespace-padded no-sigil brief", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "\n\n  Only one goal here  \n\n" });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.objective).toBe("Only one goal here");
	});

	it("splits multiple @goal blocks into ordered goals", async () => {
		const root = await tempDir();
		const brief = [
			"@goal: Parse CSVs",
			"Ingest and validate rows.",
			"Reject malformed rows.",
			"",
			"@goal: Normalize records",
			"Map onto the canonical schema.",
			"",
			"@goal: Export report",
			"Emit the audit report.",
		].join("\n");
		const plan = await createUltragoalPlan({ cwd: root, brief });
		expect(plan.goals.map(goal => goal.id)).toEqual(["G001", "G002", "G003"]);
		expect(plan.goals.map(goal => goal.title)).toEqual(["Parse CSVs", "Normalize records", "Export report"]);
		expect(plan.goals[0]?.objective).toBe("Ingest and validate rows.\nReject malformed rows.");
		expect(plan.goals[2]?.objective).toBe("Emit the audit report.");
	});

	it("accepts @goal without a colon", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal First story\nDo the thing.\n\n@goal Second story\nDo the next thing.",
		});
		expect(plan.goals.map(goal => goal.title)).toEqual(["First story", "Second story"]);
	});

	it("treats @goal-adjacent tokens as objective text, not delimiters", async () => {
		const root = await tempDir();
		const brief = [
			"@goal: Real story",
			"@goalish is not a delimiter",
			"@goals: also not one",
			"@goal-foo @goal.foo @goal/foo stay in the body",
		].join("\n");
		const plan = await createUltragoalPlan({ cwd: root, brief });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.title).toBe("Real story");
		expect(plan.goals[0]?.objective).toContain("@goalish is not a delimiter");
		expect(plan.goals[0]?.objective).toContain("@goals: also not one");
		expect(plan.goals[0]?.objective).toContain("@goal-foo @goal.foo @goal/foo stay in the body");
	});

	it("keeps a leading-indented first @goal line as objective text, not a delimiter", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "    @goal: Indented first line\nfollow-up detail" });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.id).toBe("G001");
		expect(plan.goals[0]?.objective).toBe("@goal: Indented first line\nfollow-up detail");
	});

	it("parses @goal:Title with no space after the colon", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal:First\nbody one\n\n@goal:Second\nbody two" });
		expect(plan.goals.map(goal => goal.title)).toEqual(["First", "Second"]);
	});

	it("derives the title from the body for a bare @goal line", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal\nBare delimiter story\nmore detail" });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.title).toBe("Bare delimiter story");
		expect(plan.goals[0]?.objective).toBe("Bare delimiter story\nmore detail");
	});

	it("treats a tab after @goal as a boundary", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal\tTabbed title\nbody" });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.title).toBe("Tabbed title");
	});

	it("does not treat a non-breaking space after @goal as a boundary", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal: Real\n@goal\u00a0NotADelimiter still body" });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.title).toBe("Real");
		expect(plan.goals[0]?.objective).toContain("@goal\u00a0NotADelimiter still body");
	});

	it("keeps an indented @goal line inside the objective", async () => {
		const root = await tempDir();
		const brief = "@goal: Story\nUse a literal like:\n    @goal: not a real delimiter\ndone.";
		const plan = await createUltragoalPlan({ cwd: root, brief });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.objective).toContain("    @goal: not a real delimiter");
	});

	it("keeps a mid-line @goal reference inside the objective", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: Story\nThe sigil is @goal: when at column zero.",
		});
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]?.objective).toBe("The sigil is @goal: when at column zero.");
	});

	it("uses the title as the objective for a title-only block", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal: Just a title" });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]).toMatchObject({ title: "Just a title", objective: "Just a title" });
	});

	it("derives the title from the first body line when the title is empty", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal:\nDerived title line\nmore detail" });
		expect(plan.goals[0]?.title).toBe("Derived title line");
		expect(plan.goals[0]?.objective).toBe("Derived title line\nmore detail");
	});

	it("clamps long titles to 80 characters", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: `@goal: ${"T".repeat(120)}\nbody` });
		const title = plan.goals[0]?.title ?? "";
		expect(title).toHaveLength(80);
		expect(title.endsWith("...")).toBe(true);
	});

	it("rejects an empty @goal block without writing goals.json", async () => {
		const adjacent = await tempDir();
		await expect(createUltragoalPlan({ cwd: adjacent, brief: "@goal:\n@goal: Second\nbody" })).rejects.toThrow(
			"has no title or objective",
		);
		expect(await goalsFileExists(adjacent)).toBe(false);

		const trailing = await tempDir();
		await expect(createUltragoalPlan({ cwd: trailing, brief: "@goal: First\nbody\n@goal:" })).rejects.toThrow(
			"has no title or objective",
		);
		expect(await goalsFileExists(trailing)).toBe(false);
	});

	it("excludes preamble from goals but retains it in the brief", async () => {
		const root = await tempDir();
		const brief = "Global constraints: be fast.\n\n@goal: Only story\nDo the work.";
		const plan = await createUltragoalPlan({ cwd: root, brief });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]).toMatchObject({ title: "Only story", objective: "Do the work." });
		expect(plan.brief).toContain("Global constraints: be fast.");
	});

	it("pluralizes the create-goals summary by goal count", async () => {
		const single = await tempDir();
		const one = await runNativeUltragoalCommand(["create-goals", "--brief", "One story only"], single);
		expect(one.stdout).toContain("with 1 goal at");
		expect(one.stdout).not.toContain("with 1 goals");

		const multi = await tempDir();
		const three = await runNativeUltragoalCommand(
			["create-goals", "--brief", "@goal: A\nfirst\n@goal: B\nsecond\n@goal: C\nthird"],
			multi,
		);
		expect(three.stdout).toContain("with 3 goals at");
	});

	it("reflects a multi-goal plan in the HUD summary", async () => {
		const root = await tempDir();
		await createUltragoalPlan({
			cwd: root,
			brief: "@goal: Parse\nstep one\n@goal: Normalize\nstep two\n@goal: Export\nstep three",
		});
		await startNextUltragoalGoal({ cwd: root });
		const summary = await getUltragoalStatus(root);
		const hud = buildUltragoalHudSummary(summary);
		const serialized = JSON.stringify(hud);
		expect(serialized).toContain("0/3");
		expect(serialized).toContain("G001:Parse");
		expect(summary.status).toBe("active");
	});

	it("reconciles completed runs with mode-state and HUD active-state", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship state reconciliation" });
		await startNextUltragoalGoal({ cwd: root });
		await seedStaleUltragoalWorkflowState(root);

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
				await passingLiveQualityGate(root),
			],
			root,
		);

		expect(checkpoint.status).toBe(0);
		const modeState = await readJsonFile(sessionModeStatePath(root, TEST_SESSION_ID, "ultragoal"));
		expect(modeState.active).toBe(false);
		expect(modeState.current_phase).toBe("complete");
		expect(modeState.status).toBe("complete");
		expect(modeState.counts).toMatchObject({ complete: 1, pending: 0, active: 0 });
		expect(modeState.active_goal_id).toBeUndefined();
		expect(modeState.receipt).toMatchObject({ skill: "ultragoal", owner: "gjc-runtime" });

		const activeState = await readJsonFile(activeSnapshotPath(root, TEST_SESSION_ID));
		expect(activeState.active).toBe(false);
		expect(activeState.active_skills).toEqual([]);
	});

	it("reconciles missing durable plans with stale active mode-state", async () => {
		const root = await tempDir();
		await seedStaleUltragoalWorkflowState(root);
		await seedStaleUltragoalActiveEntry(root);

		const status = await runNativeUltragoalCommand(["status"], root);

		expect(status.status).toBe(0);
		expect(status.stdout).toContain("No ultragoal plan found");
		const modeState = await readJsonFile(sessionModeStatePath(root, TEST_SESSION_ID, "ultragoal"));
		expect(modeState.active).toBe(false);
		expect(modeState.current_phase).toBe("missing");
		expect(modeState.status).toBe("missing");
		expect(modeState.active_goal_id).toBeUndefined();

		const activeState = await readJsonFile(activeSnapshotPath(root, TEST_SESSION_ID));
		expect(activeState.active).toBe(false);
		expect(activeState.active_skills).toEqual([]);
	});

	it("reconciles terminal checkpoints despite corrupt stale mode-state", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship corrupt state reconciliation" });
		await startNextUltragoalGoal({ cwd: root });
		await seedStaleUltragoalActiveEntry(root);
		await fs.mkdir(sessionStateDir(root, TEST_SESSION_ID), { recursive: true });
		await Bun.write(sessionModeStatePath(root, TEST_SESSION_ID, "ultragoal"), "{not-json");

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
				await passingLiveQualityGate(root),
			],
			root,
		);

		expect(checkpoint.status).toBe(0);
		const modeState = await readJsonFile(sessionModeStatePath(root, TEST_SESSION_ID, "ultragoal"));
		expect(modeState.active).toBe(false);
		expect(modeState.current_phase).toBe("complete");
		expect(modeState.status).toBe("complete");
		expect(modeState.counts).toMatchObject({ complete: 1, pending: 0, active: 0 });

		const activeState = await readJsonFile(activeSnapshotPath(root, TEST_SESSION_ID));
		expect(activeState.active).toBe(false);
		expect(activeState.active_skills).toEqual([]);
	});

	it("schedules each @goal story in order through the existing API", async () => {
		const root = await tempDir();
		await createUltragoalPlan({
			cwd: root,
			brief: "@goal: Parse\nstep one\n@goal: Normalize\nstep two\n@goal: Export\nstep three",
		});

		const first = await startNextUltragoalGoal({ cwd: root });
		expect(first.goal?.id).toBe("G001");
		expect(first.goal?.objective).toBe("step one");

		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first story verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		const second = await startNextUltragoalGoal({ cwd: root });
		expect(second.goal?.id).toBe("G002");
		expect(second.goal?.status).toBe("active");
		expect(second.allComplete).toBe(false);

		const status = await getUltragoalStatus(root);
		expect(status.counts.complete).toBe(1);
		expect(status.currentGoal?.id).toBe("G002");
	});

	it("splits CRLF briefs without retaining carriage returns", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: Parse\r\nstep one\r\n\r\n@goal: Normalize\r\nstep two",
		});
		expect(plan.goals.map(goal => goal.title)).toEqual(["Parse", "Normalize"]);
		expect(plan.goals.map(goal => goal.objective)).toEqual(["step one", "step two"]);
		for (const goal of plan.goals) {
			expect(goal.title).not.toContain("\r");
			expect(goal.objective).not.toContain("\r");
		}
	});

	it("trims trailing whitespace on delimiter lines", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal: First   \nbody\n@goal   \nSecond body" });
		expect(plan.goals.map(goal => goal.title)).toEqual(["First", "Second body"]);
		expect(plan.goals.map(goal => goal.objective)).toEqual(["body", "Second body"]);
	});

	it("collapses multiple blank lines between stories", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({
			cwd: root,
			brief: "@goal: First\nfirst body\n\n\n\n@goal: Second\nsecond body",
		});
		expect(plan.goals.map(goal => goal.id)).toEqual(["G001", "G002"]);
		expect(plan.goals[0]?.objective).toBe("first body");
		expect(plan.goals[1]?.objective).toBe("second body");
	});

	it("ignores a single trailing blank line", async () => {
		const root = await tempDir();
		const plan = await createUltragoalPlan({ cwd: root, brief: "@goal: First\nfirst body\n" });
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]).toMatchObject({ title: "First", objective: "first body" });
	});

	it("preserves a very long objective without clamping it", async () => {
		const root = await tempDir();
		const longBody = "x".repeat(5000);
		const plan = await createUltragoalPlan({ cwd: root, brief: `@goal: Long\n${longBody}` });
		expect(plan.goals[0]?.title).toBe("Long");
		expect(plan.goals[0]?.objective).toBe(longBody);
		expect(plan.goals[0]?.objective).toHaveLength(5000);
	});
});

describe("ultragoal mode-state + HUD reconciliation (#342)", () => {
	function modeStatePath(root: string, sessionId = TEST_SESSION_ID): string {
		return sessionModeStatePath(root, sessionId, "ultragoal");
	}

	async function readModeState(root: string, sessionId?: string): Promise<Record<string, unknown>> {
		return JSON.parse(await Bun.file(modeStatePath(root, sessionId)).text());
	}

	async function withSessionId<T>(id: string | undefined, fn: () => Promise<T>): Promise<T> {
		const prev = process.env.GJC_SESSION_ID;
		if (id === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = id;
		try {
			return await fn();
		} finally {
			if (prev === undefined) delete process.env.GJC_SESSION_ID;
			else process.env.GJC_SESSION_ID = prev;
		}
	}

	it("reconciles mode-state + HUD on create-goals (AC1)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			const result = await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix"], root);
			expect(result.status).toBe(0);

			const mode = await readModeState(root);
			expect(mode.skill).toBe("ultragoal");
			expect(mode.current_phase).toBe("pending");
			expect(mode.active).toBe(true);

			const active = await readVisibleSkillActiveState(root);
			const entry = active?.active_skills?.find(e => e.skill === "ultragoal");
			expect(entry?.active).toBe(true);
			expect(entry?.hud?.chips?.some(chip => chip.label === "status" && chip.value === "pending")).toBe(true);
			expect(entry?.hud?.chips?.some(chip => chip.label === "goals")).toBe(true);
		});
	});

	it("writes session-scoped state when GJC_SESSION_ID is set (AC1)", async () => {
		const root = await tempDir();
		const sessionId = "sess.test.342";
		await withSessionId(sessionId, async () => {
			const result = await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix"], root);
			expect(result.status).toBe(0);

			const sessionMode = await readModeState(root, sessionId);
			expect(sessionMode.current_phase).toBe("pending");
			expect(sessionMode.active).toBe(true);

			const sessionActive = await readVisibleSkillActiveState(root, sessionId);
			expect(sessionActive?.active_skills?.some(e => e.skill === "ultragoal")).toBe(true);
		});
	});

	it("fails cleanly instead of crashing when no session id is resolvable", async () => {
		const root = await tempDir();
		await withSessionId(undefined, async () => {
			const result = await runNativeUltragoalCommand(["status"], root);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("a session id is required to write state");
			expect(result.stderr).toContain("GJC_SESSION_ID");
		});
	});

	it("renders help without requiring a resolvable session id", async () => {
		const root = await tempDir();
		await withSessionId(undefined, async () => {
			const result = await runNativeUltragoalCommand(["--help"], root);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("classify-blocker");
		});
	});

	it("stamps reconcile provenance distinguishable from a user write (AC5)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix"], root);
			const mode = await readModeState(root);
			const receipt = mode.receipt as Record<string, unknown>;
			expect(receipt.owner).toBe("gjc-runtime");
			expect(receipt.verb).toBe("reconcile");
			expect(receipt.forced).toBe(true);
			expect(receipt.to_phase).toBe("pending");
			expect(receipt.content_sha256).toBeDefined();
			expect(typeof mode.version).toBe("number");
		});
	});

	it("reconciles to terminal complete/active:false on aggregate completion (AC2)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });
			const result = await runNativeUltragoalCommand(
				[
					"checkpoint",
					"--goal-id",
					"G001",
					"--status",
					"complete",
					"--evidence",
					"tests passed",
					"--quality-gate-json",
					await passingLiveQualityGate(root),
				],
				root,
			);
			expect(result.status).toBe(0);

			const summary = await getUltragoalStatus(root);
			expect(summary.status).toBe("complete");

			const mode = await readModeState(root);
			expect(mode.current_phase).toBe("complete");
			expect(mode.active).toBe(false);

			const active = await readVisibleSkillActiveState(root);
			const stillActive = active?.active_skills?.find(e => e.skill === "ultragoal" && e.active === true);
			expect(stillActive).toBeUndefined();
		});
	});

	it("reconcileWorkflowSkillState bypasses transition-edge validation but keeps phase validation (AC3)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix"], root);
			// Drive the mode-state to "active" via the sanctioned reconciliation path.
			await reconcileWorkflowSkillState({
				cwd: root,
				mode: "ultragoal",
				sessionId: TEST_SESSION_ID,
				active: true,
				phase: "active",
				payload: { skill: "ultragoal", status: "active" },
			});
			// active -> pending has no manifest transition edge; reconciliation must still succeed.
			const res = await reconcileWorkflowSkillState({
				cwd: root,
				mode: "ultragoal",
				sessionId: TEST_SESSION_ID,
				active: true,
				phase: "pending",
				payload: { skill: "ultragoal", status: "pending" },
			});
			const mode = JSON.parse(await Bun.file(res.stateFile).text());
			expect(mode.current_phase).toBe("pending");

			// Schema/unknown-phase validation is still enforced.
			await expect(
				reconcileWorkflowSkillState({
					cwd: root,
					mode: "ultragoal",
					sessionId: TEST_SESSION_ID,
					active: true,
					phase: "goal-execution",
					payload: { skill: "ultragoal" },
				}),
			).rejects.toThrow(/unknown ultragoal phase/);
		});
	});

	it("status repairs stale/missing mode-state without mutating plan/ledger (AC5)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix"], root);
			await fs.rm(modeStatePath(root), { force: true });

			const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
			const beforeLedger = await Bun.file(
				path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl"),
			).text();

			const result = await runNativeUltragoalCommand(["status"], root);
			expect(result.status).toBe(0);

			const mode = await readModeState(root);
			expect(mode.current_phase).toBe("pending");
			expect(mode.active).toBe(true);

			expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(
				beforeGoals,
			);
			expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text()).toBe(
				beforeLedger,
			);
		});
	});

	it("latest ledger event appears in ultragoal HUD after successful reconcile", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the HUD event"], root);
			const result = await runNativeUltragoalCommand(
				[
					"steer",
					"--kind",
					"annotate_ledger",
					"--evidence",
					"operator accepted the durable HUD audit note",
					"--rationale",
					"latest ledger events must be visible in the ultragoal HUD",
				],
				root,
			);

			expect(result.status).toBe(0);
			const active = await readVisibleSkillActiveState(root, TEST_SESSION_ID);
			const entry = active?.active_skills?.find(e => e.skill === "ultragoal");
			expect(JSON.stringify(entry?.hud)).toContain("steering_accepted:annotate_ledger");
		});
	});

	it("derived HUD cache stale-skips an older reconcile source", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await runNativeUltragoalCommand(["create-goals", "--brief", "Ship exact HUD"], root);
			await reconcileWorkflowSkillState({
				cwd: root,
				mode: "ultragoal",
				sessionId: TEST_SESSION_ID,
				active: true,
				phase: "active",
				payload: { skill: "ultragoal", status: "active", latestLedgerEvent: { event: "new_exact_event" } },
			});
			const exactBefore = (await readVisibleSkillActiveState(root, TEST_SESSION_ID))?.active_skills?.find(
				entry => entry.skill === "ultragoal",
			);
			expect(JSON.stringify(exactBefore?.hud)).toContain("new_exact_event");

			await reconcileWorkflowSkillState({
				cwd: root,
				mode: "ultragoal",
				sessionId: TEST_SESSION_ID,
				active: true,
				phase: "active",
				payload: { skill: "ultragoal", status: "active", latestLedgerEvent: { event: "older_sessionless_event" } },
				sourceRevision: 1,
			});

			const exactAfter = (await readVisibleSkillActiveState(root, TEST_SESSION_ID))?.active_skills?.find(
				entry => entry.skill === "ultragoal",
			);
			expect(JSON.stringify(exactAfter?.hud)).toContain("new_exact_event");
			expect(JSON.stringify(exactAfter?.hud)).not.toContain("older_sessionless_event");
		});
	});

	it("keeps the command receipt intact and is diagnosable when reconciliation fails (AC5)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix"], root);
			// Force the reconcile write to fail by replacing the mode-state file with a directory.
			const p = modeStatePath(root);
			await fs.rm(p, { force: true });
			await fs.mkdir(p, { recursive: true });

			const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
			const stderr = captureStderrWrites();
			let result: UltragoalCommandResult | undefined;
			try {
				result = await runNativeUltragoalCommand(["status", "--json"], root);
				expect(stderr.writes.join("")).toContain("ultragoal state reconciliation failed");
			} finally {
				stderr.restore();
			}

			// The triggering command still succeeds with an intact receipt.
			expect(result?.status).toBe(0);
			expect(() => JSON.parse(result?.stdout ?? "")).not.toThrow();

			// The plan is untouched and the failure is recorded in the audit trail.
			expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(
				beforeGoals,
			);
			const ledger = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text();
			expect(ledger).toContain("reconcile_failed");
		});
	});

	it("reconciliation does not alter the command JSON receipt (AC4)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			const result = await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix", "--json"], root);
			// stdout receipt is exactly the create-goals receipt — reconciliation adds nothing.
			expect(JSON.parse(result.stdout ?? "{}")).toEqual({
				ok: true,
				goals_count: 1,
				goal_ids: ["G001"],
				goals_path: path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json"),
			});
			// ...yet the derived mode-state was still reconciled out-of-band.
			const mode = await readModeState(root);
			expect(mode.current_phase).toBe("pending");
		});
	});

	it("surfaces active-state/HUD sync failures during reconciliation (AC5)", async () => {
		const root = await tempDir();
		await withSessionId(TEST_SESSION_ID, async () => {
			await runNativeUltragoalCommand(["create-goals", "--brief", "Ship the fix"], root);
			// Force the active-state/HUD write to fail by replacing skill-active-state.json with a directory.
			const activePath = activeSnapshotPath(root, TEST_SESSION_ID);
			await fs.rm(activePath, { force: true });
			await fs.mkdir(activePath, { recursive: true });

			const beforeGoals = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text();
			const stderr = captureStderrWrites();
			let result: UltragoalCommandResult | undefined;
			try {
				result = await runNativeUltragoalCommand(["status", "--json"], root);
				expect(stderr.writes.join("")).toContain("ultragoal state reconciliation failed");
			} finally {
				stderr.restore();
			}

			// Command still succeeds; the HUD-sync failure is diagnosable via the audit trail.
			expect(result?.status).toBe(0);
			expect(await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")).text()).toBe(
				beforeGoals,
			);
			const ledger = await Bun.file(path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")).text();
			expect(ledger).toContain("reconcile_failed");
		});
	});
});

describe("resolveGitBase nearest integration base", () => {
	async function git(cwd: string, args: string[]): Promise<void> {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "T",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "T",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		if (proc.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
		}
	}

	async function commit(cwd: string, file: string, message: string): Promise<void> {
		await fs.writeFile(path.join(cwd, file), `${message}\n`);
		await git(cwd, ["add", "."]);
		await git(cwd, ["commit", "-m", message]);
	}

	it("scopes a dev-forked branch to dev, not a stale main", async () => {
		const dir = await tempDir();
		await git(dir, ["init", "-q"]);
		await git(dir, ["checkout", "-q", "-b", "main"]);
		await commit(dir, "base.txt", "base");
		await git(dir, ["checkout", "-q", "-b", "dev"]);
		await commit(dir, "dev.txt", "dev work");
		await git(dir, ["checkout", "-q", "-b", "feature/x"]);
		await commit(dir, "feature.txt", "feature work");

		// dev is the nearest base (1 commit ahead) vs main (2 commits ahead).
		expect(await resolveGitBase(dir)).toBe("dev");
	});

	it("honors an explicit branch argument", async () => {
		const dir = await tempDir();
		await git(dir, ["init", "-q"]);
		await git(dir, ["checkout", "-q", "-b", "main"]);
		await commit(dir, "base.txt", "base");
		await git(dir, ["checkout", "-q", "-b", "feature/y"]);
		await commit(dir, "feature.txt", "feature work");

		expect(await resolveGitBase(dir, "main")).toBe("main");
	});
});
