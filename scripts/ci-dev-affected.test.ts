import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { packageScriptCommand, planTasks, resolvePackageCwd, runCommand, type WorkspacePackage } from "./ci-dev-affected";

const packages: WorkspacePackage[] = [
	{
		name: "@gajae-code/example",
		dir: "packages/example",
		manifest: { name: "@gajae-code/example", scripts: { check: "true", test: "true" } },
	},
];

function planForPaths(paths: readonly string[]) {
	return planTasks(paths, packages);
}

describe("planTasks command shape (issue #622)", () => {
	test("no scheduled command uses the false-green standalone `bun --cwd <dir>` form", () => {
		const tasks = planForPaths([
			"packages/example/src/index.ts",
			"python/robogjc/web/app.ts",
		]);
		expect(tasks.length).toBeGreaterThan(0);
		for (const task of tasks) {
			// The space-separated `--cwd` argument is the exact shape that makes
			// `bun run` print its usage banner and exit 0 without running the
			// script under Bun 1.3.x. It must never appear in a scheduled command.
			expect(task.command).not.toContain("--cwd");
			// Be strict about the equals form too: directory scoping is expressed
			// via `task.cwd`, never as a `--cwd=...` flag baked into the command.
			expect(task.command.some(arg => arg.startsWith("--cwd"))).toBe(false);
		}
	});

	test("package check/test tasks run `bun run <script>` in the package cwd", () => {
		const tasks = planForPaths(["packages/example/src/index.ts"]);
		const check = tasks.find(task => task.key === "check:@gajae-code/example");
		const runTest = tasks.find(task => task.key === "test:@gajae-code/example");
		expect(check).toBeDefined();
		expect(runTest).toBeDefined();
		expect(check?.command).toEqual(["bun", "run", "check"]);
		expect(runTest?.command).toEqual(["bun", "run", "test"]);
		expect(check?.cwd).toBe(resolvePackageCwd("packages/example"));
		expect(runTest?.cwd).toBe(resolvePackageCwd("packages/example"));
	});

	test("robogjc web tasks run `bun run <script>` in the web cwd", () => {
		const tasks = planForPaths(["python/robogjc/web/app.ts"]);
		const typecheck = tasks.find(task => task.key === "robogjc-web-typecheck");
		const build = tasks.find(task => task.key === "robogjc-web-build");
		expect(typecheck?.command).toEqual(["bun", "run", "typecheck"]);
		expect(build?.command).toEqual(["bun", "run", "build"]);
		expect(typecheck?.cwd).toBe(resolvePackageCwd("python/robogjc/web"));
		expect(build?.cwd).toBe(resolvePackageCwd("python/robogjc/web"));
	});
});

	describe("deep-interview selector narrowing", () => {
		test("deep-interview-only changes avoid native/full workspace validation", () => {
			const tasks = planForPaths([
				"packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md",
				"packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts",
				"packages/coding-agent/test/default-gjc-definitions.test.ts",
				"packages/coding-agent/test/gjc-runtime/deep-interview-runtime.test.ts",
			]);
			expect(tasks.map(task => task.key)).toEqual([
				"deep-interview-definitions",
				"deep-interview-runtime",
			]);
			expect(tasks.some(task => task.key.includes("native") || task.key === "root-test")).toBe(false);
		});
	});

describe("runCommand executes package scripts in the target cwd (issue #622)", () => {
	const tempDirs: string[] = [];

	afterAll(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function makePackage(): Promise<{ pkgDir: string; markerPath: string }> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-"));
		tempDirs.push(tempDir);
		const pkgDir = path.join(tempDir, "pkg");
		await fs.mkdir(pkgDir, { recursive: true });
		const marker = "ran.marker";
		await fs.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({
				name: "marker-pkg",
				scripts: {
					check: `node -e "require('node:fs').writeFileSync('${marker}','ran')"`,
					fail: "node -e \"process.exit(3)\"",
				},
			}),
		);
		return { pkgDir, markerPath: path.join(pkgDir, marker) };
	}

	test("the produced command actually runs the package script", async () => {
		const { pkgDir, markerPath } = await makePackage();
		const exitCode = await runCommand(packageScriptCommand("check"), pkgDir);
		expect(exitCode).toBe(0);
		expect(await Bun.file(markerPath).exists()).toBe(true);
	});

	test("a failing package script propagates its non-zero exit code", async () => {
		const { pkgDir } = await makePackage();
		const exitCode = await runCommand(packageScriptCommand("fail"), pkgDir);
		expect(exitCode).toBe(3);
	});

	test("the legacy `bun --cwd <dir>` form is a false green: exits 0 without running the script", async () => {
		const { pkgDir, markerPath } = await makePackage();
		// Spawn the buggy shape directly (captured, so the usage banner does not
		// flood test output) from a cwd that is NOT the package directory.
		const proc = Bun.spawn(["bun", "--cwd", pkgDir, "run", "check"], {
			cwd: os.tmpdir(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const output = stdout + stderr;
		expect(exitCode).toBe(0); // false green
		expect(await Bun.file(markerPath).exists()).toBe(false); // script never ran
		expect(output).toContain("Usage: bun run"); // it only printed help
	});
});
