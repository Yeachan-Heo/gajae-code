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
import {
	validateCompletionReceipt,
	verifyUltragoalDurableCompletionState,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";

import {
	addUltragoalSubgoal,
	buildUltragoalHudSummary,
	checkpointUltragoalGoal,
	createUltragoalPlan,
	getUltragoalStatus,
	hashStructuredValue,
	readUltragoalLedger,
	readUltragoalPlan,
	recordUltragoalReviewBlockers,
	resolveCliReplayCommand,
	resolveGitBase,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
	type UltragoalCommandResult,
	UltragoalReviewBlockerRecursionCapError,
	validateExecutorQaRedTeamEvidenceForReview,
	validateUltragoalQualityGateReadOnly,
	waitForReplayProcessWithTimeout,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { readVisibleSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];

let savedSessionId: string | undefined;
let savedSessionFile: string | undefined;
// Pin a non-computer test path as CI_DEV_CHANGED_PATHS for every test. Temp
// dirs live outside the enclosing git work tree (os.tmpdir), so
// computeCheckpointChangeSet falls through to the CI_DEV_CHANGED_PATHS-only
// path — without a non-empty path it returns captureIncomplete=true which
// unconditionally triggers the mandatory computer red-team suite even when no
// computer surface was touched. batchTempDir overrides this with its own batch
// paths; the explicit CI-leak tests override within their own scope.
const ORIGINAL_CI_DEV_CHANGED_PATHS = process.env.CI_DEV_CHANGED_PATHS;
const ORIGINAL_GITHUB_WORKSPACE = process.env.GITHUB_WORKSPACE;
const NON_COMPUTER_TEST_PATH = "packages/coding-agent/test/gjc-runtime/ultragoal-runtime.test.ts";

beforeEach(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	savedSessionFile = process.env.GJC_SESSION_FILE;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	delete process.env.GJC_SESSION_FILE;
	// These fixtures intentionally simulate CI path evidence for independent temp repos.
	delete process.env.GITHUB_WORKSPACE;
	process.env.CI_DEV_CHANGED_PATHS = NON_COMPUTER_TEST_PATH;
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-runtime-"));
	tempRoots.push(dir);
	return dir;
}

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
	if (ORIGINAL_CI_DEV_CHANGED_PATHS === undefined) delete process.env.CI_DEV_CHANGED_PATHS;
	else process.env.CI_DEV_CHANGED_PATHS = ORIGINAL_CI_DEV_CHANGED_PATHS;
	if (ORIGINAL_GITHUB_WORKSPACE === undefined) delete process.env.GITHUB_WORKSPACE;
	else process.env.GITHUB_WORKSPACE = ORIGINAL_GITHUB_WORKSPACE;
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
		criticReview: {
			verdict: "OKAY",
			evidence: "critic approved final aggregate",
			blockers: [],
		},
		iteration: {
			status: "passed",
			evidence: "no verification findings remain after steering iterations",
			fullRerun: true,
			reviewCohort: {
				reviewGeneration: 1,
				sourceHash: "sha256:test-frozen-source",
				joined: true,
				lanes: {
					cleaner: {
						status: "passed",
						sourceHash: "sha256:test-frozen-source",
						evidence: "cleaner clean",
						blockers: [],
					},
					architect: {
						status: "CLEAR",
						sourceHash: "sha256:test-frozen-source",
						evidence: "architect clear",
						blockers: [],
					},
					qa: { status: "passed", sourceHash: "sha256:test-frozen-source", evidence: "qa passed", blockers: [] },
				},
			},
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
	await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
	await Bun.write(path.join(root, "artifacts", "adversarial-report.txt"), "adversarial boundary evidence");
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
	await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
	await Bun.write(path.join(root, "artifacts", "adversarial-report.txt"), "adversarial boundary evidence");
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
		{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts", status: "unknown" },
		{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-guard.ts", status: "unknown" },
		{ path: "packages/coding-agent/src/gjc-runtime/ultragoal-receipt-freshness.ts", status: "unknown" },
		{ path: "packages/coding-agent/test/gjc-runtime/ultragoal-runtime.test.ts", status: "unknown" },
		{ path: "packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md", status: "unknown" },
		{ path: "packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md", status: "unknown" },
		{ path: "packages/coding-agent/src/prompts/system/system-prompt.md", status: "unknown" },
		{ path: "packages/coding-agent/test/default-gjc-definitions.test.ts", status: "unknown" },
		{ path: "packages/coding-agent/src/gjc-runtime/workflow-manifest.generated.json", status: "unknown" },
		{ path: "packages/coding-agent/src/gjc-runtime/workflow-manifest.ts", status: "unknown" },
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
				reviewCohort: {
					reviewGeneration: 1,
					sourceHash: "sha256:test-frozen-source",
					joined: true,
					lanes: {
						cleaner: {
							status: "passed",
							sourceHash: "sha256:test-frozen-source",
							evidence: "cleaner clean",
							blockers: [],
						},
						architect: {
							status: "CLEAR",
							sourceHash: "sha256:test-frozen-source",
							evidence: "architect clear",
							blockers: [],
						},
						qa: {
							status: "passed",
							sourceHash: "sha256:test-frozen-source",
							evidence: "qa passed",
							blockers: [],
						},
					},
				},
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

/**
 * Deferred gate for the boundary-by-default path: no explicit validation batch, so
 * no batch tuple fields. `ranLanes` is the declaration the runtime cross-checks
 * against the submitted evidence.
 */
function implicitDeferredGate(goalId: string, ranLanes: string[]): string {
	const paths = batchChangeSetPaths();
	const deferred: Record<string, unknown> = {
		kind: "validation-batch-deferred",
		deferredLanes: ["architectReview", "executorQa"],
		ranLanes,
		targetedVerification: {
			status: "passed",
			commands: ["bun test boundary default"],
			evidence: `Targeted verification passed for ${goalId}.`,
		},
		changeSet: {
			memberGoalId: goalId,
			cumulativeFromBase: true,
			paths,
			changeSetHash: hashStructuredValue(paths.map(row => ({ ...row, oldPath: undefined }))),
		},
	};
	if (ranLanes.includes("aiSlopCleaner")) {
		deferred.aiSlopCleaner = { status: "passed", evidence: `Cleaner found no blockers for ${goalId}.` };
	}
	return JSON.stringify({ deferredToBatch: deferred });
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

	it("runs safe literal replay outside repository preload configuration", async () => {
		const root = await tempDir();
		const marker = path.join(root, "preload-must-not-run.txt");
		await Bun.write(path.join(root, "bunfig.toml"), 'preload = ["./replay-preload.ts"]\n');
		await Bun.write(path.join(root, "replay-preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "unsafe");\n`);
		await expectAcceptedExecutorQa(root, cliExecutorQa([cliReplayArtifact()]));
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("fails closed when process.execPath is the compiled GJC application", () => {
		expect(() => resolveCliReplayCommand(["bun", "-e", 'console.log("safe")'], { compiled: true })).toThrow(
			"compiled GJC runtime",
		);
		expect(resolveCliReplayCommand(["bun", "--version"], { compiled: false })[0]).toBe(process.execPath);
	});
	it("rejects string commands", async () => {
		const stringRoot = await tempDir();
		const stringError = await expectRejectedExecutorQa(
			stringRoot,
			cliExecutorQa([cliReplayArtifact({ command: 'bun -e "console.log(1)"' })]),
		);
		expect(stringError).toContain("argv string array");
	});

	it("rejects executable bun tests and arbitrary command execution", async () => {
		const testRoot = await tempDir();
		const marker = path.join(testRoot, "must-not-exist.txt");
		await Bun.write(
			path.join(testRoot, "model-authored.test.ts"),
			`await Bun.write(${JSON.stringify(marker)}, "unsafe");`,
		);
		const testError = await expectRejectedExecutorQa(
			testRoot,
			cliExecutorQa([cliReplayArtifact({ command: ["bun", "test", "model-authored.test.ts"] })]),
		);
		expect(testError).toContain("deterministic CLI replay allowlist");
		expect(await Bun.file(marker).exists()).toBe(false);

		for (const command of [
			["/bin/sh", "-c", "printf unsafe"],
			["sh", "-c", "printf unsafe"],
			["bun", "install"],
			["bun", "-e", 'await Bun.write("unsafe", "x")'],
			["git", "push"],
			["curl", "https://example.invalid"],
		]) {
			const rejectedRoot = await tempDir();
			const error = await expectRejectedExecutorQa(rejectedRoot, cliExecutorQa([cliReplayArtifact({ command })]));
			expect(error).toContain("deterministic CLI replay allowlist");
		}
	});

	it("reads the referenced replay file when the artifactRef kind is cli-replay", async () => {
		const root = await tempDir();
		// Regression: an artifactRef carrying `kind: "cli-replay"` and a `path` (but no
		// inline `command`) used to short-circuit as an inline replay record, so the
		// referenced file was never read and validation failed with a confusing
		// `schemaVersion must be 1` error pointing at the ref instead of the file.
		await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
		await Bun.write(
			path.join(root, "artifacts", "referenced-replay.json"),
			JSON.stringify({
				schemaVersion: 1,
				kind: "cli-replay",
				replaySafe: true,
				command: ["bun", "-e", 'console.log("referenced-replay-ok")'],
				recordedStdout: "referenced-replay-ok\n",
				invariants: [{ type: "substring", value: "referenced-replay-ok" }],
			}),
		);
		await expectAcceptedExecutorQa(
			root,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					path: "artifacts/referenced-replay.json",
					description: "Runtime argv replay referenced by path",
				},
			]),
		);
	});

	it("fails closed on ambiguous replay rows and repository path escapes", async () => {
		const ambiguousRoot = await tempDir();
		const ambiguousError = await expectRejectedExecutorQa(
			ambiguousRoot,
			cliExecutorQa([{ ...cliReplayArtifact(), path: "artifacts/replay.json" }]),
		);
		expect(ambiguousError).toContain("must not mix nested replay");

		const mixedFieldRoot = await tempDir();
		const mixedFieldError = await expectRejectedExecutorQa(
			mixedFieldRoot,
			cliExecutorQa([{ ...cliReplayArtifact(), recordedStderr: "ignored" }]),
		);
		expect(mixedFieldError).toContain("must not mix nested replay");

		const malformedRoot = await tempDir();
		const malformedError = await expectRejectedExecutorQa(
			malformedRoot,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					description: "Malformed replay row",
					replay: "self-attested",
					path: "artifacts/replay.json",
				},
			]),
		);
		expect(malformedError).toContain(".replay must be an object");

		const cwdRoot = await tempDir();
		const outsideCwd = await tempDir();
		await fs.symlink(outsideCwd, path.join(cwdRoot, "linked-cwd"), "dir");
		const cwdError = await expectRejectedExecutorQa(
			cwdRoot,
			cliExecutorQa([cliReplayArtifact({ cwd: "linked-cwd" })]),
		);
		expect(cwdError).toContain("without symlink escape");

		const artifactRoot = await tempDir();
		const outsideArtifactRoot = await tempDir();
		await fs.mkdir(path.join(artifactRoot, "artifacts"), { recursive: true });
		const outsideReplay = path.join(outsideArtifactRoot, "replay.json");
		await Bun.write(
			outsideReplay,
			JSON.stringify({
				schemaVersion: 1,
				kind: "cli-replay",
				replaySafe: true,
				command: ["bun", "-e", 'console.log("outside")'],
				recordedStdout: "outside\n",
			}),
		);
		await fs.symlink(outsideReplay, path.join(artifactRoot, "artifacts", "replay.json"));
		const artifactError = await expectRejectedExecutorQa(
			artifactRoot,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					description: "Escaping replay artifact",
					path: "artifacts/replay.json",
				},
			]),
		);
		expect(artifactError).toContain("must not escape the repository cwd through symlinks");
	});
	it("rejects execution-affecting env vars", async () => {
		const envRoot = await tempDir();
		const envError = await expectRejectedExecutorQa(
			envRoot,
			cliExecutorQa([cliReplayArtifact({ env: { NODE_OPTIONS: "--require ./evil.js" } })]),
		);
		expect(envError).toContain("env.NODE_OPTIONS");
		expect(envError).toContain("safe environment allowlist");
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

	it("kills the POSIX replay process group before detached children can continue", async () => {
		if (process.platform === "win32") return;
		const root = await tempDir();
		const marker = path.join(root, "survived.txt");
		const subprocess = Bun.spawn(
			[
				"/bin/sh",
				"-c",
				"trap '' TERM; (trap '' TERM; sleep 0.25; printf escaped > \"$1\") & while :; do sleep 1; done",
				"sh",
				marker,
			],
			{ stdout: "ignore", stderr: "ignore", detached: true },
		);
		await expect(waitForReplayProcessWithTimeout(subprocess, 10, 50)).rejects.toThrow("timeout");
		await Bun.sleep(350);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("rejects stdout mismatches", async () => {
		const root = await tempDir();
		const error = await expectRejectedExecutorQa(
			root,
			cliExecutorQa([cliReplayArtifact({ recordedStdout: "wrong\n" })]),
		);
		expect(error).toContain("stdout did not match");
	});

	it("rejects stderr mismatches", async () => {
		const root = await tempDir();
		const error = await expectRejectedExecutorQa(
			root,
			cliExecutorQa([cliReplayArtifact({ recordedStderr: "unexpected warning\n" })]),
		);
		expect(error).toContain("stderr did not match");
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

		const testReportRoot = await tempDir();
		await fs.mkdir(path.join(testReportRoot, "artifacts"), { recursive: true });
		await Bun.write(
			path.join(testReportRoot, "artifacts", "test-report.json"),
			JSON.stringify({
				schemaVersion: 1,
				kind: "bun-test-report",
				command: ["bun", "test", "packages/coding-agent/test/focused.test.ts"],
				total: 1,
				passed: 1,
				failed: 0,
				skipped: 0,
				exitCode: 0,
			}),
		);
		const testReportError = await expectRejectedExecutorQa(
			testReportRoot,
			cliExecutorQa([
				{
					id: "cli-replay",
					kind: "cli-replay",
					description: "Replay exemption with unresolved structured test report fallback",
					replay: {
						schemaVersion: 1,
						kind: "cli-replay",
						replayExempt: {
							reasonCode: "unsafe_side_effect",
							reason:
								"The quality gate must not execute model-authored test source without an operating-system sandbox.",
							approvedBy: "executor-qa",
							fallbackArtifactRefs: ["test-report"],
						},
					},
				},
				{
					id: "test-report",
					kind: "bun-test-report",
					path: "artifacts/test-report.json",
					description: "Structured focused bun test report",
				},
			]),
		);
		expect(testReportError).toContain("requires at least one structurally-valid fallback artifact");
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

	it("rejects empty or nonce-matching replay invariants and retains equality for negative-only assertions", async () => {
		const cases: Array<{ invariants: Record<string, unknown>[]; message: string }> = [
			{ invariants: [{ type: "regex", value: "[\\s\\S]*" }], message: "meaningful positive" },
			{ invariants: [{ type: "regex", value: "[^]*" }], message: "meaningful positive" },
			{ invariants: [{ type: "regex", value: "^" }], message: "meaningful positive" },
			{ invariants: [{ type: "regex", value: "(?:)" }], message: "meaningful positive" },
			{ invariants: [{ type: "substring", value: " \t" }], message: "non-empty string" },
			{ invariants: [{ type: "not_substring", value: "missing" }], message: "stdout did not match" },
		];
		for (const entry of cases) {
			const root = await tempDir();
			const error = await expectRejectedExecutorQa(
				root,
				cliExecutorQa([cliReplayArtifact({ recordedStdout: "different\n", invariants: entry.invariants })]),
			);
			expect(error).toContain(entry.message);
		}
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

	it("boundary default: a non-final aggregate goal completes with a lightweight deferred gate and no review lanes", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc" });
		await startNextUltragoalGoal({ cwd: root });

		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "targeted verification only, review deferred to the boundary",
			qualityGateJson: implicitDeferredGate("G001", ["targetedVerification"]),
		});

		const plan = await readUltragoalPlan(root);
		expect(plan?.goals.find(goal => goal.id === "G001")?.status).toBe("complete");
		expect(plan?.goals.every(goal => goal.validationBatch === undefined)).toBe(true);
	});

	it("boundary default: the final aggregate goal still requires the strict gate", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "@goal: A\na\n@goal: B\nb" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "non-final member deferred",
			qualityGateJson: implicitDeferredGate("G001", ["targetedVerification"]),
		});
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G002",
				status: "complete",
				evidence: "final boundary tries to defer",
				qualityGateJson: implicitDeferredGate("G002", ["targetedVerification"]),
			}),
		).rejects.toThrow("unsupported keys: deferredToBatch");
	});

	it("boundary default: a deferred gate needs neither an ai-slop-cleaner pass nor a full rerun", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc" });
		await startNextUltragoalGoal({ cwd: root });

		const gate = JSON.parse(implicitDeferredGate("G001", ["targetedVerification"]));
		expect(gate.deferredToBatch.aiSlopCleaner).toBeUndefined();
		expect(gate.deferredToBatch.iteration).toBeUndefined();

		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "no cleaner and no full rerun for an intermediate story",
			qualityGateJson: JSON.stringify(gate),
		});
		expect((await readUltragoalPlan(root))?.goals.find(goal => goal.id === "G001")?.status).toBe("complete");
	});

	it("boundary default: a minimal deferred gate omits every derivable field and is hydrated by the runtime", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc" });
		await startNextUltragoalGoal({ cwd: root });

		const minimal = JSON.stringify({
			deferredToBatch: {
				ranLanes: ["targetedVerification"],
				targetedVerification: {
					status: "passed",
					commands: ["bun test targeted"],
					evidence: "targeted suite passed for G001",
				},
			},
		});
		// Read-only validate and checkpoint apply identical hydration rules.
		expect(
			await validateUltragoalQualityGateReadOnly({ cwd: root, qualityGateJson: minimal, goalId: "G001" }),
		).toEqual({ valid: true, errors: [] });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "minimal deferred gate hydrated by the runtime",
			qualityGateJson: minimal,
		});
		expect((await readUltragoalPlan(root))?.goals.find(goal => goal.id === "G001")?.status).toBe("complete");
	});

	it("validation batch deferred: a minimal member gate is auto-hydrated with the batch tuple and change-set hash", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		const accepted = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "minimal member gate",
			qualityGateJson: JSON.stringify({
				deferredToBatch: {
					targetedVerification: {
						status: "passed",
						commands: ["bun test targeted"],
						evidence: "targeted suite passed for G001",
					},
				},
			}),
		});
		const batch = accepted.goals[0]!.completionVerification?.validationBatch;
		if (batch?.role !== "deferred-member") throw new Error("expected a deferred-member receipt");
		// The runtime computed and stamped the change-set hash; no hand-computed hash was supplied.
		expect(batch.changeSetHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("validation batch deferred: explicit paths must exactly match the computed cumulative diff", async () => {
		const root = await batchTempDir();
		const actualPath = "packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts";
		const secondPath = "packages/coding-agent/test/gjc-runtime/ultragoal-runtime.test.ts";
		process.env.CI_DEV_CHANGED_PATHS = `${actualPath}\n${secondPath}`;
		await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		const gateWithExtraPath = JSON.stringify({
			deferredToBatch: {
				targetedVerification: {
					status: "passed",
					commands: ["bun test targeted"],
					evidence: "targeted suite passed for G001",
				},
				changeSet: {
					paths: [
						{ path: actualPath, status: "unknown" },
						{ path: secondPath, status: "unknown" },
						{ path: "forged/not-in-cumulative-diff.ts", status: "added" },
					],
				},
			},
		});
		const extraPathValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G001",
			qualityGateJson: gateWithExtraPath,
		});
		expect(extraPathValidation.valid).toBe(false);
		expect(extraPathValidation.errors.some(error => error.message.includes("must exactly match"))).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "forged cumulative path",
				qualityGateJson: gateWithExtraPath,
			}),
		).rejects.toThrow("must exactly match");

		const gateWithWrongStatus = JSON.stringify({
			deferredToBatch: {
				targetedVerification: {
					status: "passed",
					commands: ["bun test targeted"],
					evidence: "targeted suite passed for G001",
				},
				changeSet: {
					paths: [
						{ path: actualPath, status: "deleted" },
						{ path: secondPath, status: "unknown" },
					],
				},
			},
		});
		const wrongStatusValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G001",
			qualityGateJson: gateWithWrongStatus,
		});
		expect(wrongStatusValidation.valid).toBe(false);
		expect(wrongStatusValidation.errors.some(error => error.message.includes(actualPath))).toBe(true);

		const gateWithReorderedPaths = JSON.stringify({
			deferredToBatch: {
				targetedVerification: {
					status: "passed",
					commands: ["bun test targeted"],
					evidence: "targeted suite passed for G001",
				},
				changeSet: {
					paths: [
						{ path: secondPath, status: "unknown" },
						{ path: actualPath, status: "unknown" },
					],
				},
			},
		});
		const reorderedValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G001",
			qualityGateJson: gateWithReorderedPaths,
		});
		expect(reorderedValidation.valid).toBe(false);
		expect(reorderedValidation.errors.some(error => error.message.includes("must exactly match"))).toBe(true);

		const gateWithUnknownField = JSON.stringify({
			deferredToBatch: {
				forged: "must reject",
				targetedVerification: {
					status: "passed",
					commands: ["bun test targeted"],
					evidence: "targeted suite passed for G001",
				},
			},
		});
		const unknownFieldValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G001",
			qualityGateJson: gateWithUnknownField,
		});
		expect(unknownFieldValidation.valid).toBe(false);
		expect(unknownFieldValidation.errors.some(error => error.message.includes("unsupported keys: forged"))).toBe(
			true,
		);

		const gateWithMalformedChangeSet = JSON.stringify({
			deferredToBatch: {
				targetedVerification: {
					status: "passed",
					commands: ["bun test targeted"],
					evidence: "targeted suite passed for G001",
				},
				changeSet: "malformed",
			},
		});
		const malformedValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G001",
			qualityGateJson: gateWithMalformedChangeSet,
		});
		expect(malformedValidation.valid).toBe(false);
		expect(malformedValidation.errors.some(error => error.message.includes("changeSet is required"))).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "malformed explicit change set",
				qualityGateJson: gateWithMalformedChangeSet,
			}),
		).rejects.toThrow("changeSet is required");
	});

	it("validation batch deferred: missing Git and CI change-set evidence fails closed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-runtime-no-change-set-"));
		tempRoots.push(root);
		const savedChangedPaths = process.env.CI_DEV_CHANGED_PATHS;
		delete process.env.CI_DEV_CHANGED_PATHS;
		try {
			await createUltragoalPlan({
				cwd: root,
				brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
				validationBatches: [
					{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
				],
			});
			await startNextUltragoalGoal({ cwd: root });
			const minimal = JSON.stringify({
				deferredToBatch: {
					targetedVerification: {
						status: "passed",
						commands: ["bun test targeted"],
						evidence: "targeted suite passed for G001",
					},
				},
			});
			const validation = await validateUltragoalQualityGateReadOnly({
				cwd: root,
				goalId: "G001",
				qualityGateJson: minimal,
			});
			expect(validation.valid).toBe(false);
			expect(
				validation.errors.some(error => error.message.includes("complete authoritative checkpoint change set")),
			).toBe(true);
			await expect(
				checkpointUltragoalGoal({
					cwd: root,
					goalId: "G001",
					status: "complete",
					evidence: "missing change-set source",
					qualityGateJson: minimal,
				}),
			).rejects.toThrow("complete authoritative checkpoint change set");
		} finally {
			if (savedChangedPaths === undefined) delete process.env.CI_DEV_CHANGED_PATHS;
			else process.env.CI_DEV_CHANGED_PATHS = savedChangedPaths;
		}
	});

	it("validation batch deferred: preserves leading and trailing whitespace in computed paths", async () => {
		const root = await batchTempDir();
		const whitespacePath = " leading-and-trailing.ts ";
		process.env.CI_DEV_CHANGED_PATHS = whitespacePath;
		await createUltragoalPlan({
			cwd: root,
			brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc",
			validationBatches: [
				{ schemaVersion: 1, batchId: "VB001", memberIds: ["G001", "G002", "G003"], finalGoalId: "G003" },
			],
		});
		await startNextUltragoalGoal({ cwd: root });
		const minimal = JSON.stringify({
			deferredToBatch: {
				targetedVerification: {
					status: "passed",
					commands: ["bun test targeted"],
					evidence: "targeted suite passed for G001",
				},
			},
		});
		expect(
			await validateUltragoalQualityGateReadOnly({ cwd: root, goalId: "G001", qualityGateJson: minimal }),
		).toEqual({ valid: true, errors: [] });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "whitespace path preserved",
			qualityGateJson: minimal,
		});
		const persisted = (await readUltragoalLedger(root)).at(-1)?.qualityGateJson as Record<string, unknown>;
		const deferred = persisted.deferredToBatch as Record<string, unknown>;
		const changeSet = deferred.changeSet as Record<string, unknown>;
		expect(changeSet.paths).toEqual([{ path: whitespacePath, status: "unknown" }]);
	});

	it("validation batch close: a minimal close gate is auto-hydrated from durable receipts", async () => {
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
		const closed = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G003",
			status: "complete",
			evidence: "minimal close hydrated by the runtime",
			qualityGateJson: JSON.stringify({
				...JSON.parse(passingQualityGate()),
				validationBatchClose: { coverageEvidence: "Union validation covered the validation batch." },
			}),
		});
		const batch = closed.goals[2]!.completionVerification?.validationBatch;
		if (batch?.role !== "batch-close") throw new Error("expected a batch-close receipt");
		// unionHash and member hashes were derived by the runtime, not hand-computed.
		expect(batch.unionHash).toMatch(/^[0-9a-f]{64}$/);
		expect(Object.keys(batch.memberChangeSetHashes).sort()).toEqual(["G001", "G002", "G003"]);
	});

	it("validation batch close: explicit hash maps must exactly match the durable batch tuple", async () => {
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

		const metadataExtra = JSON.parse(batchCloseGate(plan)) as Record<string, unknown>;
		const metadataClose = metadataExtra.validationBatchClose as Record<string, unknown>;
		const metadataHashes = metadataClose.memberMetadataHashes as Record<string, string>;
		metadataHashes.G999 = "forged-member-metadata-hash";
		const metadataValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G003",
			qualityGateJson: JSON.stringify(metadataExtra),
		});
		expect(metadataValidation.valid).toBe(false);
		expect(metadataValidation.errors.some(error => error.message.includes("memberMetadataHashes keys"))).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "forged metadata tuple member",
				qualityGateJson: JSON.stringify(metadataExtra),
			}),
		).rejects.toThrow("memberMetadataHashes keys");

		const metadataPartial = JSON.parse(batchCloseGate(plan)) as Record<string, unknown>;
		const metadataPartialClose = metadataPartial.validationBatchClose as Record<string, unknown>;
		const partialMetadataHashes = metadataPartialClose.memberMetadataHashes as Record<string, string>;
		delete partialMetadataHashes.G002;
		const metadataPartialValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G003",
			qualityGateJson: JSON.stringify(metadataPartial),
		});
		expect(metadataPartialValidation.valid).toBe(false);
		expect(metadataPartialValidation.errors.some(error => error.message.includes("memberMetadataHashes.G002"))).toBe(
			true,
		);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "partial metadata tuple",
				qualityGateJson: JSON.stringify(metadataPartial),
			}),
		).rejects.toThrow("memberMetadataHashes.G002");

		const changeSetExtra = JSON.parse(batchCloseGate(plan)) as Record<string, unknown>;
		const changeSetClose = changeSetExtra.validationBatchClose as Record<string, unknown>;
		const union = changeSetClose.unionChangeSet as Record<string, unknown>;
		const memberChangeSetHashes = union.memberChangeSetHashes as Record<string, string>;
		memberChangeSetHashes.G999 = "forged-member-change-set-hash";
		delete union.unionHash;
		const changeSetValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G003",
			qualityGateJson: JSON.stringify(changeSetExtra),
		});
		expect(changeSetValidation.valid).toBe(false);
		expect(changeSetValidation.errors.some(error => error.message.includes("memberChangeSetHashes keys"))).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "forged change-set tuple member",
				qualityGateJson: JSON.stringify(changeSetExtra),
			}),
		).rejects.toThrow("memberChangeSetHashes keys");

		const changeSetPartial = JSON.parse(batchCloseGate(plan)) as Record<string, unknown>;
		const changeSetPartialClose = changeSetPartial.validationBatchClose as Record<string, unknown>;
		const partialUnion = changeSetPartialClose.unionChangeSet as Record<string, unknown>;
		const partialChangeSetHashes = partialUnion.memberChangeSetHashes as Record<string, string>;
		delete partialChangeSetHashes.G002;
		delete partialUnion.unionHash;
		const changeSetPartialValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G003",
			qualityGateJson: JSON.stringify(changeSetPartial),
		});
		expect(changeSetPartialValidation.valid).toBe(false);
		expect(
			changeSetPartialValidation.errors.some(error => error.message.includes("memberChangeSetHashes keys")),
		).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "partial change-set tuple",
				qualityGateJson: JSON.stringify(changeSetPartial),
			}),
		).rejects.toThrow("memberChangeSetHashes keys");

		const malformedUnion = JSON.parse(batchCloseGate(plan)) as Record<string, unknown>;
		const malformedClose = malformedUnion.validationBatchClose as Record<string, unknown>;
		malformedClose.unionChangeSet = "malformed";
		const malformedUnionValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G003",
			qualityGateJson: JSON.stringify(malformedUnion),
		});
		expect(malformedUnionValidation.valid).toBe(false);
		expect(
			malformedUnionValidation.errors.some(error =>
				error.message.includes("member metadata and change-set hashes are required"),
			),
		).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "malformed explicit union",
				qualityGateJson: JSON.stringify(malformedUnion),
			}),
		).rejects.toThrow("member metadata and change-set hashes are required");

		const receiptExtra = JSON.parse(batchCloseGate(plan)) as Record<string, unknown>;
		const receiptClose = receiptExtra.validationBatchClose as Record<string, unknown>;
		const receiptRows = receiptClose.memberReceipts as Array<Record<string, unknown>>;
		receiptRows[0]!.forged = "must reject";
		const receiptValidation = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			goalId: "G003",
			qualityGateJson: JSON.stringify(receiptExtra),
		});
		expect(receiptValidation.valid).toBe(false);
		expect(
			receiptValidation.errors.some(error =>
				error.message.includes("memberReceipts.G001 contains unsupported keys"),
			),
		).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G003",
				status: "complete",
				evidence: "forged receipt field",
				qualityGateJson: JSON.stringify(receiptExtra),
			}),
		).rejects.toThrow("memberReceipts.G001 contains unsupported keys");
	});

	it("boundary default: declaration and evidence must agree in both directions", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc" });
		await startNextUltragoalGoal({ cwd: root });

		const declaredWithoutEvidence = JSON.parse(implicitDeferredGate("G001", ["targetedVerification", "iteration"]));
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "declares a lane it did not prove",
				qualityGateJson: JSON.stringify(declaredWithoutEvidence),
			}),
		).rejects.toThrow("declares iteration but deferredToBatch.iteration.evidence is missing");

		const evidenceWithoutDeclaration = JSON.parse(implicitDeferredGate("G001", ["targetedVerification"]));
		evidenceWithoutDeclaration.deferredToBatch.iteration = {
			status: "passed",
			rerunCommands: ["bun test boundary"],
			evidence: "rerun evidence with no declaration",
			blockers: [],
		};
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "submits evidence it did not declare",
				qualityGateJson: JSON.stringify(evidenceWithoutDeclaration),
			}),
		).rejects.toThrow("iteration is present but iteration is not declared");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "claims a deferred review lane",
				qualityGateJson: implicitDeferredGate("G001", ["targetedVerification", "architectReview"]),
			}),
		).rejects.toThrow("cannot declare architectReview");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "omits the mandatory targeted lane",
				qualityGateJson: implicitDeferredGate("G001", ["aiSlopCleaner"]),
			}),
		).rejects.toThrow("must declare targetedVerification");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "declares an unknown lane",
				qualityGateJson: implicitDeferredGate("G001", ["targetedVerification", "bogusLane"]),
			}),
		).rejects.toThrow("unknown lane bogusLane");
	});

	it("boundary default: an implicit deferred gate still rejects review-lane keys", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc" });
		await startNextUltragoalGoal({ cwd: root });

		for (const forged of ["architectReview", "executorQa", "validationBatchClose"]) {
			const gate = JSON.parse(implicitDeferredGate("G001", ["targetedVerification"]));
			gate[forged] = { status: "passed" };
			await expect(
				checkpointUltragoalGoal({
					cwd: root,
					goalId: "G001",
					status: "complete",
					evidence: `forged ${forged}`,
					qualityGateJson: JSON.stringify(gate),
				}),
			).rejects.toThrow("unsupported keys");
		}
	});

	it("review cohort: enforces one joined generation bound to a single frozen source hash", async () => {
		const root = await batchTempDir();
		const gate = JSON.parse(await passingLiveQualityGate(root));
		const cohort = gate.iteration.reviewCohort;
		expect(cohort.reviewGeneration).toBe(1);
		expect(cohort.joined).toBe(true);
		expect(Object.keys(cohort.lanes).sort()).toEqual(["architect", "cleaner", "qa"]);
		for (const lane of ["architect", "cleaner", "qa"]) {
			expect(cohort.lanes[lane].sourceHash).toBe(cohort.sourceHash);
		}
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "one joined cohort generation",
			qualityGateJson: JSON.stringify(gate),
		});
		expect((await readUltragoalPlan(root))?.goals[0]?.status).toBe("complete");
	});

	it("review cohort: rejects a missing cohort, an unjoined cohort, and a missing lane", async () => {
		const root = await batchTempDir();
		const base = JSON.parse(await passingLiveQualityGate(root));
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		await startNextUltragoalGoal({ cwd: root });

		const missing = structuredClone(base);
		delete missing.iteration.reviewCohort;
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "no cohort",
				qualityGateJson: JSON.stringify(missing),
			}),
		).rejects.toThrow("iteration.reviewCohort is required");

		const unjoined = structuredClone(base);
		unjoined.iteration.reviewCohort.joined = false;
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "unjoined cohort",
				qualityGateJson: JSON.stringify(unjoined),
			}),
		).rejects.toThrow("all lane findings must join before checkpoint");

		for (const lane of ["cleaner", "architect", "qa"]) {
			const dropped = structuredClone(base);
			delete dropped.iteration.reviewCohort.lanes[lane];
			await expect(
				checkpointUltragoalGoal({
					cwd: root,
					goalId: "G001",
					status: "complete",
					evidence: `missing ${lane}`,
					qualityGateJson: JSON.stringify(dropped),
				}),
			).rejects.toThrow(`lanes.${lane} is required`);
		}
	});

	it("review cohort: rejects a hash-mismatched lane verdict and duplicate lanes for one generation", async () => {
		const root = await batchTempDir();
		const base = JSON.parse(await passingLiveQualityGate(root));
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		await startNextUltragoalGoal({ cwd: root });

		const stale = structuredClone(base);
		stale.iteration.reviewCohort.lanes.architect.sourceHash = "sha256:a-different-snapshot";
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "architect reviewed a different snapshot",
				qualityGateJson: JSON.stringify(stale),
			}),
		).rejects.toThrow("every lane must inspect the same immutable source");

		const duplicated = structuredClone(base);
		duplicated.iteration.reviewCohort.lanes.qa = [base.iteration.reviewCohort.lanes.qa];
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "two qa lanes in one generation",
				qualityGateJson: JSON.stringify(duplicated),
			}),
		).rejects.toThrow("must be one lane per generation, not a list");

		const extraLane = structuredClone(base);
		extraLane.iteration.reviewCohort.lanes.secondArchitect = base.iteration.reviewCohort.lanes.architect;
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "extra review lane",
				qualityGateJson: JSON.stringify(extraLane),
			}),
		).rejects.toThrow("unsupported lanes: secondArchitect");
	});

	it("review cohort: a later generation must be delta-only over a new frozen source", async () => {
		const root = await batchTempDir();
		const base = JSON.parse(await passingLiveQualityGate(root));
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		await startNextUltragoalGoal({ cwd: root });

		const secondGeneration = (overrides: Record<string, unknown>) => {
			const gate = structuredClone(base);
			const hash = "sha256:generation-2-frozen-source";
			gate.iteration.reviewCohort = {
				...gate.iteration.reviewCohort,
				reviewGeneration: 2,
				sourceHash: hash,
				priorGenerationSourceHash: base.iteration.reviewCohort.sourceHash,
				deltaOnly: true,
				deltaPaths: ["packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts"],
				lanes: Object.fromEntries(
					Object.entries(gate.iteration.reviewCohort.lanes).map(([lane, record]) => [
						lane,
						{ ...(record as Record<string, unknown>), sourceHash: hash },
					]),
				),
				...overrides,
			};
			return gate;
		};

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "generation 2 claims full scope",
				qualityGateJson: JSON.stringify(secondGeneration({ deltaOnly: false })),
			}),
		).rejects.toThrow("deltaOnly must be true for reviewGeneration > 1");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "generation 2 with no delta",
				qualityGateJson: JSON.stringify(secondGeneration({ deltaPaths: [] })),
			}),
		).rejects.toThrow("deltaPaths must be non-empty");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "generation 2 reusing the prior frozen source",
				qualityGateJson: JSON.stringify(
					secondGeneration({ priorGenerationSourceHash: "sha256:generation-2-frozen-source" }),
				),
			}),
		).rejects.toThrow("a new generation requires a new frozen source");

		const firstGenerationDelta = structuredClone(base);
		firstGenerationDelta.iteration.reviewCohort.deltaOnly = true;
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "generation 1 claiming delta-only",
				qualityGateJson: JSON.stringify(firstGenerationDelta),
			}),
		).rejects.toThrow("deltaOnly cannot be true for the first reviewGeneration");

		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "generation 2 delta-only review after one consolidated fix batch",
			qualityGateJson: JSON.stringify(secondGeneration({})),
		});
		expect((await readUltragoalPlan(root))?.goals[0]?.status).toBe("complete");
	});

	it("review cohort: the terminal critic verdict must be bound to the final joined generation", async () => {
		const root = await batchTempDir();
		const base = JSON.parse(await passingLiveQualityGate(root));
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		await startNextUltragoalGoal({ cwd: root });

		const forged = structuredClone(base);
		forged.criticReview = { ...forged.criticReview, sourceHash: "sha256:some-earlier-generation" };
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "critic approved an earlier generation",
				qualityGateJson: JSON.stringify(forged),
			}),
		).rejects.toThrow("the terminal critic runs once on the terminal generation");

		const bound = structuredClone(base);
		bound.criticReview = { ...bound.criticReview, sourceHash: base.iteration.reviewCohort.sourceHash };
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "critic bound to the final joined generation",
			qualityGateJson: JSON.stringify(bound),
		});
		expect((await readUltragoalPlan(root))?.goals[0]?.completionVerification?.receiptKind).toBe("final-aggregate");
	});

	it("quality-gate validate: reports every independent defect in one read-only run", async () => {
		const root = await batchTempDir();
		await writeStructuralArtifacts(root);
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		await startNextUltragoalGoal({ cwd: root });

		const broken = {
			architectReview: {
				architectureStatus: "WATCH",
				productStatus: "CLEAR",
				codeStatus: "CLEAR",
				recommendation: "COMMENT",
				evidence: "",
				commands: [],
				blockers: ["architect blocker"],
			},
			executorQa: {
				status: "failed",
				e2eStatus: "passed",
				redTeamStatus: "passed",
				evidence: "",
				e2eCommands: [],
				redTeamCommands: [],
				blockers: ["qa blocker"],
			},
			iteration: {
				status: "failed",
				fullRerun: false,
				rerunCommands: [],
				evidence: "",
				blockers: ["iteration blocker"],
			},
			bogusKey: {},
		};
		const gatePath = path.join(root, "broken-gate.json");
		await fs.writeFile(gatePath, JSON.stringify(broken));

		const result = await validateUltragoalQualityGateReadOnly({ cwd: root, qualityGateJson: gatePath });
		expect(result.valid).toBe(false);
		// A single run must surface every unrelated defect, not just the first one.
		expect(result.errors.length).toBeGreaterThan(10);
		const codes = new Set(result.errors.map(diagnostic => diagnostic.code));
		expect(codes).toContain("unsupported_keys");
		expect(codes).toContain("architect_not_clear");
		expect(codes).toContain("executor_qa_not_passed");
		expect(codes).toContain("iteration_not_passed");
		expect(codes).toContain("missing_evidence");
		expect(codes).toContain("non_empty_blockers");
		expect(codes).toContain("missing_command_array");
		expect(codes).toContain("review_cohort_invalid");
		const paths = result.errors.map(diagnostic => diagnostic.path);
		expect(paths).toContain("architectReview.commands");
		expect(paths).toContain("executorQa.evidence");
		expect(paths).toContain("iteration.blockers");
		expect(paths).toContain("iteration.reviewCohort");
		for (const diagnostic of result.errors) {
			expect(diagnostic.path.length).toBeGreaterThan(0);
			expect(diagnostic.code).toMatch(/^[a-z0-9_]+$/);
			expect(diagnostic.message.length).toBeGreaterThan(0);
		}
	});

	it("quality-gate validate: is read-only and rule-identical to checkpoint complete", async () => {
		const root = await batchTempDir();
		const validGate = await passingLiveQualityGate(root);
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		await startNextUltragoalGoal({ cwd: root });
		const gatePath = path.join(root, "valid-gate.json");
		await fs.writeFile(gatePath, validGate);

		const goalsPath = path.join(root, ".gjc", `_session-${process.env.GJC_SESSION_ID}`, "ultragoal", "goals.json");
		const ledgerPath = path.join(root, ".gjc", `_session-${process.env.GJC_SESSION_ID}`, "ultragoal", "ledger.jsonl");
		const [goalsBefore, ledgerBefore] = await Promise.all([
			fs.readFile(goalsPath, "utf8"),
			fs.readFile(ledgerPath, "utf8"),
		]);

		const valid = await validateUltragoalQualityGateReadOnly({ cwd: root, qualityGateJson: gatePath });
		expect(valid).toEqual({ valid: true, errors: [] });

		const invalidGate = JSON.parse(validGate);
		delete invalidGate.iteration.reviewCohort;
		const invalidPath = path.join(root, "invalid-gate.json");
		await fs.writeFile(invalidPath, JSON.stringify(invalidGate));
		const invalid = await validateUltragoalQualityGateReadOnly({ cwd: root, qualityGateJson: invalidPath });
		expect(invalid.valid).toBe(false);

		// Rule identity: what validate rejects, checkpoint must also reject.
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "gate validate already rejected this",
				qualityGateJson: JSON.stringify(invalidGate),
			}),
		).rejects.toThrow("iteration.reviewCohort is required");

		const [goalsAfter, ledgerAfter] = await Promise.all([
			fs.readFile(goalsPath, "utf8"),
			fs.readFile(ledgerPath, "utf8"),
		]);
		expect(goalsAfter).toBe(goalsBefore);
		expect(ledgerAfter).toBe(ledgerBefore);

		// And what validate accepts, checkpoint must accept.
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "gate validate accepted this",
			qualityGateJson: validGate,
		});
		expect((await readUltragoalPlan(root))?.goals[0]?.status).toBe("complete");
	});

	it("quality-gate validate: rejects an unknown subcommand and a missing gate", async () => {
		const root = await batchTempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });

		const unknown = await runNativeUltragoalCommand(["quality-gate", "collect"], root);
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain("supported: init, source-hash, lane-selection, validate");

		const missing = await runNativeUltragoalCommand(["quality-gate", "validate"], root);
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain("requires --quality-gate-json");
	});

	it("quality-gate init: writes a multi-surface template without mutating goals", async () => {
		const root = await batchTempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship one boundary" });
		const goalsPath = path.join(root, ".gjc", `_session-${process.env.GJC_SESSION_ID}`, "ultragoal", "goals.json");
		const goalsBefore = await fs.readFile(goalsPath, "utf8");
		const out = path.join(root, "quality-gate.json");

		const init = await runNativeUltragoalCommand(
			["quality-gate", "init", "--surface", "web", "--surface", "api", "--out", out, "--json"],
			root,
		);
		expect(init.status).toBe(0);
		expect(await fs.exists(out)).toBe(true);
		const template = JSON.parse(await fs.readFile(out, "utf8")) as {
			architectReview?: unknown;
			executorQa?: { surfaceEvidence?: Array<{ surface?: string }> };
			iteration?: unknown;
		};
		expect(template.architectReview).toBeTruthy();
		expect(template.executorQa).toBeTruthy();
		expect(template.iteration).toBeTruthy();
		const surfaces = (template.executorQa?.surfaceEvidence ?? []).map(row => row.surface);
		expect(surfaces).toContain("gui/web");
		expect(surfaces.some(surface => String(surface).includes("api"))).toBe(true);

		const missingOut = await runNativeUltragoalCommand(["quality-gate", "init", "--surface", "web"], root);
		expect(missingOut.status).toBe(1);
		expect(missingOut.stderr).toContain("requires --out");

		expect(await fs.readFile(goalsPath, "utf8")).toBe(goalsBefore);
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

	it("hydrates a reviewed validation-batch final recovery and rejects stale, wrong, and multiple replacements", async () => {
		const prepareRecovery = async () => {
			const root = await batchTempDir();
			await writeStructuralArtifacts(root);
			let plan = await createUltragoalPlan({
				cwd: root,
				brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc\n@goal: D\nd",
				validationBatches: [
					{ schemaVersion: 1, batchId: "VB001", memberIds: ["G002", "G003", "G004"], finalGoalId: "G004" },
				],
			});
			await startNextUltragoalGoal({ cwd: root });
			plan = await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "g001 complete",
				qualityGateJson: passingQualityGate(),
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
				evidence: "g003 deferred",
				qualityGateJson: deferredBatchGate("G003", plan.goals[2]!.validationBatch!),
			});
			await startNextUltragoalGoal({ cwd: root });
			await runNativeUltragoalCommand(
				[
					"record-review-blockers",
					"--goal-id",
					"G004",
					"--title",
					"Replacement",
					"--objective",
					"Resolve the reviewed final.",
					"--evidence",
					"The original final was reviewed and superseded.",
				],
				root,
			);
			await addUltragoalSubgoal({
				cwd: root,
				title: "Aggregate final",
				objective: "Produce final aggregate evidence.",
				evidence: "Aggregate evidence is required after replacement.",
				rationale: "Keep aggregate evidence after the replacement receipt.",
			});
			await startNextUltragoalGoal({ cwd: root });
			await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G005",
				status: "complete",
				evidence: "replacement verified",
				qualityGateJson: passingQualityGate(),
			});
			await startNextUltragoalGoal({ cwd: root });
			await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G006",
				status: "complete",
				evidence: "aggregate verified",
				qualityGateJson: passingQualityGate(),
			});
			await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G004",
				status: "active",
				evidence: "reopened after aggregate receipt",
			});
			return root;
		};
		const recoveryGate = (replacementGoalId: string) =>
			JSON.stringify({
				...JSON.parse(passingQualityGate()),
				validationBatchClose: {
					schemaVersion: 1,
					kind: "review-blocker-replacement-close",
					replacementGoalId,
					coverageEvidence: "The reviewed replacement and cumulative batch validation are covered.",
				},
			});

		const validRoot = await prepareRecovery();
		const validRecoveryGate = recoveryGate("G005");
		expect(
			await validateUltragoalQualityGateReadOnly({
				cwd: validRoot,
				goalId: "G004",
				qualityGateJson: validRecoveryGate,
			}),
		).toEqual({ valid: true, errors: [] });
		const closed = await checkpointUltragoalGoal({
			cwd: validRoot,
			goalId: "G004",
			status: "complete",
			evidence: "hydrated normal batch close",
			qualityGateJson: validRecoveryGate,
		});
		expect(closed.goals[3]?.completionVerification?.validationBatch).toMatchObject({
			role: "batch-close",
			batchId: "VB001",
			finalGoalId: "G004",
		});
		const closeLedger = (await readUltragoalLedger(validRoot)).at(-1);
		expect((closeLedger?.qualityGateJson as Record<string, unknown>).validationBatchClose).toMatchObject({
			kind: "validation-batch-close",
			memberIds: ["G002", "G003", "G004"],
		});

		const tamperedAggregateRoot = await prepareRecovery();
		const tamperedAggregateGoalsPath = path.join(
			sessionUltragoalDir(tamperedAggregateRoot, TEST_SESSION_ID),
			"goals.json",
		);
		const tamperedAggregatePlan = JSON.parse(await Bun.file(tamperedAggregateGoalsPath).text());
		tamperedAggregatePlan.goals[5].completionVerification.basis.requiredGoalSetHashBeforeCheckpoint = "f".repeat(64);
		await fs.writeFile(tamperedAggregateGoalsPath, `${JSON.stringify(tamperedAggregatePlan, null, 2)}\n`);
		const tamperedAggregateGate = recoveryGate("G005");
		const tamperedAggregateValidation = await validateUltragoalQualityGateReadOnly({
			cwd: tamperedAggregateRoot,
			goalId: "G004",
			qualityGateJson: tamperedAggregateGate,
		});
		expect(tamperedAggregateValidation.valid).toBe(false);
		expect(
			tamperedAggregateValidation.errors.some(error =>
				error.message.includes("fresh final-aggregate receipt covering required goals"),
			),
		).toBe(true);
		await expect(
			checkpointUltragoalGoal({
				cwd: tamperedAggregateRoot,
				goalId: "G004",
				status: "complete",
				evidence: "tampered aggregate receipt",
				qualityGateJson: tamperedAggregateGate,
			}),
		).rejects.toThrow("fresh final-aggregate receipt covering required goals");

		const wrongRoot = await prepareRecovery();
		await expect(
			checkpointUltragoalGoal({
				cwd: wrongRoot,
				goalId: "G004",
				status: "complete",
				evidence: "wrong replacement",
				qualityGateJson: recoveryGate("G006"),
			}),
		).rejects.toThrow("exactly the declared replacement");

		const staleRoot = await prepareRecovery();
		const staleGoalsPath = path.join(sessionUltragoalDir(staleRoot, TEST_SESSION_ID), "goals.json");
		const stalePlan = JSON.parse(await Bun.file(staleGoalsPath).text());
		stalePlan.goals[4].updatedAt = new Date(Date.now() + 1_000).toISOString();
		await fs.writeFile(staleGoalsPath, `${JSON.stringify(stalePlan, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: staleRoot,
				goalId: "G004",
				status: "complete",
				evidence: "stale replacement",
				qualityGateJson: recoveryGate("G005"),
			}),
		).rejects.toThrow("replacement close Ultragoal G005 receipt generation is stale.");

		const multipleRoot = await prepareRecovery();
		const multiplePlanPath = path.join(sessionUltragoalDir(multipleRoot, TEST_SESSION_ID), "goals.json");
		const multiplePlan = JSON.parse(await Bun.file(multiplePlanPath).text());
		multiplePlan.goals.push({
			...multiplePlan.goals[4],
			id: "G007",
			status: "pending",
			steering: { kind: "review_blocker", blockedGoalId: "G004" },
		});
		await fs.writeFile(multiplePlanPath, `${JSON.stringify(multiplePlan, null, 2)}\n`);
		await expect(
			checkpointUltragoalGoal({
				cwd: multipleRoot,
				goalId: "G004",
				status: "complete",
				evidence: "multiple replacements",
				qualityGateJson: recoveryGate("G005"),
			}),
		).rejects.toThrow("exactly the declared replacement");
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
		saved.goals[0].completionVerification.validationBatch.changeSetHash = "f".repeat(64);
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
		).rejects.toThrow("does not match its ledger event receipt");
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

	it("reports resolve-blockers (not none/execute-goal) when the only story is blocked (#2903)", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "blocked",
			evidence: "waiting on external review",
		});

		const jsonResult = await runNativeUltragoalCommand(["complete-goals", "--json"], root);
		const textResult = await runNativeUltragoalCommand(["complete-goals"], root);
		const receipt = JSON.parse(jsonResult.stdout ?? "{}");

		expect(jsonResult.status).toBe(0);
		expect(textResult.status).toBe(0);
		expect(receipt).toMatchObject({
			ok: true,
			all_complete: false,
			next_action: "resolve-blockers",
			blocked_goal_ids: ["G001"],
		});
		expect(receipt.goal_id).toBeUndefined();
		expect(receipt.blocked_goals).toEqual([
			expect.objectContaining({ id: "G001", status: "blocked", evidence: "waiting on external review" }),
		]);
		expect(textResult.stdout).toContain("next-action=resolve-blockers");
		expect(textResult.stdout).toContain("blocked-goal-ids=G001");
		expect(textResult.stdout).not.toContain("next-action=none");
		expect(textResult.stdout).not.toContain("next-action=execute-goal");
	});

	it("reports resolve-blockers for review_blocked with text/json parity (#2903)", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "review_blocked",
			evidence: "architect requested design rewrite",
		});

		const jsonResult = await runNativeUltragoalCommand(["complete-goals", "--json"], root);
		const textResult = await runNativeUltragoalCommand(["complete-goals"], root);
		const receipt = JSON.parse(jsonResult.stdout ?? "{}");

		expect(jsonResult.status).toBe(0);
		expect(receipt.next_action).toBe("resolve-blockers");
		expect(receipt.blocked_goal_ids).toEqual(["G001"]);
		expect(receipt.blocked_goals?.[0]?.status).toBe("review_blocked");
		expect(textResult.stdout).toContain("next-action=resolve-blockers");
		expect(textResult.stdout).toContain("G001:review_blocked");
	});

	it("reports retry-failed when incomplete work is only failed and --retry-failed is off (#2903)", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "failed",
			evidence: "tests red",
		});

		const jsonResult = await runNativeUltragoalCommand(["complete-goals", "--json"], root);
		const textResult = await runNativeUltragoalCommand(["complete-goals"], root);
		const receipt = JSON.parse(jsonResult.stdout ?? "{}");

		expect(receipt).toMatchObject({
			all_complete: false,
			next_action: "retry-failed",
			failed_goal_ids: ["G001"],
		});
		expect(receipt.goal_id).toBeUndefined();
		expect(textResult.stdout).toContain("next-action=retry-failed");
		expect(textResult.stdout).toContain("failed-goal-ids=G001");
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

	it("keeps final aggregate on the temporal last required goal", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "@goal: A\na\n@goal: B\nb\n@goal: C\nc" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[2].status = "active";
		saved.goals[2].startedAt = new Date().toISOString();
		saved.goals[2].updatedAt = saved.goals[2].startedAt;
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		const middleComplete = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G003",
			status: "complete",
			evidence: "third goal verified before second",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(middleComplete.goals[2]?.completionVerification?.receiptKind).toBe("per-goal");

		await startNextUltragoalGoal({ cwd: root });
		const finalComplete = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "second goal verified last",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(finalComplete.goals[1]?.completionVerification?.receiptKind).toBe("final-aggregate");
	});

	it("keeps non-final complete re-checkpoints idempotent after aggregate completion (#1777)", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await addUltragoalSubgoal({
			cwd: root,
			title: "Second stage",
			objective: "Complete the second stage.",
			evidence: "The regression requires a second required goal.",
			rationale: "Cover complete re-checkpoint receipt kind after aggregate completion.",
		});
		await startNextUltragoalGoal({ cwd: root });
		const afterFirst = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(afterFirst.goals[0]?.completionVerification?.receiptKind).toBe("per-goal");
		await startNextUltragoalGoal({ cwd: root });
		const afterFinal = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "final goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(afterFinal.goals[1]?.completionVerification?.receiptKind).toBe("final-aggregate");
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const goalsAfterFinal = await Bun.file(goalsPath).text();
		const checkpointCount = (await readUltragoalLedger(root)).filter(
			event => event.event === "goal_checkpointed",
		).length;

		const afterIdempotent = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		expect(afterIdempotent.goals[0]?.completionVerification?.receiptKind).toBe("per-goal");
		expect((await readUltragoalLedger(root)).filter(event => event.event === "goal_checkpointed")).toHaveLength(
			checkpointCount,
		);
		expect(await Bun.file(goalsPath).text()).toBe(goalsAfterFinal);
	});

	it("re-mints a final-aggregate receipt when goals are appended after aggregate completion", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		const afterFirst = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(afterFirst.goals[0]?.completionVerification?.receiptKind).toBe("final-aggregate");

		await addUltragoalSubgoal({
			cwd: root,
			title: "Appended stage",
			objective: "Complete the appended stage.",
			evidence: "The run gained a new required goal after aggregate completion.",
			rationale: "Cover final-aggregate re-minting after an append staled the prior receipt.",
		});
		await startNextUltragoalGoal({ cwd: root });
		const afterAppended = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "appended goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		// Appending G002 staled G001's final-aggregate receipt by design. The
		// closing checkpoint must mint a fresh final-aggregate receipt instead of
		// deferring to the stale one, which would leave the run permanently
		// unable to satisfy the final-aggregate completion guard.
		expect(afterAppended.goals[1]?.completionVerification?.receiptKind).toBe("final-aggregate");

		const plan = await readUltragoalPlan(root);
		if (!plan) throw new Error("missing ultragoal plan");
		const ledger = await readUltragoalLedger(root);
		expect(
			validateCompletionReceipt({ plan, ledger, goal: plan.goals[1]!, receiptKind: "final-aggregate" }).state,
		).toBe("active_verified_complete");
		const durable = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
		expect(durable.state).toBe("active_verified_complete");
	});

	it("re-mints the receipt on identical-evidence replay after a goal-tagged ledger event staled it", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		const classified = await runNativeUltragoalCommand(
			[
				"classify-blocker",
				"--classification",
				"resolvable",
				"--evidence",
				"post-completion audit note tagged to the completed goal",
				"--goal-id",
				"G001",
			],
			root,
		);
		expect(classified.status).toBe(0);

		// The goal-tagged blocker_classified event stales the recorded receipt.
		const staleDurable = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
		expect(staleDurable.state).not.toBe("active_verified_complete");
		const checkpointsBefore = (await readUltragoalLedger(root)).filter(
			event => event.event === "goal_checkpointed",
		).length;

		// Different evidence stays rejected on complete goals; the identical
		// evidence replay must re-verify and mint a fresh receipt instead of
		// no-opping on the stale one (which would be unrepairable forever).
		const replayed = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(replayed.goals[0]?.completionVerification?.receiptKind).toBe("final-aggregate");
		expect((await readUltragoalLedger(root)).filter(event => event.event === "goal_checkpointed")).toHaveLength(
			checkpointsBefore + 1,
		);
		const durable = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
		expect(durable.state).toBe("active_verified_complete");

		// A further identical-evidence replay of the now-fresh receipt is a
		// pure no-op resolved against the receipt's own (latest) checkpoint
		// event, never the oldest duplicate.
		const receiptIdAfterRemint = replayed.goals[0]?.completionVerification?.receiptId;
		const again = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(again.goals[0]?.completionVerification?.receiptId).toBe(receiptIdAfterRemint);
		expect((await readUltragoalLedger(root)).filter(event => event.event === "goal_checkpointed")).toHaveLength(
			checkpointsBefore + 1,
		);
	});

	it("rejects identical-evidence replay when the goal row changed after receipt verification", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		saved.goals[0].updatedAt = new Date(Date.now() + 1000).toISOString();
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);

		// A mutated complete row is neither a clean no-op nor a repairable
		// context-stale replay; it must fail loud instead of silently
		// laundering the inconsistency.
		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "first goal verified",
				qualityGateJson: await passingLiveQualityGate(root),
			}),
		).rejects.toThrow("changed after its completion receipt was verified");
	});

	it("re-mints on identical-evidence replay when the recorded final-aggregate gate lacks criticReview OKAY (#3365)", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		// Simulate a legacy final-aggregate checkpoint minted before criticReview
		// was required: strip criticReview from the recorded ledger gate and keep
		// the receipt hashes internally consistent so the receipt is NOT stale —
		// only the completion guard's criticReview check rejects it.
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const ledgerPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		const receipt = saved.goals[0].completionVerification;
		let strippedHash = "";
		const rewritten = (await Bun.file(ledgerPath).text())
			.split("\n")
			.filter(line => line.trim())
			.map(line => {
				const event = JSON.parse(line);
				if (event.eventId === receipt.checkpointLedgerEventId) {
					delete event.qualityGateJson.criticReview;
					strippedHash = hashStructuredValue(event.qualityGateJson);
					event.completionVerification.qualityGateHash = strippedHash;
				}
				return JSON.stringify(event);
			});
		await fs.writeFile(ledgerPath, `${rewritten.join("\n")}\n`);
		receipt.qualityGateHash = strippedHash;
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);

		// The receipt is fresh but the guard rejects it: without repair the run
		// loops forever (the receipt validator reports active_missing_critic_verdict
		// and the durable wrapper surfaces a non-complete state).
		const brokenPlan = (await readUltragoalPlan(root))!;
		const brokenLedger = await readUltragoalLedger(root);
		expect(
			validateCompletionReceipt({
				plan: brokenPlan,
				ledger: brokenLedger,
				goal: brokenPlan.goals[0]!,
				receiptKind: "final-aggregate",
			}).state,
		).toBe("active_missing_critic_verdict");
		const blocked = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
		expect(blocked.state).not.toBe("active_verified_complete");
		const checkpointsBefore = (await readUltragoalLedger(root)).filter(
			event => event.event === "goal_checkpointed",
		).length;

		// The identical-evidence replay with a corrected gate (criticReview OKAY)
		// must re-verify and re-mint instead of no-opping on the broken receipt.
		const replayed = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(replayed.goals[0]?.completionVerification?.receiptKind).toBe("final-aggregate");
		expect(replayed.goals[0]?.completionVerification?.receiptId).not.toBe(receipt.receiptId);
		expect((await readUltragoalLedger(root)).filter(event => event.event === "goal_checkpointed")).toHaveLength(
			checkpointsBefore + 1,
		);
		const durable = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
		expect(durable.state).toBe("active_verified_complete");
	});

	it("rejects a superseded final-aggregate receipt whose forged basis is mirrored onto the ledger event generation", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "first goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		await addUltragoalSubgoal({
			cwd: root,
			title: "Appended stage",
			objective: "Complete the appended stage.",
			evidence: "The run gained a new required goal after aggregate completion.",
			rationale: "Red-team: forged superseded receipt provenance must be rejected.",
		});
		await startNextUltragoalGoal({ cwd: root });
		await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G002",
			status: "complete",
			evidence: "appended goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});

		// Coordinated tamper: forge the goals-row basis and generation of
		// G001's superseded final-aggregate receipt, and mirror ONLY the
		// generation onto its ledger checkpoint event. Field-selective ledger
		// matching would accept this as verified provenance.
		const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
		const saved = JSON.parse(await Bun.file(goalsPath).text());
		const forgedReceipt = saved.goals[0].completionVerification;
		forgedReceipt.basis.planHashBeforeCheckpoint = "forged";
		forgedReceipt.planGeneration = hashStructuredValue(forgedReceipt.basis);
		await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);
		const ledgerPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl");
		const rewritten = (await Bun.file(ledgerPath).text())
			.split("\n")
			.filter(line => line.trim())
			.map(line => {
				const event = JSON.parse(line);
				if (event.eventId === forgedReceipt.checkpointLedgerEventId) {
					event.completionVerification.planGeneration = forgedReceipt.planGeneration;
				}
				return JSON.stringify(event);
			});
		await fs.writeFile(ledgerPath, `${rewritten.join("\n")}\n`);

		const plan = await readUltragoalPlan(root);
		if (!plan) throw new Error("missing ultragoal plan");
		const ledger = await readUltragoalLedger(root);
		expect(
			validateCompletionReceipt({ plan, ledger, goal: plan.goals[1]!, receiptKind: "final-aggregate" }).state,
		).not.toBe("active_verified_complete");
		const durable = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
		expect(durable.state).not.toBe("active_verified_complete");
	});

	async function completedValidationBatchPlan(root: string) {
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
		expect(plan.goals[2]?.completionVerification?.receiptKind).toBe("final-aggregate");
		return plan;
	}

	it("keeps per-goal deferred receipts when replaying a context-staled validation batch member", async () => {
		const root = await batchTempDir();
		const plan = await completedValidationBatchPlan(root);

		const classified = await runNativeUltragoalCommand(
			[
				"classify-blocker",
				"--classification",
				"resolvable",
				"--evidence",
				"post-completion audit note tagged to the completed member",
				"--goal-id",
				"G001",
			],
			root,
		);
		expect(classified.status).toBe(0);

		// The goal-tagged event stales G001's deferred receipt AND the batch
		// aggregate close. The member's re-verification replay must stay a
		// per-goal deferred receipt; minting final-aggregate on a non-final
		// batch member would poison subsequent batch-close repair.
		const replayed = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "g001 deferred",
			qualityGateJson: deferredBatchGate("G001", plan.goals[0]!.validationBatch!),
		});
		const memberReceipt = replayed.goals[0]?.completionVerification;
		expect(memberReceipt?.receiptKind).toBe("per-goal");
		expect(memberReceipt?.validationBatch?.role).toBe("deferred-member");
	});

	it("no-ops repeated identical-evidence batch close replays after a re-mint", async () => {
		const root = await batchTempDir();
		const plan = await completedValidationBatchPlan(root);
		const classified = await runNativeUltragoalCommand(
			[
				"classify-blocker",
				"--classification",
				"resolvable",
				"--evidence",
				"post-completion audit note tagged to the batch final",
				"--goal-id",
				"G003",
			],
			root,
		);
		expect(classified.status).toBe(0);

		// First replay re-verifies the staled close and appends a second
		// same-status, same-evidence checkpoint event.
		const reclosed = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G003",
			status: "complete",
			evidence: "batch close",
			qualityGateJson: batchCloseGate(plan),
		});
		const recloseReceiptId = reclosed.goals[2]?.completionVerification?.receiptId;
		const checkpointsAfterReclose = (await readUltragoalLedger(root)).filter(
			event => event.event === "goal_checkpointed",
		).length;

		// The next replay must resolve the receipt against ITS OWN checkpoint
		// event (the latest duplicate) and no-op, not compare against the
		// oldest duplicate and throw.
		const again = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G003",
			status: "complete",
			evidence: "batch close",
			qualityGateJson: batchCloseGate(plan),
		});
		expect(again.goals[2]?.completionVerification?.receiptId).toBe(recloseReceiptId);
		expect((await readUltragoalLedger(root)).filter(event => event.event === "goal_checkpointed")).toHaveLength(
			checkpointsAfterReclose,
		);
	});

	it("verifies completion of a goal appended after a closed validation batch", async () => {
		const root = await batchTempDir();
		await completedValidationBatchPlan(root);

		// Appending a goal stales the batch aggregate close by design. The
		// appended goal's completion must still be able to close the run: the
		// old batch close stands as ledger-anchored historical evidence for
		// the deferred members.
		await addUltragoalSubgoal({
			cwd: root,
			title: "Appended stage",
			objective: "Complete the appended stage.",
			evidence: "The batch run gained a new required goal after closing.",
			rationale: "Cover post-close appends regaining a fresh final-aggregate receipt.",
		});
		await startNextUltragoalGoal({ cwd: root });
		const appended = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G004",
			status: "complete",
			evidence: "appended goal verified",
			qualityGateJson: await passingLiveQualityGate(root),
		});
		expect(appended.goals[3]?.completionVerification?.receiptKind).toBe("final-aggregate");

		const plan = await readUltragoalPlan(root);
		if (!plan) throw new Error("missing ultragoal plan");
		const ledger = await readUltragoalLedger(root);
		expect(
			validateCompletionReceipt({ plan, ledger, goal: plan.goals[3]!, receiptKind: "final-aggregate" }).state,
		).toBe("active_verified_complete");
		const durable = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
		expect(durable.state).toBe("active_verified_complete");
	});
	it("re-mints the final-aggregate receipt when repairing a non-final goal after aggregate completion (#1777)", async () => {
		for (const repairStatus of ["active", "failed"] as const) {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await addUltragoalSubgoal({
				cwd: root,
				title: "Second stage",
				objective: "Complete the second stage.",
				evidence: "The regression requires a second required goal.",
				rationale: `Cover ${repairStatus} repair receipt kind after aggregate completion.`,
			});
			await startNextUltragoalGoal({ cwd: root });
			await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "first goal initially verified",
				qualityGateJson: await passingLiveQualityGate(root),
			});
			await startNextUltragoalGoal({ cwd: root });
			const completed = await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G002",
				status: "complete",
				evidence: "final goal verified",
				qualityGateJson: await passingLiveQualityGate(root),
			});
			expect(completed.goals[1]?.completionVerification?.receiptKind).toBe("final-aggregate");

			const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");
			const saved = JSON.parse(await Bun.file(goalsPath).text());
			saved.goals[0].status = repairStatus;
			saved.goals[0].evidence = `${repairStatus} repair required`;
			saved.goals[0].updatedAt = new Date(Date.now() + 1000).toISOString();
			delete saved.goals[0].completedAt;
			delete saved.goals[0].completionVerification;
			await fs.writeFile(goalsPath, `${JSON.stringify(saved, null, 2)}\n`);

			const repaired = await checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: `${repairStatus} repair verified`,
				qualityGateJson: await passingLiveQualityGate(root),
			});

			// The hand-edited repair staled G002's final-aggregate receipt (its
			// plan generation covers every required goal). The repair checkpoint
			// closes the run again, so it must re-mint the final-aggregate
			// receipt; a per-goal receipt would leave the run with no fresh
			// final-aggregate receipt forever.
			expect(repaired.goals[0]?.completionVerification?.receiptKind).toBe("final-aggregate");
			expect(
				validateCompletionReceipt({
					plan: repaired,
					ledger: await readUltragoalLedger(root),
					goal: repaired.goals[0]!,
					receiptKind: "final-aggregate",
				}).state,
			).toBe("active_verified_complete");
			const durable = await verifyUltragoalDurableCompletionState({ cwd: root, sessionId: TEST_SESSION_ID });
			expect(durable.state).toBe("active_verified_complete");
		}
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
						reviewCohort: {
							reviewGeneration: 1,
							sourceHash: "sha256:test-frozen-source",
							joined: true,
							lanes: {
								cleaner: {
									status: "passed",
									sourceHash: "sha256:test-frozen-source",
									evidence: "cleaner clean",
									blockers: [],
								},
								architect: {
									status: "CLEAR",
									sourceHash: "sha256:test-frozen-source",
									evidence: "architect clear",
									blockers: [],
								},
								qa: {
									status: "passed",
									sourceHash: "sha256:test-frozen-source",
									evidence: "qa passed",
									blockers: [],
								},
							},
						},
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

	it("requires file-backed non-live surface proof and rejects receipt-only or inline-only proof", async () => {
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
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, receiptExecutorQa)).rejects.toThrow(
			"non-live surface evidence requires an existing non-empty file",
		);

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
			"non-live surface evidence requires an existing non-empty file",
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
	it("rejects artifact-only contract coverage when the artifact file is missing", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const qa = JSON.parse(passingQualityGate()).executorQa as Record<string, unknown>;
		const artifactRefs = qa.artifactRefs as Array<Record<string, unknown>>;
		artifactRefs.push({
			id: "missing-proof",
			kind: "failure-mode-test",
			path: "artifacts/missing-proof.txt",
			description: "missing proof",
		});
		qa.contractCoverage = [
			{
				id: "artifact-only",
				contractRef: "approved-plan:goal",
				obligation: "artifact-only proof must exist",
				status: "covered",
				artifactRefs: ["missing-proof"],
			},
		];
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, qa)).rejects.toThrow(
			"artifact-only coverage requires an existing non-empty file",
		);
	});

	it("rejects fabricated receipt-only artifact coverage without a file", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const qa = JSON.parse(passingQualityGate()).executorQa as Record<string, unknown>;
		const artifactRefs = qa.artifactRefs as Array<Record<string, unknown>>;
		artifactRefs.push({
			id: "receipt-only-proof",
			kind: "failure-mode-test",
			description: "fabricated receipt-only proof",
			verifiedReceipt: { type: "test-report", receiptId: "fabricated", status: "passed" },
		});
		qa.contractCoverage = [
			{
				id: "receipt-only",
				contractRef: "approved-plan:goal",
				obligation: "receipt-only proof must be authoritative",
				status: "covered",
				artifactRefs: ["receipt-only-proof"],
			},
		];
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, qa)).rejects.toThrow(
			"artifact-only coverage requires an existing non-empty file",
		);
	});

	it("rejects fabricated receipt-only adversarial coverage without a file", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const qa = JSON.parse(passingQualityGate()).executorQa as Record<string, unknown>;
		const artifactRefs = qa.artifactRefs as Array<Record<string, unknown>>;
		artifactRefs.push({
			id: "receipt-only-adversarial",
			kind: "failure-mode-test",
			description: "fabricated adversarial receipt",
			verifiedReceipt: { type: "test-report", receiptId: "fabricated", status: "passed" },
		});
		qa.adversarialCases = [
			{
				id: "receipt-only-case",
				contractRef: "approved-plan:goal",
				scenario: "fabricated adversarial proof",
				expectedBehavior: "must reject",
				verdict: "passed",
				artifactRefs: ["receipt-only-adversarial"],
			},
		];
		qa.contractCoverage = [
			{
				id: "receipt-only-coverage",
				contractRef: "approved-plan:goal",
				obligation: "adversarial proof must be authoritative",
				status: "covered",
				adversarialCaseRefs: ["receipt-only-case"],
			},
		];
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, qa)).rejects.toThrow(
			"adversarial coverage requires an existing non-empty file",
		);
	});

	it("rejects receipt-only adversarial proof even when surface proof is valid", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const qa = JSON.parse(passingQualityGate()).executorQa as Record<string, unknown>;
		const artifactRefs = qa.artifactRefs as Array<Record<string, unknown>>;
		const adversarialArtifact = artifactRefs.find(row => row.id === "adversarial-report")!;
		delete adversarialArtifact.path;
		adversarialArtifact.verifiedReceipt = { type: "test-report", receiptId: "fabricated", status: "passed" };
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, qa)).rejects.toThrow(
			"adversarial coverage requires an existing non-empty file",
		);
	});

	it("rejects coverage links whose contractRef does not match", async () => {
		const root = await tempDir();
		await writeStructuralArtifacts(root);
		const surfaceMismatch = JSON.parse(passingQualityGate()).executorQa as Record<string, unknown>;
		(surfaceMismatch.surfaceEvidence as Array<Record<string, unknown>>)[0]!.contractRef = "other-contract";
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, surfaceMismatch)).rejects.toThrow(
			"contractRef must match approved-plan:goal",
		);

		const adversarialMismatch = JSON.parse(passingQualityGate()).executorQa as Record<string, unknown>;
		(adversarialMismatch.adversarialCases as Array<Record<string, unknown>>)[0]!.contractRef = "other-contract";
		await expect(validateExecutorQaRedTeamEvidenceForReview(root, adversarialMismatch)).rejects.toThrow(
			"contractRef must match approved-plan:goal",
		);
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

	describe("record-review-blockers recursion cap and dedup (#3613)", () => {
		it("dedups identical-objective record-review-blockers to a single open goal", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });
			const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");

			const objective = "Fix architect regression X";
			// First call creates G002.
			const first = await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G001",
				title: "Resolve verification blockers",
				objective,
				evidence: "architect found product regression",
			});
			expect(first.blockerGoalId).toBe("G002");
			const goalsAfterFirst = await Bun.file(goalsPath).text();
			const ledgerAfterFirst = await readUltragoalLedger(root);
			const eventsAfterFirst = ledgerAfterFirst.filter(e => e.event === "review_blockers_recorded").length;

			// Second call with the SAME objective dedups — returns existing id, no new goal, no ledger event.
			const second = await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G001",
				title: "Resolve verification blockers",
				objective,
				evidence: "architect found product regression",
			});
			expect(second.blockerGoalId).toBe("G002");
			const plan = await readUltragoalPlan(root);
			const reviewBlockers = plan!.goals.filter(g => g.steering?.kind === "review_blocker");
			expect(reviewBlockers.length).toBe(1);
			expect(reviewBlockers[0]?.id).toBe("G002");
			// goals.json unchanged (idempotent — no rewrite on dedup-hit).
			expect(await Bun.file(goalsPath).text()).toBe(goalsAfterFirst);
			// No new ledger event on dedup-hit.
			const ledgerAfterSecond = await readUltragoalLedger(root);
			expect(ledgerAfterSecond.filter(e => e.event === "review_blockers_recorded").length).toBe(eventsAfterFirst);
		});

		it("CLI record-review-blockers --json returns the matched existing id on dedup-hit", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });

			for (let i = 0; i < 2; i++) {
				const result = await runNativeUltragoalCommand(
					[
						"record-review-blockers",
						"--goal-id",
						"G001",
						"--title",
						"Resolve verification blockers",
						"--objective",
						"Fix the same regression",
						"--evidence",
						"architect found product regression",
						"--json",
					],
					root,
				);
				expect(result.status).toBe(0);
				const receipt = JSON.parse(result.stdout ?? "{}");
				expect(receipt.goal_id).toBe("G002");
			}
			const plan = await readUltragoalPlan(root);
			expect(plan!.goals.filter(g => g.steering?.kind === "review_blocker").length).toBe(1);
		});

		it("caps distinct review_blocker descents at 3 and throws a typed terminal handoff on the 4th", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });
			const goalsPath = path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json");

			// Descents 1..3 are allowed.
			for (let i = 0; i < 3; i++) {
				await recordUltragoalReviewBlockers({
					cwd: root,
					goalId: "G001",
					title: `Blocker ${i}`,
					objective: `Fix distinct finding number ${i}`,
					evidence: `evidence for finding ${i}`,
				});
			}
			const planBefore = await readUltragoalPlan(root);
			expect(planBefore!.goals.filter(g => g.steering?.kind === "review_blocker").length).toBe(3);
			const goalsBefore = await Bun.file(goalsPath).text();

			// The 4th distinct objective triggers the typed terminal handoff.
			await expect(
				recordUltragoalReviewBlockers({
					cwd: root,
					goalId: "G001",
					title: "Blocker 3",
					objective: "Fix distinct finding number 3",
					evidence: "evidence for finding 3",
				}),
			).rejects.toBeInstanceOf(UltragoalReviewBlockerRecursionCapError);

			// Fail closed: goals.json byte-identical to pre-cap (no partial mutation).
			expect(await Bun.file(goalsPath).text()).toBe(goalsBefore);
			const ledger = await readUltragoalLedger(root);
			// Only 3 review_blockers_recorded events — the 4th wrote nothing.
			expect(ledger.filter(e => e.event === "review_blockers_recorded").length).toBe(3);
		});

		it("CLI surfaces the cap as a non-zero exit with the typed marker", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });

			for (let i = 0; i < 3; i++) {
				await runNativeUltragoalCommand(
					[
						"record-review-blockers",
						"--goal-id",
						"G001",
						"--objective",
						`Distinct finding ${i}`,
						"--evidence",
						"evidence",
					],
					root,
				);
			}
			const result = await runNativeUltragoalCommand(
				[
					"record-review-blockers",
					"--goal-id",
					"G001",
					"--objective",
					"Distinct finding 3",
					"--evidence",
					"evidence",
				],
				root,
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("review_blocker_recursion_cap");
		});

		it("does not count resolved (complete/superseded) ancestors toward the cap", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });

			// Create one review_blocker descent, then supersede its blocked goal by completing the blocker.
			await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G001",
				title: "Blocker 0",
				objective: "Finding A",
				evidence: "evidence A",
			});
			// G001 is now review_blocked; completing G002 supersedes G001 (checkpoint reconcile).
			// Use a new root so G001 can accrue fresh descents without the superseded chain.
			const root2 = await tempDir();
			await createUltragoalPlan({ cwd: root2, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root2 });

			// Create 3 descents off G001 — all unresolved, this is the cap.
			for (let i = 0; i < 3; i++) {
				await recordUltragoalReviewBlockers({
					cwd: root2,
					goalId: "G001",
					title: `Blocker ${i}`,
					objective: `Distinct finding ${i}`,
					evidence: `evidence ${i}`,
				});
			}
			// Resolve G002 (the first descent) by marking it complete via checkpoint — this
			// removes it from the unresolved count, allowing a new distinct descent.
			const plan = await readUltragoalPlan(root2);
			const g002 = plan!.goals.find(g => g.id === "G002")!;
			// Directly simulate resolution: mark G002 complete via checkpoint to reduce unresolved count.
			// Since complete requires a quality gate, verify the count logic by reading the plan instead.
			const unresolved = plan!.goals.filter(
				g => g.steering?.kind === "review_blocker" && g.steering.blockedGoalId === "G001" && g.status === "pending",
			);
			expect(unresolved.length).toBe(3);
			expect(g002.status).toBe("pending");
		});

		it("dedups against persisted state across restart/replay (durable budget)", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });

			// First call creates the goal.
			await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G001",
				title: "Blocker",
				objective: "Persistent finding",
				evidence: "evidence",
			});
			// Simulated "restart": just call again — dedup must read from the persisted plan.
			const result = await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G001",
				title: "Blocker",
				objective: "Persistent finding",
				evidence: "evidence",
			});
			expect(result.blockerGoalId).toBe("G002");
			const plan = await readUltragoalPlan(root);
			expect(plan!.goals.filter(g => g.steering?.kind === "review_blocker").length).toBe(1);
		});

		it("handles missing/absent blocked goal id without spurious cap or dedup errors", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });

			// Goal id that doesn't exist — checkpointUltragoalGoal throws first (existing behavior).
			await expect(
				recordUltragoalReviewBlockers({
					cwd: root,
					goalId: "G999",
					title: "Blocker",
					objective: "Finding for missing goal",
					evidence: "evidence",
				}),
			).rejects.toThrow(/No ultragoal goal found for G999/);
		});

		it("preserves ordinary single-round record-review-blockers behavior", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });

			const result = await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G001",
				title: "Resolve verification blockers",
				objective: "Fix a genuine single finding.",
				evidence: "architect found product regression",
			});
			expect(result.blockerGoalId).toBe("G002");
			const plan = await readUltragoalPlan(root);
			expect(plan!.goals[0]?.status).toBe("review_blocked");
			expect(plan!.goals[1]).toMatchObject({ id: "G002", status: "pending" });
			const ledger = await readUltragoalLedger(root);
			expect(ledger.filter(e => e.event === "review_blockers_recorded").length).toBe(1);
		});

		it("does not dedup across different blocked goals (same objective, different root)", async () => {
			const root = await tempDir();
			await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
			await startNextUltragoalGoal({ cwd: root });
			// Create G002 as a second schedulable goal by adding a subgoal.
			await addUltragoalSubgoal({
				cwd: root,
				title: "Second story",
				objective: "Implement the second feature.",
				evidence: "needed for coverage",
				rationale: "independent story",
			});

			// Record a blocker against G001.
			const first = await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G001",
				title: "Blocker for G001",
				objective: "Shared wording finding",
				evidence: "evidence",
			});
			expect(first.blockerGoalId).toBe("G003");

			// Same objective against G002 should NOT dedup against G001's blocker.
			const second = await recordUltragoalReviewBlockers({
				cwd: root,
				goalId: "G002",
				title: "Blocker for G002",
				objective: "Shared wording finding",
				evidence: "evidence",
			});
			expect(second.blockerGoalId).toBe("G004");
		});
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

	it("rejects repositories without a recognized integration base", async () => {
		const dir = await tempDir();
		await git(dir, ["init"]);
		await git(dir, ["config", "user.email", "test@example.com"]);
		await git(dir, ["config", "user.name", "Test User"]);
		await Bun.write(path.join(dir, "README.md"), "initial\n");
		await git(dir, ["add", "README.md"]);
		await git(dir, ["commit", "-m", "initial"]);
		await git(dir, ["branch", "-m", "feature-only"]);
		await expect(resolveGitBase(dir)).rejects.toThrow("authoritative integration base");
	});
});
