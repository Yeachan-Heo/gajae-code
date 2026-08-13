import { expect, test } from "bun:test";

// Issue #4420: The root artifacts/ directory is untracked test working space.
// No file under artifacts/ may be committed to the repository.
// Deterministic test fixtures belong in the appropriate package test fixtures dir.
test("no files under artifacts/ are tracked by git", async () => {
	const result = Bun.spawnSync(["git", "ls-files", "artifacts/"], {
		cwd: import.meta.dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	const output = new TextDecoder().decode(result.stdout).trim();
	if (output.length > 0) {
		const tracked = output.split("\n");
		throw new Error(
			`artifacts/ must be fully untracked (issue #4420), but ${tracked.length} file(s) are tracked:\n` +
				tracked.map((f) => `  ${f}`).join("\n") +
				"\nMove deterministic test fixtures to the appropriate package test fixtures dir instead.",
		);
	}
});
