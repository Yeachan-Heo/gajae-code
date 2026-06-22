import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

describe("Rust scope guard", () => {
	test("allowlists the notifications SDK Rust core with a native transport rationale", async () => {
		const proc = Bun.spawn(["bun", "scripts/check-rust-scope.ts"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("crates/gjc-notifications");
		expect(stdout).toContain("Notifications SDK Rust core");
		expect(stdout).toContain("loopback WebSocket transport");
		expect(stdout).toContain("planned N-API integration");
	});
});
