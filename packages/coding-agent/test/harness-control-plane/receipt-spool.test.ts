import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type FinalizeChecks, runFinalize, type ValidationCommandSpec } from "../../src/harness-control-plane/finalize";
import {
	appendReceiptToSpool,
	RECEIPT_SPOOL_DIR_ENV,
	RECEIPT_SPOOL_FILENAME,
	type ReceiptSpoolRecord,
	readHighestReceiptSpoolCursor,
	receiptSpoolFullScanCountForTesting,
	resetReceiptSpoolCursorCacheForTesting,
	withReceiptSpoolDir,
} from "../../src/harness-control-plane/receipt-spool";
import { type CompletionEvidence, validateReceipt } from "../../src/harness-control-plane/receipts";
import { readReceiptIndex } from "../../src/harness-control-plane/storage";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const DOTENV_PROBE = path.join(import.meta.dir, "..", "fixtures", "receipt-spool-dotenv-probe.ts");

let root: string;
let spoolDir: string;
const SID = "spool-session";

function checks(): FinalizeChecks {
	return {
		async runValidation(spec: ValidationCommandSpec) {
			return { exactCommand: spec.command, cwd: "/ws", exitStatus: 0, pass: true };
		},
		async resolveCommit() {
			return "abc123";
		},
		async commitOnBranch() {
			return true;
		},
		async prOrIssue() {
			return { prUrl: "https://example.test/pull/545", issueArtifact: null };
		},
	};
}

async function readSpoolRecords(): Promise<ReceiptSpoolRecord[]> {
	const raw = await readFile(path.join(spoolDir, RECEIPT_SPOOL_FILENAME), "utf8");
	const records: ReceiptSpoolRecord[] = [];
	for (const line of raw.trim().split("\n")) {
		if (!line) continue;
		try {
			records.push(JSON.parse(line) as ReceiptSpoolRecord);
		} catch {
			// Crash-torn or pre-existing malformed lines are skipped by the consumer contract.
		}
	}
	return records;
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "harness-spool-root-"));
	spoolDir = await mkdtemp(path.join(tmpdir(), "harness-receipt-spool-"));
});

afterEach(async () => {
	delete process.env[RECEIPT_SPOOL_DIR_ENV];
	await rm(root, { recursive: true, force: true });
	await rm(spoolDir, { recursive: true, force: true });
});

describe("harness receipt JSONL spool exporter", () => {
	it("is disabled when no spool directory is configured", async () => {
		delete process.env[RECEIPT_SPOOL_DIR_ENV];

		const res = await runFinalize({
			root,
			sessionId: SID,
			workspace: "/ws",
			branch: "feat/545",
			requireTests: true,
			requireCommit: true,
			requirePr: true,
			validationCommands: [{ name: "test", command: "bun test" }],
			checks: checks(),
		});

		expect(res.completed).toBe(true);
		expect(await Bun.file(path.join(spoolDir, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
	});

	it("exports persisted receipts as append-only {cursor,envelope} JSONL", async () => {
		process.env[RECEIPT_SPOOL_DIR_ENV] = spoolDir;

		const res = await runFinalize({
			root,
			sessionId: SID,
			workspace: "/ws",
			branch: "feat/545",
			requireTests: true,
			requireCommit: true,
			requirePr: true,
			validationCommands: [{ name: "test", command: "bun test" }],
			checks: checks(),
		});

		expect(res.completed).toBe(true);
		const records = await readSpoolRecords();
		expect(records.map(record => record.cursor)).toEqual(["000000000001", "000000000002"]);
		expect(records.map(record => record.envelope.family)).toEqual(["validation", "completion"]);
		expect(records.every(record => validateReceipt(record.envelope).valid)).toBe(true);
		expect(Object.keys(records[1])).toEqual(["cursor", "envelope"]);

		const completions = await readReceiptIndex(root, SID, "completion");
		expect(completions).toHaveLength(1);
		const persistedCompletion = JSON.parse(
			await readFile(completions[0].path, "utf8"),
		) as (typeof records)[1]["envelope"];
		expect(records[1].envelope).toEqual(persistedCompletion);
		expect((records[1].envelope.evidence as CompletionEvidence).finalLifecycle).toBe("completed");
	});

	it("resumes the next cursor from the highest valid existing spool cursor", async () => {
		process.env[RECEIPT_SPOOL_DIR_ENV] = spoolDir;
		await writeFile(
			path.join(spoolDir, RECEIPT_SPOOL_FILENAME),
			'{"cursor":"000000000041","envelope":{"ignored":true}}\nnot-json\n{"cursor":"000000000009"}\n',
			"utf8",
		);

		expect(await readHighestReceiptSpoolCursor(spoolDir)).toBe(41n);
		const res = await runFinalize({
			root,
			sessionId: SID,
			workspace: "/ws",
			branch: "feat/545",
			requireTests: true,
			requireCommit: true,
			requirePr: true,
			validationCommands: [{ name: "resume", command: "true" }],
			checks: checks(),
		});

		expect(res.completed).toBe(true);
		const records = await readSpoolRecords();
		expect(records.at(-2)?.cursor).toBe("000000000042");
		expect(records.at(-1)?.cursor).toBe("000000000043");
		expect(records.at(-1)?.envelope.family).toBe("completion");
	});

	it("serializes concurrent appends with unique monotonic cursors", async () => {
		process.env[RECEIPT_SPOOL_DIR_ENV] = spoolDir;

		const runs = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				runFinalize({
					root,
					sessionId: `spool-concurrent-${index}`,
					workspace: "/ws",
					branch: "feat/545",
					requireTests: true,
					requireCommit: true,
					requirePr: true,
					validationCommands: [{ name: `test-${index}`, command: "true" }],
					checks: checks(),
				}),
			),
		);

		expect(runs.every(result => result.completed)).toBe(true);
		const records = await readSpoolRecords();
		expect(records.map(record => record.cursor)).toEqual(
			Array.from({ length: 16 }, (_, index) => String(index + 1).padStart(12, "0")),
		);
		expect(new Set(records.map(record => record.cursor)).size).toBe(16);
		expect(records.every(record => validateReceipt(record.envelope).valid)).toBe(true);
	});

	it("keeps per-request spool directories isolated without mutating process env", async () => {
		const first = await mkdtemp(path.join(tmpdir(), "harness-receipt-spool-a-"));
		const second = await mkdtemp(path.join(tmpdir(), "harness-receipt-spool-b-"));
		try {
			process.env[RECEIPT_SPOOL_DIR_ENV] = first;
			await withReceiptSpoolDir(second, async () => {
				expect(process.env[RECEIPT_SPOOL_DIR_ENV]).toBe(first);
				const res = await runFinalize({
					root,
					sessionId: "spool-scoped",
					workspace: "/ws",
					branch: "feat/545",
					requireTests: true,
					requireCommit: true,
					requirePr: true,
					validationCommands: [{ name: "scoped", command: "true" }],
					checks: checks(),
				});
				expect(res.completed).toBe(true);
			});

			expect(await Bun.file(path.join(first, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
			const raw = await readFile(path.join(second, RECEIPT_SPOOL_FILENAME), "utf8");
			const records = raw
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as ReceiptSpoolRecord);
			expect(records.map(record => record.cursor)).toEqual(["000000000001", "000000000002"]);
		} finally {
			await rm(first, { recursive: true, force: true });
			await rm(second, { recursive: true, force: true });
		}
	});

	it("exports directly appended native receipt envelopes", async () => {
		process.env[RECEIPT_SPOOL_DIR_ENV] = spoolDir;
		const res = await runFinalize({
			root,
			sessionId: "spool-direct-source",
			workspace: "/ws",
			branch: "feat/545",
			requireTests: true,
			requireCommit: true,
			requirePr: true,
			validationCommands: [{ name: "direct-source", command: "true" }],
			checks: checks(),
		});
		expect(res.completed).toBe(true);

		const records = await readSpoolRecords();
		const completion = records.at(-1)?.envelope;
		expect(completion?.family).toBe("completion");
		const direct = await appendReceiptToSpool(spoolDir, completion!);
		expect(direct.cursor).toBe("000000000003");

		const reread = await readSpoolRecords();
		expect(reread.at(-1)?.envelope).toEqual(completion);
		expect(Object.keys(reread.at(-1) ?? {})).toEqual(["cursor", "envelope"]);
	});

	it("smokes the installed package import path with a configured receipt spool", async () => {
		const script = `
import { runFinalize } from "@gajae-code/coding-agent/harness-control-plane/finalize";
process.env.GJC_RECEIPT_SPOOL_DIR = ${JSON.stringify(spoolDir)};
const checks = {
	async runValidation(spec) {
		return { exactCommand: spec.command, cwd: "/ws", exitStatus: 0, pass: true };
	},
	async resolveCommit() {
		return "abc123";
	},
	async commitOnBranch() {
		return true;
	},
	async prOrIssue() {
		return { prUrl: "https://example.test/pull/545", issueArtifact: null };
	},
};
const result = await runFinalize({
	root: ${JSON.stringify(root)},
	sessionId: "spool-installed",
	workspace: "/ws",
	branch: "feat/545",
	requireTests: true,
	requireCommit: true,
	requirePr: true,
	validationCommands: [{ name: "smoke", command: "true" }],
	checks,
});
if (!result.completed) {
	console.error(JSON.stringify(result));
	process.exit(1);
}
`;
		const proc = Bun.spawnSync(["bun", "-e", script], {
			cwd: repoRoot,
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(proc.stderr.toString()).toBe("");
		expect(proc.exitCode ?? 0).toBe(0);
		const records = await readSpoolRecords();
		expect(records.map(record => record.cursor)).toEqual(["000000000001", "000000000002"]);
		expect(records[1].envelope.family).toBe("completion");
		expect((records[1].envelope.evidence as CompletionEvidence).finalLifecycle).toBe("completed");
	});
	it("uses the cursor cache until the spool is externally changed", async () => {
		resetReceiptSpoolCursorCacheForTesting();
		const spoolFile = path.join(spoolDir, RECEIPT_SPOOL_FILENAME);
		await writeFile(spoolFile, '{"cursor":"000000000007"}\n', "utf8");

		expect(await readHighestReceiptSpoolCursor(spoolDir)).toBe(7n);
		expect(receiptSpoolFullScanCountForTesting()).toBe(1);
		expect(await readHighestReceiptSpoolCursor(spoolDir)).toBe(7n);
		expect(receiptSpoolFullScanCountForTesting()).toBe(1);

		await writeFile(spoolFile, '{"cursor":"000000000007"}\n{"cursor":"000000000008"}\n', "utf8");
		expect(await readHighestReceiptSpoolCursor(spoolDir)).toBe(8n);
		expect(receiptSpoolFullScanCountForTesting()).toBe(2);
	});
});

function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}
	delete env.NODE_ENV;
	delete env[RECEIPT_SPOOL_DIR_ENV];
	for (const [name, value] of Object.entries(extra)) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	return env;
}

async function runDotenvProbe(
	cwd: string,
	sessionRoot: string,
	env: Record<string, string>,
): Promise<{ exitCode: number; completed: boolean; stderr: string }> {
	const proc = Bun.spawn([process.execPath, DOTENV_PROBE, sessionRoot], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	const marker = stdout
		.split("\n")
		.map(line => line.trim())
		.find(line => line.startsWith("RECEIPT_SPOOL_PROBE "));
	if (exitCode !== 0 || !marker) {
		throw new Error(`probe failed (${exitCode}): ${stderr || stdout}`);
	}
	const parsed = JSON.parse(marker.slice("RECEIPT_SPOOL_PROBE ".length)) as { completed: boolean };
	return { exitCode, completed: parsed.completed, stderr };
}

describe("receipt spool project dotenv and symlink", () => {
	const dirs: string[] = [];

	async function makeDir(prefix: string): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		delete process.env[RECEIPT_SPOOL_DIR_ENV];
		await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	});

	it("does not spool receipts into a project dotenv directory", async () => {
		const repo = await makeDir("harness-spool-repo-");
		const attacker = await makeDir("harness-spool-attacker-");
		const sessionRoot = await makeDir("harness-spool-session-");
		const home = await makeDir("harness-spool-home-");
		await writeFile(path.join(repo, ".env"), `${RECEIPT_SPOOL_DIR_ENV}=${attacker}\n`);

		const result = await runDotenvProbe(repo, sessionRoot, childEnv({ HOME: home, GJC_CODING_AGENT_DIR: home }));
		expect(result.completed).toBe(true);
		expect(await Bun.file(path.join(attacker, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
	});

	it("keeps a shell spool directory that disagrees with the project dotenv", async () => {
		const repo = await makeDir("harness-spool-repo-");
		const attacker = await makeDir("harness-spool-attacker-");
		const operator = await makeDir("harness-spool-operator-");
		const sessionRoot = await makeDir("harness-spool-session-");
		const home = await makeDir("harness-spool-home-");
		await writeFile(path.join(repo, ".env"), `${RECEIPT_SPOOL_DIR_ENV}=${attacker}\n`);

		const result = await runDotenvProbe(
			repo,
			sessionRoot,
			childEnv({ HOME: home, GJC_CODING_AGENT_DIR: home, [RECEIPT_SPOOL_DIR_ENV]: operator }),
		);
		expect(result.completed).toBe(true);
		expect(await Bun.file(path.join(operator, RECEIPT_SPOOL_FILENAME)).exists()).toBe(true);
		expect(await Bun.file(path.join(attacker, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
	});

	it("does not adopt a shell spool directory equal to the project dotenv", async () => {
		const repo = await makeDir("harness-spool-repo-");
		const shared = await makeDir("harness-spool-shared-");
		const sessionRoot = await makeDir("harness-spool-session-");
		const home = await makeDir("harness-spool-home-");
		await writeFile(path.join(repo, ".env"), `${RECEIPT_SPOOL_DIR_ENV}=${shared}\n`);

		const result = await runDotenvProbe(
			repo,
			sessionRoot,
			childEnv({ HOME: home, GJC_CODING_AGENT_DIR: home, [RECEIPT_SPOOL_DIR_ENV]: shared }),
		);
		expect(result.completed).toBe(true);
		expect(await Bun.file(path.join(shared, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
	});

	it("does not adopt a shell spool directory when the project declaration is dynamic", async () => {
		const repo = await makeDir("harness-spool-repo-");
		const attacker = await makeDir("harness-spool-attacker-");
		const operator = await makeDir("harness-spool-operator-");
		const sessionRoot = await makeDir("harness-spool-session-");
		const home = await makeDir("harness-spool-home-");
		await writeFile(path.join(repo, ".env"), `ATTACK=${attacker}\n${RECEIPT_SPOOL_DIR_ENV}=$ATTACK\n`);

		const result = await runDotenvProbe(
			repo,
			sessionRoot,
			childEnv({
				HOME: home,
				GJC_CODING_AGENT_DIR: home,
				ATTACK: attacker,
				[RECEIPT_SPOOL_DIR_ENV]: operator,
			}),
		);
		expect(result.completed).toBe(true);
		expect(await Bun.file(path.join(operator, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
		expect(await Bun.file(path.join(attacker, RECEIPT_SPOOL_FILENAME)).exists()).toBe(false);
	});

	it.skipIf(process.platform === "win32" || fsConstants.O_NOFOLLOW === undefined)(
		"does not append receipts through a spool.jsonl symlink",
		async () => {
			const sessionRoot = await makeDir("harness-spool-session-");
			const dir = await makeDir("harness-spool-link-");
			const outside = path.join(sessionRoot, "outside.txt");
			await writeFile(outside, "SAFE\n");
			await symlink(outside, path.join(dir, RECEIPT_SPOOL_FILENAME));
			process.env[RECEIPT_SPOOL_DIR_ENV] = dir;

			await expect(
				runFinalize({
					root: sessionRoot,
					sessionId: SID,
					workspace: "/ws",
					branch: "feat/545",
					requireTests: true,
					requireCommit: true,
					requirePr: true,
					validationCommands: [{ name: "symlink", command: "true" }],
					checks: checks(),
				}),
			).rejects.toThrow();
			expect(await readFile(outside, "utf8")).toBe("SAFE\n");
		},
	);

	it.skipIf(process.platform === "win32")(
		"tightens an existing spool directory and file to owner-only mode",
		async () => {
			const sessionRoot = await makeDir("harness-spool-session-");
			const dir = await makeDir("harness-spool-mode-");
			await chmod(dir, 0o755);
			const spoolFile = path.join(dir, RECEIPT_SPOOL_FILENAME);
			await writeFile(spoolFile, "");
			await chmod(spoolFile, 0o666);
			process.env[RECEIPT_SPOOL_DIR_ENV] = dir;

			const res = await runFinalize({
				root: sessionRoot,
				sessionId: SID,
				workspace: "/ws",
				branch: "feat/545",
				requireTests: true,
				requireCommit: true,
				requirePr: true,
				validationCommands: [{ name: "mode", command: "true" }],
				checks: checks(),
			});

			expect(res.completed).toBe(true);
			expect((await lstat(dir)).mode & 0o777).toBe(0o700);
			expect((await stat(spoolFile)).mode & 0o777).toBe(0o600);
		},
	);
});
