import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Proves the `launch.ts` wiring, not just the classifier: a user-fixable launch refusal must
 * print its actionable message and exit non-zero WITHOUT a stack trace and WITHOUT appending a
 * durable crash record. The classifier unit tests cannot catch a regression in that wiring.
 */

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

async function runGit(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

/** A repo that does NOT git-ignore its worktree bucket, so `--worktree` refuses. */
async function unignoredRepo(): Promise<{ repo: string; agentDir: string; crashLog: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-guard-"));
	const repo = path.join(root, "repo");
	await fs.mkdir(repo, { recursive: true });
	await runGit(repo, "init", "-q");
	await runGit(repo, "config", "user.email", "test@example.com");
	await runGit(repo, "config", "user.name", "Test User");
	await Bun.write(path.join(repo, "package.json"), "{}\n");
	await runGit(repo, "add", "-A");
	await runGit(repo, "commit", "-q", "-m", "init");
	const agentDir = path.join(root, "agent");
	return { repo, agentDir, crashLog: path.join(agentDir, "gjc-crash.log") };
}

describe("launch worktree guard clean exit", () => {
	it("prints only the actionable message, exits 1, and writes no crash record", async () => {
		const { repo, agentDir, crashLog } = await unignoredRepo();

		const proc = Bun.spawn([process.execPath, CLI, "--worktree", "-p", "hi"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("worktree_bucket_not_ignored");
		expect(stderr).toContain("Safe remediation:");
		// A configuration refusal is not a crash.
		expect(stderr).not.toContain("[Uncaught Exception]");
		expect(stderr).not.toContain("crash recorded at");
		expect(stderr).not.toMatch(/^\s+at\s/m);
		expect(await Bun.file(crashLog).exists()).toBe(false);

		// The message body appears exactly once (the multi-line duplication regression).
		const remediation = stderr.split("\n").filter(line => line.startsWith("Safe remediation:"));
		expect(remediation).toHaveLength(1);

		await fs.rm(path.dirname(repo), { recursive: true, force: true });
	}, 60_000);
});
