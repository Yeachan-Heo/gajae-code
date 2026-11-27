import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

describe("Rust scope guard", () => {
	test("allowlists the Gajae-Code SDK Rust core with a native transport rationale", async () => {
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
		expect(stdout).toContain("crates/gjc-sdk");
		expect(stdout).toContain("Gajae-Code SDK Rust core");
		expect(stdout).toContain("loopback WebSocket transport");
		expect(stdout).toContain("planned N-API integration");
	});

	test("excludes untracked artifacts/ directory from Rust source checks", async () => {
		// Create a temporary Rust file in artifacts/ to verify it's ignored
		const artifactsRsPath = path.join(repoRoot, "artifacts", "test-scope-guard.rs");
		await Bun.write(artifactsRsPath, "fn main() { }\n");

		try {
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

			// The script should pass despite the Rust file in artifacts/
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Rust scope check passed");
			expect(stdout).not.toContain("artifacts/test-scope-guard.rs");
		} finally {
			// Clean up the temporary file
			await Bun.file(artifactsRsPath).delete?.();
		}
	});
});
