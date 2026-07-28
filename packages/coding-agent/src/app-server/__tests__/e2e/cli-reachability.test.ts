import { expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");

test("app-server CLI command is reachable", async () => {
	const child = Bun.spawn(["bun", "packages/coding-agent/src/cli.ts", "app-server", "--help"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain("app-server");
}, 60_000);
