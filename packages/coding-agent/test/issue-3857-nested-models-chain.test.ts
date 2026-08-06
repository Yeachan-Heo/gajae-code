import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

/**
 * Regression for #3857: `gjc models` from a nested GJC tool environment must not
 * start an interactive agent (and therefore must not re-spawn `gjc models`).
 */
describe("issue #3857 nested gjc models chain", () => {
	it("exits after listing when invoked as `models` under a simulated GJC session env", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-issue-3857-"));
		const agentDir = path.join(home, ".gjc", "agent");
		try {
			const result = Bun.spawnSync(["bun", cliEntry, "models"], {
				cwd: repoRoot,
				env: {
					...process.env,
					HOME: home,
					GJC_CODING_AGENT_DIR: agentDir,
					// Simulate a bash-tool child inheriting the parent agent session id.
					GJC_SESSION_ID: "session-issue-3857-nested-models",
					// Keep listing offline/local so the test does not hang on network discovery.
					GJC_NO_PTY: "1",
					GJC_NO_TITLE: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
				// Fail closed if the process ever tries to open an interactive TUI session.
				timeout: 60_000,
			});
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();
			const combined = `${stdout}\n${stderr}`;

			// Bun reports undefined (not null) for signalCode on a normal exit.
			expect(result.signalCode ?? null, combined).toBeNull();
			expect(result.exitCode, combined).toBe(0);
			// Interactive launch bootstrap must never appear for this route.
			expect(combined).not.toContain("warming workspace");
			// Listing path is non-agent: either a catalog header/row or the empty-catalog message.
			expect(
				/No models available|canonical|provider|model/i.test(combined),
				`expected model listing output, got:\n${combined}`,
			).toBe(true);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}, 90_000);

	it("does not leave a grandchild gjc process after models exits", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-issue-3857-child-"));
		const agentDir = path.join(home, ".gjc", "agent");
		const marker = `issue-3857-models-${process.pid}-${Date.now()}`;
		try {
			const result = Bun.spawnSync(["bun", cliEntry, "models", marker], {
				cwd: repoRoot,
				env: {
					...process.env,
					HOME: home,
					GJC_CODING_AGENT_DIR: agentDir,
					GJC_SESSION_ID: "session-issue-3857-grandchild-guard",
					GJC_NO_PTY: "1",
					GJC_NO_TITLE: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
				timeout: 60_000,
			});
			const combined = `${result.stdout.toString()}\n${result.stderr.toString()}`;
			expect(result.exitCode, combined).toBe(0);

			// After a clean exit there must be no still-running process whose argv contains
			// both the CLI entry and the unique search marker (would indicate a nested agent).
			const ps = Bun.spawnSync(["ps", "-ax", "-o", "pid=,command="], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const processes = ps.stdout
				.toString()
				.split("\n")
				.filter(line => line.includes(cliEntry) && line.includes(marker));
			expect(processes, processes.join("\n")).toEqual([]);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}, 90_000);
});
