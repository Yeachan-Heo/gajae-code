/**
 * CLI contract tests for `gjc quick-lane` (issue #3984).
 *
 * Spawns the real CLI as a child process and asserts the action-first surface:
 * `classify` is required, task text is required, parse failures exit 2 with
 * usage rendered, and the command is advertised from root fast help.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

// import.meta.dir is packages/coding-agent/test/quick-lane; four ".." steps
// reach the repository root (quick-lane -> test -> coding-agent -> packages -> root).
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

interface CliRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	combined: string;
}

function runCli(args: string[]): CliRun {
	const result = Bun.spawnSync(["bun", cliEntry, ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	return { exitCode: result.exitCode, stdout, stderr, combined: `${stdout}\n${stderr}` };
}

describe("gjc quick-lane CLI contract (issue #3984)", () => {
	it("classifies a bounded task with concrete anchors into the quick lane", () => {
		const run = runCli(["quick-lane", "classify", "add validation to processKeywordDetector"]);
		expect(run.exitCode, run.combined).toBe(0);
		expect(run.stdout, run.combined).toContain("lane: quick");
		expect(run.stdout, run.combined).toContain("reasons:");
	});

	it("renders a JSON decision with --json", () => {
		const run = runCli(["quick-lane", "classify", "--json", "fix src/hooks/bridge.ts"]);
		expect(run.exitCode, run.combined).toBe(0);
		const parsed = JSON.parse(run.stdout) as { lane: string };
		expect(parsed.lane, run.combined).toBe("quick");
	});

	it("routes anchorless tasks to the deep lane with exclusions", () => {
		const run = runCli(["quick-lane", "classify", "team make it better"]);
		expect(run.exitCode, run.combined).toBe(0);
		expect(run.stdout, run.combined).toContain("lane: deep");
		expect(run.stdout, run.combined).toContain("exclusions:");
	});

	it("fails with a usage error when no action is given", () => {
		const run = runCli(["quick-lane"]);
		expect(run.exitCode, run.combined).toBe(2);
		expect(run.stderr, run.combined).toContain("Missing required argument: action");
		expect(run.stdout, run.combined).toContain("classify");
	});

	it("rejects an unknown action with a usage error", () => {
		const run = runCli(["quick-lane", "bogus", "some task"]);
		expect(run.exitCode, run.combined).toBe(2);
		expect(run.stderr, run.combined).toContain("Expected action to be one of: classify");
		expect(run.stderr, run.combined).toContain("classify");
	});

	it("requires task text after the classify action", () => {
		const run = runCli(["quick-lane", "classify"]);
		expect(run.exitCode, run.combined).toBe(2);
		expect(run.stderr, run.combined).toContain("Missing required argument: text");
	});

	it("documents the classify action and examples in command help", () => {
		for (const args of [
			["quick-lane", "--help"],
			["quick-lane", "classify", "--help"],
		]) {
			const run = runCli(args);
			expect(run.exitCode, run.combined).toBe(0);
			expect(run.stdout, run.combined).toContain("classify");
			expect(run.stdout, run.combined).toContain(
				'$ gjc quick-lane classify "add validation to processKeywordDetector"',
			);
			expect(run.stdout, run.combined).toContain('$ gjc quick-lane classify --json "fix src/hooks/bridge.ts"');
		}
	});

	it("advertises quick-lane in root fast help", () => {
		const run = runCli(["--help"]);
		expect(run.exitCode, run.combined).toBe(0);
		expect(run.combined).toContain("quick-lane");
		expect(run.combined).toContain("Classify a task into quick lane or deep path");
	});
});
