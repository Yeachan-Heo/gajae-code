import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeTasks, packageScriptCommand, planTargetedTasks, planTasks, resolvePackageCwd, runCommand, type WorkspacePackage } from "./ci-dev-affected";

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

	test("python tasks install dev dependencies before invoking pytest and ruff modules", () => {
		const tasks = planForPaths(["python/robogjc/src/server.py"]);
		const lint = tasks.find(task => task.key === "python-lint");
		const runTest = tasks.find(task => task.key === "python-test");
		expect(lint?.command).toEqual([
			"bash",
			"-lc",
			"python3 -m pip install --user --upgrade 'pip>=24' 'setuptools>=69' wheel && python3 -m pip install --user -e python/gjc-rpc -e 'python/robogjc[dev]' && python3 -m ruff check python && python3 -m ruff format --check python/robogjc",
		]);
		expect(runTest?.command).toEqual([
			"bash",
			"-lc",
			"python3 -m pip install --user --upgrade 'pip>=24' 'setuptools>=69' wheel && python3 -m pip install --user -e python/gjc-rpc -e 'python/robogjc[dev]' && python3 -m pytest -x --import-mode=importlib python/gjc-rpc/tests python/robogjc/tests",
		]);
	});
});

	describe("deep-interview selector narrowing", () => {
		test("deep-interview-only changes avoid full workspace validation but still provide native artifacts", () => {
			const tasks = planForPaths([
				"packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md",
				"packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts",
				"packages/coding-agent/test/default-gjc-definitions.test.ts",
				"packages/coding-agent/test/gjc-runtime/deep-interview-runtime.test.ts",
			]);
			expect(tasks.map(task => task.key)).toEqual([
				"native-linux-x64",
				"deep-interview-definitions",
				"deep-interview-runtime",
			]);
			const entries = describeTasks(tasks);
			expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
			expect(entries.find(entry => entry.key === "deep-interview-definitions")?.native).toBe(true);
			expect(entries.find(entry => entry.key === "deep-interview-runtime")?.native).toBe(true);
			expect(tasks.some(task => task.key === "root-test")).toBe(false);
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

describe("describeTasks matrix emission", () => {
	test("package test task needs native, native build task is flagged, check does not", () => {
		const entries = describeTasks(planForPaths(["packages/example/src/index.ts"]));
		const nativeBuild = entries.find(entry => entry.key === "native-linux-x64");
		const pkgTest = entries.find(entry => entry.key === "test:@gajae-code/example");
		const pkgCheck = entries.find(entry => entry.key === "check:@gajae-code/example");

		expect(nativeBuild?.nativeBuild).toBe(true);
		expect(nativeBuild?.native).toBe(false);
		expect(pkgTest?.native).toBe(true);
		expect(pkgTest?.nativeBuild).toBe(false);
		expect(pkgCheck?.native).toBe(false);
		expect(pkgCheck?.nativeBuild).toBe(false);

		// Every descriptor carries the serialized command plus boolean setup flags.
		for (const entry of entries) {
			expect(Array.isArray(entry.command)).toBe(true);
			expect(typeof entry.native).toBe("boolean");
			expect(typeof entry.rust).toBe("boolean");
			expect(typeof entry.nativeBuild).toBe("boolean");
		}
	});

	test("root-check shards need native artifacts for schema generation", () => {
		const entries = describeTasks(planTasks(["tsconfig.json"], packages));
		const nativeBuild = entries.find(entry => entry.key === "native-linux-x64");
		const rootCheck = entries.find(entry => entry.key === "root-check");

		expect(nativeBuild?.nativeBuild).toBe(true);
		expect(rootCheck).toMatchObject({ native: true, nativeBuild: false });
	});

	test("rust tasks are flagged rust and need no native addon", () => {
		const entries = describeTasks(planTasks(["crates/pi-natives/src/lib.rs"], packages));
		const check = entries.find(entry => entry.key === "rust-check");
		const runTest = entries.find(entry => entry.key === "rust-test");

		expect(check?.rust).toBe(true);
		expect(check?.native).toBe(false);
		expect(runTest?.rust).toBe(true);
		expect(entries.every(entry => !entry.nativeBuild)).toBe(true);
	});

	test("cwd is emitted repo-relative for package-scoped tasks", () => {
		const entries = describeTasks(planForPaths(["packages/example/src/index.ts"]));
		const pkgCheck = entries.find(entry => entry.key === "check:@gajae-code/example");
		expect(pkgCheck?.cwd).toBe("packages/example");
	});
});

describe("--matrix-json and --task CLI fan-out", () => {
	const scriptPath = path.join(import.meta.dir, "ci-dev-affected.ts");
	const repoRoot = path.join(import.meta.dir, "..");
	const tempDirs: string[] = [];

	afterAll(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function runScript(
		args: readonly string[],
		changedPaths: string,
		extraEnv: Record<string, string> = {},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const proc = Bun.spawn(["bun", scriptPath, ...args], {
			cwd: repoRoot,
			// Default to push (broad) mode so these CLI cases stay deterministic
			// regardless of the GITHUB_EVENT_NAME/CI_DEV_PLAN_MODE of the CI run
			// executing them; PR-mode behavior is asserted via planTargetedTasks unit
			// tests and explicit shard-mode cases.
			env: {
				...process.env,
				GITHUB_EVENT_NAME: "push",
				CI_DEV_PLAN_MODE: "push",
				CI_DEV_CHANGED_PATHS: changedPaths,
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	test("--matrix-json emits JSON descriptors and GitHub planner outputs", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-matrix-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");

		const { stdout, exitCode } = await runScript(["--matrix-json"], "crates/pi-natives/src/lib.rs", {
			GITHUB_OUTPUT: outputFile,
		});
		expect(exitCode).toBe(0);

		const entries = JSON.parse(stdout.trim());
		expect(entries.some((entry: { key: string; rust: boolean; native: boolean }) => entry.key === "rust-check" && entry.rust === true && entry.native === false)).toBe(true);

		const output = await Bun.file(outputFile).text();
		expect(output).toContain("has_tasks=true");
		expect(output).toContain("has_native=false");
		expect(output).toContain("changed_paths<<");

		const matrixLine = output.split("\n").find(line => line.startsWith("matrix="));
		expect(matrixLine).toBeDefined();
		const matrix = JSON.parse((matrixLine as string).slice("matrix=".length));
		expect(matrix.include.some((shard: { key: string }) => shard.key === "rust-check")).toBe(true);
		// Native build tasks never appear as shards.
		expect(matrix.include.every((shard: { key: string }) => shard.key !== "native-linux-x64")).toBe(true);
	});

	test("--task runs exactly the selected planned task", async () => {
		const { stdout, exitCode } = await runScript(["--task=affected-dry-run"], "scripts/ci-dev-affected.ts");
		expect(exitCode).toBe(0);
		// The selected task's group header proves the right single task was chosen,
		// and the nested --dry-run output proves it actually executed.
		expect(stdout).toContain("Affected CI selector self-check");
		expect(stdout).toContain("Dev affected-path CI");
	});

	test("--task fails loudly on a key absent from the current plan", async () => {
		const { stderr, exitCode } = await runScript(["--task=does-not-exist"], "docs/readme.md");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("not in the current plan");
	});

	test("--native-build is a no-op when the plan has no native build task", async () => {
		const { stdout, exitCode } = await runScript(["--native-build"], "docs/readme.md");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("no native build tasks in plan");
	});
});

describe("planTargetedTasks PR-mode targeting", () => {
	const codingAgent: WorkspacePackage = {
		name: "@gajae-code/coding-agent",
		dir: "packages/coding-agent",
		manifest: { name: "@gajae-code/coding-agent", scripts: { check: "biome check .", test: "bun test" } },
	};
	const targetingPackages: WorkspacePackage[] = [codingAgent];
	const testFiles = [
		"packages/coding-agent/test/edit/foo.test.ts",
		"packages/coding-agent/test/edit/bar.test.ts",
		"packages/coding-agent/test/cli.test.ts",
		"packages/coding-agent/test/rlm-live-model-e2e.test.ts",
	];

	function targeted(paths: readonly string[]) {
		return planTargetedTasks(paths, targetingPackages, testFiles);
	}

	test("a single coding-agent test change runs only that test, not the whole package suite", () => {
		const tasks = targeted(["packages/coding-agent/test/edit/foo.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/edit/foo.test.ts");
		// No broad package-wide test, and no other coding-agent test file.
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).not.toContain("test:packages/coding-agent/test/edit/bar.test.ts");
		const testTask = tasks.find(task => task.key === "test:packages/coding-agent/test/edit/foo.test.ts");
		expect(testTask?.command).toEqual(["bun", "test", "packages/coding-agent/test/edit/foo.test.ts"]);
	});

	test("a deleted test path is not scheduled as a runnable test shard", () => {
		const tasks = targeted(["packages/coding-agent/test/edit/deleted.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).not.toContain("test:packages/coding-agent/test/edit/deleted.test.ts");
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("cli-smoke");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);
	});

	test("the live RLM e2e test gets native artifacts for skipped import-time setup", () => {
		const tasks = targeted(["packages/coding-agent/test/rlm-live-model-e2e.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/rlm-live-model-e2e.test.ts");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).not.toContain("check:@gajae-code/coding-agent");

		const entries = describeTasks(tasks);
		const liveShard = entries.find(entry => entry.key === "test:packages/coding-agent/test/rlm-live-model-e2e.test.ts");
		expect(liveShard).toEqual({
			key: "test:packages/coding-agent/test/rlm-live-model-e2e.test.ts",
			description: "Test packages/coding-agent/test/rlm-live-model-e2e.test.ts",
			command: ["bun", "test", "packages/coding-agent/test/rlm-live-model-e2e.test.ts"],
			native: true,
			rust: false,
			nativeBuild: false,
		});
		expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
	});

	test("a source file with a directly-named test maps to exactly that test", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/foo.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/edit/foo.test.ts");
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).not.toContain("check:@gajae-code/coding-agent");
	});

	test("a source file with no mapped test runs the owning package check, not its test suite", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/unmapped.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("cli-smoke"); // coding-agent runtime smoke
		expect(keys.some(key => key.startsWith("test:"))).toBe(false);
	});

	test("a CI workflow change plans yaml-parse + ci-selftest + ci-dry-run only", () => {
		const tasks = targeted([".github/workflows/dev-ci.yml"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest", "yaml-parse"]);
	});

	test("a CI harness script change plans ci-selftest + ci-dry-run (no yaml-parse)", () => {
		const tasks = targeted(["scripts/ci-dev-affected.ts"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest"]);
	});

	test("root-level codeish changes that fall back to root-check provide native artifacts", () => {
		const tasks = targeted(["scripts/unmapped-tool.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("root-check");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);

		const entries = describeTasks(tasks);
		expect(entries.find(entry => entry.key === "root-check")?.native).toBe(true);
		expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
	});

	test("docs/changelog-only changes plan nothing expensive", () => {
		expect(targeted(["docs/guide.md", "CHANGELOG.md", "packages/coding-agent/README.md"])).toEqual([]);
	});

	test("robogjc static asset changes plan no Python lint/test shards", () => {
		expect(targeted(["python/robogjc/assets/icon.png", "python/robogjc/assets/icon.jpg"])).toEqual([]);
	});

	test("native-consuming test files pull in a single native build task", () => {
		const tasks = targeted(["packages/coding-agent/test/cli.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/cli.test.ts");
		// ensureNativeBuild adds exactly one native build task (built once, shared).
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);

		const entries = describeTasks(tasks);
		const cliShard = entries.find(entry => entry.key === "test:packages/coding-agent/test/cli.test.ts");
		expect(cliShard?.native).toBe(true);
	});
});

describe("push-mode broad planning still runs the fuller suite", () => {
	const codingAgent: WorkspacePackage = {
		name: "@gajae-code/coding-agent",
		dir: "packages/coding-agent",
		manifest: { name: "@gajae-code/coding-agent", scripts: { check: "biome check .", test: "bun test" } },
	};

	test("push mode plans the package-wide test for a coding-agent change", () => {
		const tasks = planTasks(["packages/coding-agent/src/edit/foo.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		// Broad planner keeps the package-wide test (the post-merge fuller suite).
		expect(keys).toContain("test:@gajae-code/coding-agent");
		expect(keys).toContain("check:@gajae-code/coding-agent");
	});
});
