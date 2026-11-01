import { expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const generatedTuiReports = [
	"g003-qa-report.json",
	"g011-qa-report.json",
	"g014-qa-report.json",
	"g015-qa-report.json",
];
const untrackedPaths = ["artifacts/", ...generatedTuiReports.map(file => `packages/tui/artifacts/${file}`)];

// Issue #4420: The root artifacts/ directory is untracked test working space.
// Package-local generated TUI reports are also output, not regression inputs.
// Other package artifacts may be intentionally retained historical evidence.
// Deterministic test fixtures belong in the appropriate package test fixtures dir.
test.each(untrackedPaths)("%s is not tracked by git", candidate => {
	const result = Bun.spawnSync(["git", "ls-files", "--", candidate], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	const output = new TextDecoder().decode(result.stdout).trim();
	if (output.length > 0) {
		const tracked = output.split("\n");
		throw new Error(
			`${candidate} must be untracked, but ${tracked.length} file(s) are tracked:\n` +
				tracked.map(f => `  ${f}`).join("\n") +
				"\nMove deterministic test fixtures to the appropriate package test fixtures dir instead.",
		);
	}
});

test.each(
	generatedTuiReports.flatMap(file => [`artifacts/${file}`, `packages/tui/artifacts/${file}`]),
)("%s remains ignored when producing tests run from either working directory", candidate => {
	const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "--", candidate], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	expect(new TextDecoder().decode(result.stdout).trim()).toBe(candidate);
});
