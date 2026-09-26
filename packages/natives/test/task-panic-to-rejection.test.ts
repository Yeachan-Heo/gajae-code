import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveCargoToolchainPath } from "../scripts/rust-toolchain-path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageDir = path.join(repoRoot, "packages/natives");
const nativeDir = path.join(packageDir, "native");
const testTimeoutMs = 120_000;

setDefaultTimeout(testTimeoutMs);

describe("blocking task panic rejection", () => {
	it(
		"rejects the native Promise and keeps the child process alive",
		async () => {
			// Native builds can take significant time; log progress for visibility
			const startTime = Date.now();
			const cargo = await resolveCargoToolchainPath({ cwd: repoRoot, currentPath: process.env.PATH ?? "" });
			if (!cargo) throw new Error("Could not resolve Cargo from rustup for the native panic test.");

			const napi = Bun.which("napi", {
				PATH: [
					path.join(packageDir, "node_modules", ".bin"),
					path.join(repoRoot, "node_modules", ".bin"),
					process.env.PATH ?? "",
				].join(path.delimiter),
			});
			if (!napi) throw new Error("Could not locate @napi-rs/cli for the native panic test.");

			const outputDir = await fs.mkdtemp(path.join(nativeDir, ".task-panic-test-"));
			try {
				const build = Bun.spawn(
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
						"--profile",
						"ci",
						"--",
						"--features",
						"task-panic-test",
					],
					{
						cwd: repoRoot,
						env: { ...process.env, PATH: cargo.pathValue },
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [buildExitCode, buildStdout, buildStderr] = await Promise.all([
					build.exited,
					new Response(build.stdout).text(),
					new Response(build.stderr).text(),
				]);
				expect(buildExitCode, `build stdout:\n${buildStdout}\nbuild stderr:\n${buildStderr}`).toBe(0);

				const addons = (await fs.readdir(outputDir)).filter(file => file.endsWith(".node"));
				expect(addons).toHaveLength(1);
				const addonPath = path.join(outputDir, addons[0]!);
				const childCode = `
(async () => {
	const { createRequire } = await import("node:module");
	const loadAddon = createRequire(${JSON.stringify(path.join(repoRoot, "package.json"))});
	const addon = loadAddon(${JSON.stringify(addonPath)});
	let rejection;
	try {
		await addon.__gjcTestBlockingPanic();
	} catch (error) {
		rejection = error;
	}
	if (!rejection || !String(rejection.message ?? rejection).includes("BlockingTask panic: injected blocking task panic")) {
		throw new Error("panicking task did not reject with its native error: " + String(rejection));
	}
	if (addon.visibleWidth("ok", 4) !== 2) throw new Error("native process did not survive the rejected task");
	console.log("blocking-task-panic-rejected");
})().catch(error => {
	console.error(error && error.stack ? error.stack : String(error));
	process.exitCode = 1;
});
`;
				const child = Bun.spawn([process.execPath, "-e", childCode], {
					cwd: repoRoot,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(exitCode, `child stdout:\n${stdout}\nchild stderr:\n${stderr}`).toBe(0);
				expect(stdout).toContain("blocking-task-panic-rejected");
			} finally {
				await fs.rm(outputDir, { recursive: true, force: true });
			}
		},
		testTimeoutMs,
	);
});
