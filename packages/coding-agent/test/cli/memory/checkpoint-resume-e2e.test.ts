import { describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface CliResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
const SESSION_ID = "m4-cli-session";

async function runCli(args: readonly string[], cwd: string, agentDir: string): Promise<CliResult> {
	const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
		cwd,
		env: {
			...process.env,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_SESSION_ID: undefined,
			PI_CODING_AGENT_DIR: undefined,
			PI_NO_TITLE: "1",
			NO_COLOR: "1",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	const [capturedStdout, capturedStderr, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
	return { stdout: capturedStdout, stderr: capturedStderr, exitCode };
}

async function withRoots<T>(run: (agentDir: string, unrelatedCwd: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-m4-agent-"));
	const unrelatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-m4-cwd-"));
	try {
		return await run(agentDir, unrelatedCwd);
	} finally {
		await Promise.all([
			fs.rm(agentDir, { recursive: true, force: true }),
			fs.rm(unrelatedCwd, { recursive: true, force: true }),
		]);
	}
}

function checkpointPath(agentDir: string): string {
	return path.join(agentDir, "memory", "sessions", SESSION_ID, "checkpoint.md");
}

describe("M4 memory checkpoint/resume CLI continuity", () => {
	it("writes a checkpoint and resumes the same byte-stable handoff from an unrelated process and cwd", async () => {
		await withRoots(async (agentDir, unrelatedCwd) => {
			const initialized = await runCli(["memory", "init", "--json"], agentDir, agentDir);
			expect(initialized.exitCode, initialized.stderr).toBe(0);
			expect(initialized.stderr).toBe("");

			const checkpoint = await runCli(
				[
					"memory",
					"checkpoint",
					"--goal",
					"Ship M4 continuity",
					"--task",
					"Persist the session handoff",
					"--next-step",
					"Read the handoff",
					"--next-step",
					"Continue from the checkpoint",
					"--constraint",
					"Keep the packet deterministic",
					"--decision",
					"Use the session checkpoint as the source",
					"--risk",
					"The checkpoint may become stale",
					"--session-id",
					SESSION_ID,
					"--json",
				],
				agentDir,
				agentDir,
			);
			expect(checkpoint.exitCode, checkpoint.stderr).toBe(0);
			expect(checkpoint.stderr).toBe("");
			const receipt = JSON.parse(checkpoint.stdout) as {
				readonly schemaVersion: string;
				readonly uri: string;
				readonly sessionId: string;
				readonly digest: string;
			};
			expect(receipt).toMatchObject({
				schemaVersion: "gajae.memory.checkpoint.v1",
				uri: `session://${SESSION_ID}/checkpoint.md`,
				sessionId: SESSION_ID,
			});
			expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/);
			expect(await fs.stat(checkpointPath(agentDir))).toBeDefined();

			const firstResume = await runCli(
				["memory", "resume", "--session-id", SESSION_ID, "--json"],
				agentDir,
				agentDir,
			);
			expect(firstResume.exitCode, firstResume.stderr).toBe(0);
			expect(firstResume.stderr).toBe("");
			expect(JSON.parse(firstResume.stdout)).toEqual({
				schemaVersion: "gajae.memory.handoff.v1",
				sessionId: SESSION_ID,
				goal: "Ship M4 continuity",
				task: "Persist the session handoff",
				nextSteps: ["Read the handoff", "Continue from the checkpoint"],
			});

			const secondResume = await runCli(
				["memory", "resume", "--session-id", SESSION_ID, "--json"],
				unrelatedCwd,
				agentDir,
			);
			expect(secondResume.exitCode, secondResume.stderr).toBe(0);
			expect(secondResume.stderr).toBe("");
			expect(secondResume.stdout).toBe(firstResume.stdout);
		});
	});

	it("fails closed for checkpoint writes without a session and leaves no checkpoint", async () => {
		await withRoots(async (agentDir, unrelatedCwd) => {
			const initialized = await runCli(["memory", "init", "--json"], unrelatedCwd, agentDir);
			expect(initialized.exitCode, initialized.stderr).toBe(0);

			const failed = await runCli(
				["memory", "checkpoint", "--goal", "No session write", "--task", "Must fail closed", "--json"],
				unrelatedCwd,
				agentDir,
			);
			expect(failed.exitCode).not.toBe(0);
			expect(failed.stderr).toContain("error: scope-unresolved");
			expect(JSON.parse(failed.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "scope-unresolved",
			});
			expect(
				await fs
					.stat(path.join(agentDir, "memory", "sessions", SESSION_ID, "checkpoint.md"))
					.catch(() => undefined),
			).toBeUndefined();
			expect(await fs.readdir(path.join(agentDir, "memory", "sessions"))).toEqual([]);
		});
	});

	it("returns typed not-found before a checkpoint exists", async () => {
		await withRoots(async (agentDir, unrelatedCwd) => {
			const initialized = await runCli(["memory", "init", "--json"], agentDir, agentDir);
			expect(initialized.exitCode, initialized.stderr).toBe(0);

			const failed = await runCli(
				["memory", "resume", "--session-id", SESSION_ID, "--json"],
				unrelatedCwd,
				agentDir,
			);
			expect(failed.exitCode).not.toBe(0);
			expect(failed.stderr).toContain("error: not-found");
			expect(JSON.parse(failed.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "not-found",
			});
		});
	});

	it("rejects a positional checkpoint value with invalid-input exit 2", async () => {
		await withRoots(async (agentDir, unrelatedCwd) => {
			const failed = await runCli(["memory", "checkpoint", "unexpected-value", "--json"], unrelatedCwd, agentDir);
			expect(failed.exitCode).toBe(2);
			expect(failed.stderr).toContain("error: invalid-input");
			expect(JSON.parse(failed.stdout)).toMatchObject({
				schemaVersion: "gajae.memory.error.v1",
				code: "invalid-input",
				exitCode: 2,
			});
		});
	});
});
