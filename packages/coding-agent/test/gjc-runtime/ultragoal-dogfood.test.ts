import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deflateSync } from "node:zlib";

import {
	createUltragoalPlan,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let savedSessionId: string | undefined;

afterEach(async () => {
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
	if (savedSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = savedSessionId;
});

beforeAll(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-dogfood-"));
	tempRoots.push(dir);
	return dir;
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
		for (let x = 0; x < width; x++) {
			const pixel = row + 1 + x * 3;
			raw[pixel] = mode === "gradient" ? (x * 3 + y * 5) % 256 : 7;
			raw[pixel + 1] = mode === "gradient" ? (x * 7 + y * 11) % 256 : 7;
			raw[pixel + 2] = mode === "gradient" ? (x * 13 + y * 17) % 256 : 7;
		}
	}
	const idat = pngChunk("IDAT", deflateSync(raw));
	const padding = idat.length < 4096 ? pngChunk("tEXt", Buffer.alloc(4096 - idat.length, 0)) : Buffer.alloc(0);
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), idat, padding, pngChunk("IEND")]);
}

function browserTranscript(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		surface: "web",
		tool: "browser",
		actions: [
			{ timestamp: 1000, type: "goto", url: "http://127.0.0.1:4173/ultragoal-dogfood" },
			{ timestamp: 1010, type: "click", selector: "button[data-testid='run-story']" },
			{ timestamp: 1020, type: "assert", selector: "text/Ultragoal dogfood complete" },
		],
		assertions: [{ timestamp: 1030, selector: "text/Ultragoal dogfood complete", status: "passed" }],
	};
}

async function writeDogfoodArtifacts(
	root: string,
	options: { screenshotMode?: "gradient" | "solid"; recordedStdout?: string } = {},
): Promise<void> {
	await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
	await Bun.write(path.join(root, "artifacts", "browser-run.json"), JSON.stringify(browserTranscript()));
	await Bun.write(
		path.join(root, "artifacts", "gui-screenshot.png"),
		syntheticPng(320, 180, options.screenshotMode ?? "gradient"),
	);
	await Bun.write(
		path.join(root, "artifacts", "adversarial-report.txt"),
		"adversarial dogfood evidence: invalid input was rejected\n",
	);
	await Bun.write(
		path.join(root, "artifacts", "cli-replay.json"),
		JSON.stringify({
			schemaVersion: 1,
			kind: "cli-replay",
			replaySafe: true,
			command: ["bun", "-e", 'console.log("ultragoal-cli-ok")'],
			recordedStdout: options.recordedStdout ?? "ultragoal-cli-ok\n",
		}),
	);
}

function qualityGate(): Record<string, unknown> {
	return {
		criticReview: {
			verdict: "OKAY",
			evidence: "critic approved the final aggregate dogfood completion",
			blockers: [],
		},
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
			evidence: "dogfood gate drove a web surface artifact bundle and replayed the CLI argv command",
			e2eCommands: ["gjc ultragoal checkpoint --status complete dogfood"],
			redTeamCommands: ["bun -e console.log ultragoal-cli-ok replayed by the gate"],
			artifactRefs: [
				{
					id: "browser-run",
					kind: "browser-automation",
					path: "artifacts/browser-run.json",
					description: "Valid browser automation transcript for the web surface",
				},
				{
					id: "gui-screenshot",
					kind: "screenshot",
					path: "artifacts/gui-screenshot.png",
					description: "Non-uniform screenshot captured from the web surface",
				},
				{
					id: "cli-replay",
					kind: "command-replay",
					path: "artifacts/cli-replay.json",
					description: "Runtime argv replay record for the deterministic CLI surface",
				},
				{
					id: "adversarial-report",
					kind: "failure-mode-test",
					path: "artifacts/adversarial-report.txt",
					description: "Adversarial result artifact for contract coverage",
				},
			],
			contractCoverage: [
				{
					id: "contract-web",
					contractRef: "AC-26:web",
					obligation: "The red-team gate proves a browser/web surface with structural live artifacts",
					status: "covered",
					surfaceEvidenceRefs: ["surface-web"],
					adversarialCaseRefs: ["case-invalid-input"],
				},
				{
					id: "contract-cli",
					contractRef: "AC-26:cli",
					obligation: "The red-team gate replays the deterministic CLI argv command and matches recorded stdout",
					status: "covered",
					surfaceEvidenceRefs: ["surface-cli"],
					adversarialCaseRefs: ["case-invalid-input"],
				},
			],
			surfaceEvidence: [
				{
					id: "surface-web",
					surface: "web",
					contractRef: "AC-26:web",
					invocation: "Browser automation opened the dogfood page and asserted the visible success state",
					verdict: "passed",
					artifactRefs: ["browser-run", "gui-screenshot"],
				},
				{
					id: "surface-cli",
					surface: "cli",
					contractRef: "AC-26:cli",
					invocation: 'Runtime replay of ["bun","-e","console.log(\\"ultragoal-cli-ok\\")"]',
					verdict: "passed",
					artifactRefs: ["cli-replay"],
				},
			],
			adversarialCases: [
				{
					id: "case-invalid-input",
					contractRef: "AC-26",
					scenario: "Tampered live evidence is supplied to the hardened gate",
					expectedBehavior: "The gate rejects blank screenshots and mismatched CLI stdout",
					verdict: "passed",
					artifactRefs: ["adversarial-report"],
				},
			],
			blockers: [],
		},
		iteration: {
			status: "passed",
			evidence: "the completion loop was rerun with no remaining blockers",
			fullRerun: true,
			rerunCommands: ["focused ultragoal dogfood gate"],
			blockers: [],
		},
	};
}

async function checkpoint(root: string): Promise<{ status: number; stdout?: string; stderr?: string }> {
	await createUltragoalPlan({ cwd: root, brief: "Dogfood hardened live red-team gate" });
	await startNextUltragoalGoal({ cwd: root });
	return runNativeUltragoalCommand(
		[
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"dogfood live web plus cli replay gate",
			"--quality-gate-json",
			JSON.stringify(qualityGate()),
		],
		root,
	);
}

describe("ultragoal live red-team dogfood gate", () => {
	it("accepts real web artifacts plus replayed CLI evidence and rejects tampering", async () => {
		const passingRoot = await tempDir();
		await writeDogfoodArtifacts(passingRoot);
		const passing = await checkpoint(passingRoot);
		expect(passing.status, passing.stderr).toBe(0);

		const blankScreenshotRoot = await tempDir();
		await writeDogfoodArtifacts(blankScreenshotRoot, { screenshotMode: "solid" });
		const blankScreenshot = await checkpoint(blankScreenshotRoot);
		expect(blankScreenshot.status).toBe(1);
		expect(blankScreenshot.stderr).toContain("must be non-uniform");

		const wrongStdoutRoot = await tempDir();
		await writeDogfoodArtifacts(wrongStdoutRoot, { recordedStdout: "not-ultragoal-cli-ok\n" });
		const wrongStdout = await checkpoint(wrongStdoutRoot);
		expect(wrongStdout.status).toBe(1);
		expect(wrongStdout.stderr).toContain("recordedStdout");
	});
});
