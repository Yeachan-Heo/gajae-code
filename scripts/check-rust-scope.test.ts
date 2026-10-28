import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const repoRoot = path.join(import.meta.dir, "..");

describe("Rust scope guard", () => {
	test("allowlists the Gajae-Code SDK Rust core with a native transport rationale", async () => {
		const testDir = path.join(os.tmpdir(), `check-rust-scope-test-${Date.now()}`);
		await fs.mkdir(testDir, { recursive: true });

		try {
			// Create minimal crate structure for the allowlist entry to be found
			const crateDir = path.join(testDir, "crates", "gjc-sdk");
			await fs.mkdir(crateDir, { recursive: true });
			await Bun.write(
				path.join(crateDir, "Cargo.toml"),
				'[package]\nname = "gjc-sdk"\n',
			);

			// Create a script copy that references the temp test directory
			const scriptContent = await Bun.file(path.join(repoRoot, "scripts/check-rust-scope.ts")).text();
			const testScriptContent = scriptContent.replace(
				'const repoRoot = path.join(import.meta.dir, "..")',
				`const repoRoot = "${testDir.replace(/\\/g, "/")}";`,
			);
			const testScriptPath = path.join(testDir, "check-rust-scope.ts");
			await Bun.write(testScriptPath, testScriptContent);

			const proc = Bun.spawn(["bun", testScriptPath], {
				cwd: testDir,
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
		} finally {
			await fs.rm(testDir, { recursive: true, force: true });
		}
	});

	test("excludes untracked artifacts/ directory from Rust source checks", async () => {
		const testDir = path.join(os.tmpdir(), `check-rust-scope-test-${Date.now()}-artifacts`);
		await fs.mkdir(testDir, { recursive: true });

		try {
			// Create minimal crate structure
			const crateDir = path.join(testDir, "crates", "pi-natives");
			await fs.mkdir(crateDir, { recursive: true });
			await Bun.write(
				path.join(crateDir, "Cargo.toml"),
				'[package]\nname = "pi-natives"\n',
			);

			// Create a large artifacts directory with many Rust files
			const artifactsDir = path.join(testDir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			for (let i = 0; i < 100; i++) {
				await Bun.write(
					path.join(artifactsDir, `test-${i}.rs`),
					"fn main() { }\n",
				);
			}

			// Create a script copy that references the temp test directory
			const scriptContent = await Bun.file(path.join(repoRoot, "scripts/check-rust-scope.ts")).text();
			const testScriptContent = scriptContent.replace(
				'const repoRoot = path.join(import.meta.dir, "..")',
				`const repoRoot = "${testDir.replace(/\\/g, "/")}";`,
			);
			const testScriptPath = path.join(testDir, "check-rust-scope.ts");
			await Bun.write(testScriptPath, testScriptContent);

			const proc = Bun.spawn(["bun", testScriptPath], {
				cwd: testDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			// The script should pass despite the Rust files in artifacts/
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Rust scope check passed");
			for (let i = 0; i < 100; i++) {
				expect(stdout).not.toContain(`artifacts/test-${i}.rs`);
			}
		} finally {
			await fs.rm(testDir, { recursive: true, force: true });
		}
	});
});
