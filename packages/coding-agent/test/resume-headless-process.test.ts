import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ResumeProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

type ResumeProcessResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const headlessResumeError = "--resume requires an interactive terminal; use --resume <id>.\n";

async function waitForExit(proc: ResumeProcess, timeoutMs: number): Promise<number> {
	const timedOut = Promise.withResolvers<never>();
	const timeout = setTimeout(
		() => timedOut.reject(new Error(`CLI did not exit within ${timeoutMs}ms while stdin remained open`)),
		timeoutMs,
	);
	try {
		return await Promise.race([proc.exited, timedOut.promise]);
	} finally {
		clearTimeout(timeout);
	}
}

async function runHeadlessBareResume(args: string[]): Promise<ResumeProcessResult> {
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1", PI_NO_TITLE: "1" },
	});

	try {
		const exitCode = await waitForExit(proc, 5_000);
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { exitCode, stdout, stderr };
	} finally {
		if (proc.exitCode === null) {
			try {
				proc.kill();
			} catch {
				// The process may have exited between the status check and kill.
			}
			await proc.exited;
		}
	}
}

describe("headless bare resume", () => {
	it("rejects --resume without waiting for an open stdin pipe or emitting protocol output", async () => {
		const result = await runHeadlessBareResume(["--resume"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe(headlessResumeError);
		expect(result.stdout).toBe("");
	}, 10_000);

	it("gives the exact root resume alias the same headless guidance", async () => {
		const result = await runHeadlessBareResume(["resume"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe(headlessResumeError);
		expect(result.stdout).toBe("");
	}, 10_000);

	it("preserves version and help fast paths when resume is also present", async () => {
		for (const versionFlag of ["--version", "-v"]) {
			const version = await runHeadlessBareResume(["--resume", versionFlag]);
			expect(version.exitCode).toBe(0);
			expect(version.stdout).toMatch(/^gjc\/\d+\.\d+\.\d+\n$/);
			expect(version.stderr).toBe("");
		}

		const help = await runHeadlessBareResume(["--resume", "--help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("USAGE");
		expect(help.stderr).toBe("");
	}, 15_000);

	it("preserves export routing instead of opening the resume picker", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-export-"));
		const missing = path.join(root, "missing.jsonl");
		const output = path.join(root, "export.html");
		try {
			const result = await runHeadlessBareResume(["--resume", "--export", missing, output]);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).not.toContain(headlessResumeError.trim());
			expect(result.stdout).toContain(`Exported to: ${output}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 10_000);
});
