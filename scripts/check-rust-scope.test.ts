import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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

	test("admits the native Tauri crate but rejects sibling Rust and a mismatched package", async () => {
		const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-rust-scope-"));
		const manifest = path.join(fixture, "packages/desktop/src-tauri/Cargo.toml");
		const sibling = path.join(fixture, "packages/desktop/src/business.rs");
		const run = async () => {
			const child = Bun.spawn([process.execPath, "scripts/check-rust-scope.ts"], {
				cwd: fixture,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		};
		try {
			await Bun.write(path.join(fixture, "scripts/check-rust-scope.ts"), Bun.file(path.join(repoRoot, "scripts/check-rust-scope.ts")));
			await Bun.write(manifest, '[package]\nname = "gjc-desktop"\n');
			await Bun.write(path.join(fixture, "packages/desktop/src-tauri/src/main.rs"), "fn main() {}\n");
			const allowed = await run();
			expect(allowed.exitCode).toBe(0);
			expect(allowed.stderr).toBe("");
			expect(allowed.stdout).toContain("packages/desktop/src-tauri");

			await Bun.write(sibling, "fn business_logic() {}\n");
			const outside = await run();
			expect(outside.exitCode).toBe(1);
			expect(outside.stderr).toContain("outside allowed native/performance-critical directories: packages/desktop/src/business.rs");
			await Bun.file(sibling).delete();

			await Bun.write(manifest, '[package]\nname = "business-logic"\n');
			const mismatch = await run();
			expect(mismatch.exitCode).toBe(1);
			expect(mismatch.stderr).toContain("expected gjc-desktop, found business-logic");
		} finally {
			await fs.rm(fixture, { recursive: true, force: true });
		}
	});
});
