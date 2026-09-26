#!/usr/bin/env bun

/**
 * Build the pi-natives addon with task-panic-test features, then run the
 * task-panic-to-rejection test with the prebuilt addon path in GJC_TASK_PANIC_ADDON.
 *
 * This separates the expensive native compile (which takes ~280s on 4-core runners)
 * from the 300s test timeout, allowing the build to run outside the test budget.
 * The test itself becomes fast (~10s) since it only loads the prebuilt addon.
 *
 * Usage:
 *   bun scripts/run-task-panic-test.ts
 *
 * Or from CI:
 *   bun packages/natives/scripts/run-task-panic-test.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveCargoToolchainPath } from "./rust-toolchain-path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageDir = path.join(repoRoot, "packages/natives");
const nativeDir = path.join(packageDir, "native");
const testFile = "packages/natives/test/task-panic-to-rejection.test.ts";

async function main(): Promise<void> {
	// Create temp directory for the build output
	const outputDir = await fs.mkdtemp(path.join(nativeDir, ".task-panic-test-"));
	console.log(`Building task-panic addon to ${outputDir}...`);

	try {
		const cargo = await resolveCargoToolchainPath({
			cwd: repoRoot,
			currentPath: process.env.PATH ?? "",
		});
		if (!cargo) throw new Error("Could not resolve Cargo from rustup for the native panic test.");

		const napi = Bun.which("napi", {
			PATH: [
				path.join(packageDir, "node_modules", ".bin"),
				path.join(repoRoot, "node_modules", ".bin"),
				process.env.PATH ?? "",
			].join(path.delimiter),
		});
		if (!napi) throw new Error("Could not locate @napi-rs/cli for the native panic test.");

		// Build the native addon
		const buildProcess = Bun.spawn(
			[
				napi,
				"build",
				"--manifest-path",
				path.join(repoRoot, "crates/pi-natives/Cargo.toml"),
				"--package-json-path",
				path.join(packageDir, "package.json"),
				"--no-js",
				"--dts",
				"index.d.ts",
				"-o",
				outputDir,
				"--",
				"--features",
				"task-panic-test",
			],
			{
				cwd: repoRoot,
				env: { ...process.env, PATH: cargo.pathValue },
				stdout: "inherit",
				stderr: "inherit",
			},
		);

		const buildExitCode = await buildProcess.exited;
		if (buildExitCode !== 0) {
			throw new Error(`napi build failed with exit code ${buildExitCode}`);
		}

		// Find the built .node file
		const addons = (await fs.readdir(outputDir)).filter((file) => file.endsWith(".node"));
		if (addons.length !== 1) {
			throw new Error(`Expected exactly one .node file in ${outputDir}, got ${addons.length}`);
		}

		const addonPath = path.join(outputDir, addons[0]!);
		console.log(`Built addon: ${addonPath}`);

		// Run the test with the prebuilt addon
		console.log(`Running test with GJC_TASK_PANIC_ADDON=${addonPath}...`);
		const testProcess = Bun.spawn(["bun", "test", testFile], {
			cwd: repoRoot,
			env: { ...process.env, GJC_TASK_PANIC_ADDON: addonPath },
			stdout: "inherit",
			stderr: "inherit",
		});

		const testExitCode = await testProcess.exited;
		process.exitCode = testExitCode;
	} finally {
		// Clean up temp directory
		await fs.rm(outputDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
