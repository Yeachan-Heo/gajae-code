import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { sessionUltragoalDir } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	createUltragoalPlan,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let savedSessionId: string | undefined;

beforeAll(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

async function tempDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-computer-red-team-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
	if (savedSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = savedSessionId;
});

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`);
}

async function initRepo(root: string): Promise<void> {
	await runGit(root, ["init"]);
	await runGit(root, ["config", "user.email", "test@example.com"]);
	await runGit(root, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(root, "README.md"), "base\n");
	await runGit(root, ["add", "README.md"]);
	await runGit(root, ["commit", "-m", "base"]);
	await runGit(root, ["branch", "-M", "main"]);
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
	const typeBytes = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
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
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const offset = row + 1 + x * 3;
			raw[offset] = x % 256;
			raw[offset + 1] = y % 256;
			raw[offset + 2] = (x + y) % 256;
		}
	}
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND")]);
}

async function seedPlan(root: string): Promise<void> {
	await createUltragoalPlan({
		cwd: root,
		brief: "@goal computer gate fixture",
	});
	await runGit(root, [
		"add",
		path.relative(root, path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "goals.json")),
		path.relative(root, path.join(sessionUltragoalDir(root, TEST_SESSION_ID), "ledger.jsonl")),
	]);
	await runGit(root, ["commit", "-m", "plan"]);
	await startNextUltragoalGoal({ cwd: root });
}

function artifact(kind = "native screenshot"): Record<string, unknown> {
	return { id: "surface-proof", kind, description: "live structural native proof", path: "artifacts/native.png" };
}

const CASES = [
	"kill-switch-bypass",
	"suspended-enforcement",
	"permission-revoked",
	"display-stale",
	"out-of-bounds-drift",
	"runaway-loop-halt",
	"blast-radius",
];

function executorQa(
	overrides: {
		cases?: Record<string, unknown>[];
		artifacts?: Record<string, unknown>[];
		computerTouching?: boolean;
		surface?: string;
	} = {},
): Record<string, unknown> {
	const cases =
		overrides.cases ??
		CASES.map(id => ({
			id,
			status: "passed",
			contractRef: "computer-safety",
			scenario: `${id} adversarial scenario exercises the computer safety boundary`,
			expectedBehavior: "fail closed before unsafe desktop input can continue",
			verdict: "passed",
			artifactRefs: ["case-proof"],
		}));
	return {
		status: "passed",
		e2eStatus: "passed",
		redTeamStatus: "passed",
		evidence: "executor QA covered the requested contract with durable proof artifacts",
		e2eCommands: ["bun test fixture"],
		redTeamCommands: ["bun test fixture"],
		changedPaths: overrides.computerTouching === true ? ["crates/pi-natives/src/computer/executor.rs"] : undefined,
		computerTouching: overrides.computerTouching,
		artifactRefs: overrides.artifacts ?? [
			artifact("native screenshot"),
			{ ...artifact("native screenshot"), id: "case-proof" },
		],
		surfaceEvidence: [
			{
				id: "surface-native",
				contractRef: "computer-safety",
				surface: overrides.surface ?? "native",
				status: "passed",
				invocation: "native fixture invocation",
				verdict: "passed",
				artifactRefs: ["surface-proof"],
			},
		],
		adversarialCases: cases,
		contractCoverage: [
			{
				id: "coverage",
				contractRef: "computer-safety",
				status: "covered",
				obligation: "all mandatory computer red-team cases are covered",
				surfaceEvidenceRefs: ["surface-native"],
				adversarialCaseRefs: cases.map(row => String(row.id)),
			},
		],
		blockers: [],
	};
}

function qualityGate(qa: Record<string, unknown>): string {
	return JSON.stringify({
		architectReview: {
			architectureStatus: "CLEAR",
			productStatus: "CLEAR",
			codeStatus: "CLEAR",
			recommendation: "APPROVE",
			commands: ["review"],
			evidence: "architect review passed with no blockers",
			blockers: [],
		},
		executorQa: qa,
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
					qa: { status: "passed", sourceHash: "sha256:test-frozen-source", evidence: "qa passed", blockers: [] },
				},
			},
			rerunCommands: ["bun test fixture"],
			evidence: "targeted fixture rerun passed",
			blockers: [],
		},
		criticReview: {
			verdict: "OKAY",
			evidence: "critic approved final aggregate terminus",
			blockers: [],
		},
	});
}

async function writeQaArtifacts(root: string): Promise<void> {
	await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
	await fs.writeFile(path.join(root, "artifacts/native.png"), syntheticPng());
}

async function checkpoint(root: string, qa: Record<string, unknown>): Promise<string> {
	const result = await runNativeUltragoalCommand(
		[
			"checkpoint",
			"--goal-id",
			"G001",
			"--status",
			"complete",
			"--evidence",
			"fixture complete",
			"--quality-gate-json",
			qualityGate(qa),
		],
		root,
	);
	return (result.stderr ?? "") + (result.stdout ?? "");
}

async function seedComputerChange(
	root: string,
	file = "crates/pi-natives/src/computer/executor.rs",
	content = "// computer change\n",
): Promise<void> {
	await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
	await fs.writeFile(path.join(root, file), content);
	await runGit(root, ["add", file]);
}

describe("computer red-team fixture matrix", () => {
	it("preserves non-computer validation when unchanged", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		expect(await checkpoint(root, executorQa())).toContain("Checkpointed G001 as complete");
	});

	it("fails computer code change missing a mandatory case", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root);
		const message = await checkpoint(
			root,
			executorQa({
				computerTouching: true,
				cases: (executorQa().adversarialCases as Record<string, unknown>[]).filter(
					row => row.id !== "blast-radius",
				),
			}),
		).catch(error => String(error));
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});

	it("passes a complete mandatory computer red-team gate on a genuine computer change", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root);
		expect(await checkpoint(root, executorQa({ computerTouching: true }))).toContain("Checkpointed G001 as complete");
	});

	it("fails not_applicable on a mandatory case", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root);
		const cases = CASES.map(id => ({
			id,
			status: id === "blast-radius" ? "not_applicable" : "passed",
			contractRef: "computer-safety",
			scenario: "scenario text",
			expectedBehavior: "expected behavior",
			verdict: "passed",
			artifactRefs: ["case-proof"],
		}));
		const message = await checkpoint(root, executorQa({ cases })).catch(error => String(error));
		expect(message).toContain("not_applicable");
	});

	it("fails mandatory case with inline-only metadata artifact", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await seedComputerChange(root);
		await writeQaArtifacts(root);
		const message = await checkpoint(
			root,
			executorQa({
				computerTouching: true,
				artifacts: [
					artifact("native screenshot"),
					{
						id: "case-proof",
						kind: "native metadata",
						description: "inline only",
						inlineEvidence: "inline proof is not durable live structural evidence",
					},
				],
			}),
		).catch(error => String(error));
		// Adversarial coverage is fail-closed on path existence before the computer-specific
		// COMPUTER_REDTEAM_INLINE_ONLY taxonomy can fire (#3541/#3543).
		expect(message).toContain(
			"qualityGate executorQa.artifactRefs.case-proof adversarial coverage requires an existing non-empty file",
		);
	});

	it("passes full valid computer gate", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root);
		expect(await checkpoint(root, executorQa({ computerTouching: true }))).toContain("Checkpointed G001 as complete");
	});

	it("does not trigger from declaration-only without trusted computer change", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		const qa = executorQa({ computerTouching: false, surface: "native" });
		expect(await checkpoint(root, qa)).toContain("Checkpointed G001 as complete");
	});

	it("fails closed for any tools-index edit", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root, "packages/coding-agent/src/tools/index.ts");
		const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
			row => row.id !== "blast-radius",
		);
		const qa = executorQa({ computerTouching: false, cases, surface: "native" });
		const message = await checkpoint(root, qa).catch(error => String(error));
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});

	it("fails tools-index classification closed when full diff bytes cannot be decoded", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		const toolsIndexPath = "packages/coding-agent/src/tools/index.ts";
		await fs.mkdir(path.dirname(path.join(root, toolsIndexPath)), { recursive: true });
		const prefix = new TextEncoder().encode("export const BUILTIN_TOOLS = { ordinary: true };\n");
		await fs.writeFile(path.join(root, toolsIndexPath), new Uint8Array([...prefix, 0xff, 0x0a]));
		await runGit(root, ["add", toolsIndexPath]);
		const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
			row => row.id !== "blast-radius",
		);
		const message = await checkpoint(root, executorQa({ computerTouching: false, cases })).catch(error =>
			String(error),
		);
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});

	it("triggers from computer-specific tools index registration diff", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(
			root,
			"packages/coding-agent/src/tools/index.ts",
			`import { ComputerTool, isComputerCallable, isComputerLoadablePlatform } from "./computer";

export const BUILTIN_TOOLS = {
	...(isComputerLoadablePlatform() ? { computer: ComputerTool.createIf } : {}),
};

export function isToolAllowed(name: string): boolean {
	if (name === "computer") return isComputerCallable({});
	return true;
}
`,
		);
		const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
			row => row.id !== "blast-radius",
		);
		const message = await checkpoint(root, executorQa({ computerTouching: false, cases })).catch(error =>
			String(error),
		);
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});

	it("allows non-operational docs-only computer tiering", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root, "docs/computer-use/README.md");
		const qa = executorQa({ computerTouching: false, surface: "native" });
		expect(await checkpoint(root, qa)).toContain("Checkpointed G001 as complete");
	});

	it("fails closed for any settings-schema edit", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(
			root,
			"packages/coding-agent/src/config/settings-schema.ts",
			`export const SETTINGS = {\n\t"tools.maxInlineResultBytes": { type: "number", default: 0 },\n};\n`,
		);
		const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
			row => row.id !== "blast-radius",
		);
		const qa = executorQa({ computerTouching: false, cases, surface: "native" });
		const message = await checkpoint(root, qa).catch(error => String(error));
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});

	it("fails closed for CI path-only settings-schema edits", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "@goal computer gate fixture" });
		await startNextUltragoalGoal({ cwd: root });
		await writeQaArtifacts(root);
		const savedChangedPaths = process.env.CI_DEV_CHANGED_PATHS;
		process.env.CI_DEV_CHANGED_PATHS = "packages/coding-agent/src/config/settings-schema.ts";
		try {
			const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
				row => row.id !== "blast-radius",
			);
			const qa = executorQa({ computerTouching: false, cases, surface: "native" });
			const message = await checkpoint(root, qa).catch(error => String(error));
			expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
		} finally {
			if (savedChangedPaths === undefined) delete process.env.CI_DEV_CHANGED_PATHS;
			else process.env.CI_DEV_CHANGED_PATHS = savedChangedPaths;
		}
	});

	it("preserves CI shared-registry paths alongside unrelated Git rows", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root, "README.md", "unrelated local change\n");
		const savedChangedPaths = process.env.CI_DEV_CHANGED_PATHS;
		process.env.CI_DEV_CHANGED_PATHS = "packages/coding-agent/src/config/settings-schema.ts";
		try {
			const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
				row => row.id !== "blast-radius",
			);
			const message = await checkpoint(root, executorQa({ computerTouching: false, cases })).catch(error =>
				String(error),
			);
			expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
		} finally {
			if (savedChangedPaths === undefined) delete process.env.CI_DEV_CHANGED_PATHS;
			else process.env.CI_DEV_CHANGED_PATHS = savedChangedPaths;
		}
	});

	it("fails settings classification closed when full diff bytes cannot be decoded", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		const settingsPath = "packages/coding-agent/src/config/settings-schema.ts";
		await fs.mkdir(path.dirname(path.join(root, settingsPath)), { recursive: true });
		const prefix = new TextEncoder().encode('export const SETTINGS = {\n\t"tools.maxInlineResultBytes": ');
		await fs.writeFile(path.join(root, settingsPath), new Uint8Array([...prefix, 0xff, 0x0a, 0x7d, 0x3b, 0x0a]));
		await runGit(root, ["add", settingsPath]);
		const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
			row => row.id !== "blast-radius",
		);
		const message = await checkpoint(root, executorQa({ computerTouching: false, cases })).catch(error =>
			String(error),
		);
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});

	it("requires mandatory QA when invalid untracked bytes make inventory incomplete", async () => {
		if (process.platform === "win32") return;
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(root);
		const invalidPath = Buffer.concat([Buffer.from(root), Buffer.from(path.sep), Buffer.from([0xff])]);
		await fs.writeFile(invalidPath, "unrepresentable pathname\n");
		const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
			row => row.id !== "blast-radius",
		);
		const message = await checkpoint(root, executorQa({ computerTouching: false, cases })).catch(error =>
			String(error),
		);
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});

	it("triggers from a computer-specific settings-schema diff", async () => {
		const root = await tempDir();
		await initRepo(root);
		await seedPlan(root);
		await writeQaArtifacts(root);
		await seedComputerChange(
			root,
			"packages/coding-agent/src/config/settings-schema.ts",
			`export const SETTINGS = {\n\t"computer.enabled": { type: "boolean", default: false },\n};\n`,
		);
		const cases = (executorQa().adversarialCases as Record<string, unknown>[]).filter(
			row => row.id !== "blast-radius",
		);
		const message = await checkpoint(root, executorQa({ computerTouching: false, cases })).catch(error =>
			String(error),
		);
		expect(message).toContain("COMPUTER_REDTEAM_CASE_MISSING");
	});
});
