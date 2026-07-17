import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeTasks, expandWithDependents, loadBuildInventory, normalizeChangedPaths, packageScriptCommand, planTargetedTasks, planTasks, requiresCargoWorkspaceEmergency, resolvePackageCwd, runCommand, validateAffectedAggregate, type AffectedAggregateResults, type CargoInventoryUnit, type WorkspacePackage } from "./ci-dev-affected";

// Matrix planning validates live workspace and Cargo manifests in subprocesses.
// Hosted runners can need more than Bun's 5s default during their first cold scan.
setDefaultTimeout(30_000);

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
		const tasks = planForPaths(["packages/example/src/index.ts"]);
		expect(tasks.length).toBeGreaterThan(0);
		for (const task of tasks) {
			expect(task.command).not.toContain("--cwd");
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

});

describe("dev-ci canonical-plan workflow contract", () => {
	test("binds the canonical plan to its checked-out source and validates it before aggregate decisions", async () => {
		const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "dev-ci.yml")).text();
		expect(workflow.match(/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/g)).toHaveLength(5);
		expect(workflow.match(/Verify checked-out source head/g)).toHaveLength(5);
		expect(workflow).toContain("name: dev-affected-plan-${{ github.run_id }}-${{ github.run_attempt }}");
		expect(workflow.match(/\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g)).toHaveLength(8);
		expect(workflow).toContain("include-hidden-files: true");
		expect(workflow.match(/include-hidden-files: true/g)).toHaveLength(2);
		expect(workflow).toContain("CI_DEV_PLAN_DIGEST: ${{ needs.affected-plan.outputs.plan_digest }}");
		expect(workflow).toContain("CI_DEV_PLAN_SOURCE_SHA: ${{ needs.affected-plan.outputs.plan_source_sha }}");
		expect(workflow).toContain("CI_DEV_MATRIX_NEXTEST: ${{ matrix.nextest }}");
		expect(workflow).toContain("timeout-minutes: ${{ matrix.key == 'root-check' && 30 || 90 }}");
		expect(workflow.match(/run: bun scripts\/ci-dev-affected\.ts --validate-plan/g)).toHaveLength(3);
		expect(workflow).toContain("if: ${{ matrix.nextest }}");
		expect(workflow).toContain("affected-native.result != 'failure'");
		expect(workflow).toContain("name: Affected path validation");
		expect(workflow).toContain("CI_DEV_HAS_NATIVE: ${{ needs.affected-plan.outputs.has_native }}");
		expect(workflow).toContain("CI_DEV_HAS_TASKS: ${{ needs.affected-plan.outputs.has_tasks }}");
		expect(workflow).toContain("--validate-aggregate");
		expect(workflow).toContain("CI_DEV_WINDOWS_DOCTOR_RESULT: ${{ needs.windows-dev-doctor.result }}");
		expect(workflow).toContain("CI_DEV_WINDOWS_DOCTOR_REQUIRED: ${{ contains(needs.affected-plan.outputs.changed_paths, 'scripts/dev-link') }}");
		expect(workflow).toContain("max-parallel: 8");
		expect(workflow).toContain("CI_DEV_MATRIX_IDENTITY: ${{ matrix.identity }}");
		expect(workflow).toContain("Upload shard completion receipt");
		expect(workflow).toContain("Validate canonical shard completion");
		expect(workflow).toContain("--validate-shard-receipts");
		expect(workflow).toContain("pi_natives.linux-x64-baseline.node");
		expect(workflow).toContain("pi_natives.linux-x64-modern.node");
		expect(workflow).not.toContain("native-cache");
		expect(workflow).not.toContain("pull_request_target");
		expect(workflow).not.toContain("uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830");
		expect(workflow.match(/uses: actions\/cache\/restore@0057852bfaa89a56745cba8c7296529d2fc39830/g)).toHaveLength(4);
		expect(workflow.match(/save-if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev' \}\}/g)).toHaveLength(3);
		const aggregateWorkflow = workflow.slice(workflow.indexOf("  affected:\n"));
		expect(aggregateWorkflow).toContain("name: Validate canonical affected plan");
		expect(aggregateWorkflow).toContain("run: bun scripts/ci-dev-affected.ts --validate-plan");
	});

	test("aggregate result truth table rejects every missing, failed, cancelled, and unplanned dependency", () => {
		const valid: AffectedAggregateResults[] = [
			{ plan: "success", native: "success", shards: "success", windowsDoctor: "success", windowsDoctorRequired: "true", hasNative: "true", hasTasks: "true" },
			{ plan: "success", native: "skipped", shards: "skipped", windowsDoctor: "skipped", windowsDoctorRequired: "false", hasNative: "false", hasTasks: "false" },
			{ plan: "success", native: "success", shards: "skipped", windowsDoctor: "skipped", windowsDoctorRequired: "false", hasNative: "true", hasTasks: "false" },
			{ plan: "success", native: "skipped", shards: "success", windowsDoctor: "success", windowsDoctorRequired: "true", hasNative: "false", hasTasks: "true" },
		];
		for (const results of valid) expect(() => validateAffectedAggregate(results)).not.toThrow();

		for (const results of [
			{ ...valid[0]!, plan: "failure" },
			{ ...valid[0]!, plan: "cancelled" },
			{ ...valid[0]!, native: "failure" },
			{ ...valid[0]!, native: "cancelled" },
			{ ...valid[0]!, shards: "failure" },
			{ ...valid[0]!, shards: "cancelled" },
			{ ...valid[0]!, windowsDoctor: "failure" },
			{ ...valid[0]!, windowsDoctor: "cancelled" },
			{ ...valid[0]!, windowsDoctor: "skipped" },
			{ ...valid[1]!, windowsDoctor: "success" },
			{ ...valid[1]!, windowsDoctorRequired: "" },
			{ ...valid[1]!, windowsDoctorRequired: "maybe" },
			{ ...valid[1]!, hasNative: "" },
			{ ...valid[1]!, hasTasks: "maybe" },
			{ ...valid[1]!, native: "success" },
			{ ...valid[1]!, shards: "success" },
		]) expect(() => validateAffectedAggregate(results)).toThrow();
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

	test("full-workspace root-check uses the bounded CI command without native artifacts", () => {
		const entries = describeTasks(planTasks(["tsconfig.json"], packages));
		const nativeBuild = entries.find(entry => entry.key === "native-linux-x64");
		const rootCheck = entries.find(entry => entry.key === "root-check");

		expect(nativeBuild?.nativeBuild).toBe(true);
		expect(rootCheck).toMatchObject({ command: ["bun", "run", "ci:check:full"], native: false, nativeBuild: false });
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

	test("selector self-check shards provision Rust without nextest in PR and push plans", () => {
		const entries = [
			...describeTasks(planTargetedTasks(["scripts/ci-dev-affected.ts"], packages, [])),
			...describeTasks(planTasks(["scripts/ci-dev-affected.ts"], packages)),
		];
		for (const key of ["ci-selftest", "ci-dry-run", "affected-selftest", "affected-dry-run"]) {
			expect(entries.find(entry => entry.key === key)).toMatchObject({ rust: true, nextest: false });
		}
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
	const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();

	afterAll(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
		await fs.rm(path.join(repoRoot, ".ci-dev-affected-plan.json"), { force: true });
	});

	async function runScript(
		args: readonly string[],
		changedPaths: string,
		extraEnv: Record<string, string | undefined> = {},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const proc = Bun.spawn(["bun", scriptPath, ...args], {
			cwd: repoRoot,
			// Default to push (broad) mode so these CLI cases stay deterministic
			// regardless of the GITHUB_EVENT_NAME/CI_DEV_PLAN_MODE of the CI run
			// executing them; PR-mode behavior is asserted via planTargetedTasks unit
			// tests and explicit shard-mode cases.
			env: {
				...process.env,
				CI_DEV_AFFECTED_PLAN: undefined,
				CI_DEV_PLAN_DIGEST: undefined,
				CI_DEV_PLAN_SOURCE_SHA: undefined,
				GITHUB_SHA: undefined,
				CI_DEV_SOURCE_SHA: sourceSha,
				CI_DEV_MATRIX_IDENTITY: undefined,
				CI_DEV_MATRIX_KEY: undefined,
				CI_DEV_MATRIX_NATIVE: undefined,
				CI_DEV_MATRIX_NEXTEST: undefined,
				CI_DEV_MATRIX_RUST: undefined,
				CI_DEV_SHARD_INDEX: undefined,
				CI_DEV_SHARD_RECEIPTS: undefined,
				AFFECTED_TASK_KEY: undefined,
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
		expect(entries.some((entry: { key: string; rust: boolean; nativeBuild: boolean }) => entry.key.startsWith("cargo-build:") && entry.rust === true && entry.nativeBuild === false)).toBe(true);
		expect(entries.filter((entry: { key: string }) => entry.key === "native-linux-x64")).toHaveLength(1);

		const output = await Bun.file(outputFile).text();
		expect(output).toContain("has_tasks=true");
		expect(output).toContain("has_native=true");
		expect(output).toContain("changed_paths<<");

		const matrixLine = output.split("\n").find(line => line.startsWith("matrix="));
		expect(matrixLine).toBeDefined();
		const matrix = JSON.parse((matrixLine as string).slice("matrix=".length));
		expect(matrix.include.some((shard: { key: string }) => shard.key === "rust-check")).toBe(true);
		expect(matrix.include.some((shard: { key: string }) => shard.key.startsWith("cargo-build:"))).toBe(true);
		// Native build tasks never appear as shards.
		expect(matrix.include.every((shard: { key: string }) => shard.key !== "native-linux-x64")).toBe(true);
	});

	test("changed-path ranges use the canonical source head instead of ambient PR merge SHA", async () => {
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
		// The affected-shard checkout intentionally contains only the canonical source
		// commit. Reusing it as the base proves source-head authority without assuming
		// that unrelated parent or remote refs exist in the shallow checkout.
		const base = head;
		const missingMergeSha = "1".repeat(40);
		const pr = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "", GITHUB_BASE_SHA: base,
			GITHUB_SHA: missingMergeSha, CI_DEV_SOURCE_SHA: head,
		});
		expect(pr.exitCode).toBe(0);

		const push = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: base, GITHUB_BASE_SHA: "",
			GITHUB_SHA: missingMergeSha, CI_DEV_SOURCE_SHA: head,
		});
		expect(push.exitCode).toBe(0);

		const missingHead = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "", GITHUB_BASE_SHA: base,
			GITHUB_SHA: head, CI_DEV_SOURCE_SHA: "2".repeat(40),
		});
		expect(missingHead.exitCode).toBe(1);
		expect(missingHead.stderr).toContain("source head");
		expect(missingHead.stderr).toContain("is not available");
	});

	test("PR planning uses the event base SHA when the mutable base ref has moved", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-pr-base-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
		// Shard checkouts are depth-one, so use the canonical head as an available
		// event-base commit while the mutable base ref deliberately does not exist.
		const base = head;
		const result = await runScript(["--matrix-json"], "", {
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_BASE_REF: "ci-dev-affected-base-ref-moved",
			GITHUB_BASE_SHA: base,
			GITHUB_SHA: "f".repeat(40),
			CI_DEV_SOURCE_SHA: head,
			GITHUB_OUTPUT: outputFile,
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toBeInstanceOf(Array);
		const output = await Bun.file(outputFile).text();
		expect(output).toContain(`plan_source_sha=${head}`);
		expect(output).toContain("plan_digest=");
		expect(await Bun.file(path.join(repoRoot, ".ci-dev-affected-plan.json")).exists()).toBe(true);
	});

	test("Cargo selection includes transitive dependents and never emits vendored shards", async () => {
		const sdk = await runScript(["--matrix-json"], "crates/gjc-sdk/src/lib.rs");
		expect(sdk.exitCode).toBe(0);
		const sdkKeys = (JSON.parse(sdk.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key);
		expect(sdkKeys.filter(key => key.startsWith("cargo-build:"))).toEqual([
			"cargo-build:cargo:Z2pjLXNkaw:Y3JhdGVzL2dqYy1zZGsvQ2FyZ28udG9tbA",
			"cargo-build:cargo:cGktbmF0aXZlcw:Y3JhdGVzL3BpLW5hdGl2ZXMvQ2FyZ28udG9tbA",
		]);
		expect(sdkKeys.filter(key => key === "native-linux-x64")).toHaveLength(1);

		const vendored = await runScript(["--matrix-json"], "crates/brush-core-vendored/src/lib.rs");
		expect(vendored.exitCode).toBe(0);
		const vendoredKeys = (JSON.parse(vendored.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key);
		expect(vendoredKeys.filter(key => key.startsWith("cargo-build:"))).toHaveLength(5);
		expect(vendoredKeys.some(key => key.includes("brush"))).toBe(false);
	});

	test("root/shared build inputs select every inventory TypeScript build in stable order", async () => {
		const { stdout, exitCode } = await runScript(["--matrix-json"], "bun.lock");
		expect(exitCode).toBe(0);
		const entries = JSON.parse(stdout.trim()) as Array<{ key: string }>;
		expect(entries.filter(entry => entry.key.startsWith("ts-build:")).map(entry => entry.key)).toEqual([
			"ts-build:ts:Y29kaW5nLWFnZW50:cGFja2FnZXMvY29kaW5nLWFnZW50",
			"ts-build:ts:c3RhdHM:cGFja2FnZXMvc3RhdHM",
		]);
	});

	test("package documentation changes do not schedule build shards", async () => {
		const { stdout, exitCode } = await runScript(["--matrix-json"], "packages/coding-agent/README.md", {
			CI_DEV_PLAN_MODE: "pr",
			PATH: `${path.dirname(Bun.which("bun") ?? process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
		});
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual([]);
	});

	test("unknown unowned inputs fail open to every TypeScript and Cargo build family", async () => {
		for (const changedPath of ["Makefile", "packages/new-workspace/src/index.ts"]) {
			const { stdout, exitCode } = await runScript(["--matrix-json"], changedPath);
			expect(exitCode).toBe(0);
			const entries = JSON.parse(stdout.trim()) as Array<{ key: string }>;
			expect(entries.filter(entry => entry.key.startsWith("ts-build:")).map(entry => entry.key)).toHaveLength(2);
			expect(entries.filter(entry => entry.key.startsWith("cargo-build:")).map(entry => entry.key)).toHaveLength(5);
			expect(entries.filter(entry => entry.key === "native-linux-x64")).toHaveLength(1);
		}
	});

	test("native workspace changes have exact PR and push plans", async () => {
		const pr = await runScript(["--matrix-json"], "packages/natives/src/index.ts", { CI_DEV_PLAN_MODE: "pr" });
		expect(pr.exitCode).toBe(0);
		expect((JSON.parse(pr.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key)).toEqual([
			"check:@gajae-code/natives",
			"native-linux-x64",
			"ts-build:ts:Y29kaW5nLWFnZW50:cGFja2FnZXMvY29kaW5nLWFnZW50",
			"ts-build:ts:c3RhdHM:cGFja2FnZXMvc3RhdHM",
		]);

		const push = await runScript(["--matrix-json"], "packages/natives/src/index.ts", { CI_DEV_PLAN_MODE: "push" });
		expect(push.exitCode).toBe(0);
		expect((JSON.parse(push.stdout.trim()) as Array<{ key: string }>).map(entry => entry.key)).toEqual([
			"check:@gajae-code/agent-core", "test:@gajae-code/agent-core",
			"check:@gajae-code/ai", "test:@gajae-code/ai",
			"check:@gajae-code/coding-agent",
			...Array.from({ length: 8 }, (_, index) => `test:@gajae-code/coding-agent:shard-${index + 1}-of-8`),
			"check:@gajae-code/natives", "test:@gajae-code/natives",
			"check:@gajae-code/stats",
			"check:@gajae-code/tui", "test:@gajae-code/tui",
			"check:@gajae-code/typescript-edit-benchmark", "test:@gajae-code/typescript-edit-benchmark",
			"check:@gajae-code/utils", "test:@gajae-code/utils",
			"native-linux-x64",
			"ts-build:ts:Y29kaW5nLWFnZW50:cGFja2FnZXMvY29kaW5nLWFnZW50",
			"ts-build:ts:c3RhdHM:cGFja2FnZXMvc3RhdHM",
		]);
	});

	test("canonical plan validation binds exact bytes and source head", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-plan-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");
		const planFile = path.join(tempDir, "plan.json");
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
		const generated = await runScript(["--matrix-json"], "packages/stats/src/index.ts", {
			GITHUB_OUTPUT: outputFile,
			CI_DEV_SOURCE_SHA: head,
		});
		expect(generated.exitCode).toBe(0);
		await Bun.write(planFile, Bun.file(path.join(repoRoot, ".ci-dev-affected-plan.json")));
		const output = await Bun.file(outputFile).text();
		const digest = output.split("\n").find(line => line.startsWith("plan_digest="))?.slice("plan_digest=".length);
		expect(digest).toBeDefined();
		const valid = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
		});
		expect(valid.exitCode).toBe(0);
		const receiptDir = path.join(tempDir, "receipts");
		await fs.mkdir(receiptDir);
		const plan = JSON.parse(await Bun.file(planFile).text()) as { tasks: Array<{ key: string; identity: string; capabilities: { nativeProducer: boolean } }> };
		const expectedShards = plan.tasks.filter(task => !task.capabilities.nativeProducer);
		for (const [index, task] of expectedShards.entries()) {
			await Bun.write(path.join(receiptDir, `${index}.json`), JSON.stringify({ key: task.key, identity: task.identity }));
		}
		const receiptsValid = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptsValid.exitCode).toBe(0);
		await fs.rm(path.join(receiptDir, "0.json"));
		const receiptMissing = await runScript(["--validate-shard-receipts"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_SHARD_RECEIPTS: receiptDir,
		});
		expect(receiptMissing.exitCode).toBe(1);
		expect(receiptMissing.stderr).toContain("shard receipt set does not match canonical plan");
		const wrongSource = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: "0".repeat(40),
		});
		expect(wrongSource.exitCode).toBe(1);
		expect(wrongSource.stderr).toContain("source SHA mismatch");

		const matrixEntry = (JSON.parse(generated.stdout.trim()) as Array<{ key: string; rust: boolean; nextest: boolean; native: boolean }>).find(entry => !entry.key.startsWith("native-linux-x64"));
		expect(matrixEntry).toBeDefined();
		const wrongCapabilities = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
			CI_DEV_MATRIX_KEY: matrixEntry?.key as string,
			CI_DEV_MATRIX_RUST: String(!(matrixEntry?.rust ?? false)),
			CI_DEV_MATRIX_NEXTEST: String(matrixEntry?.nextest ?? false),
			CI_DEV_MATRIX_NATIVE: String(matrixEntry?.native ?? false),
		});
		expect(wrongCapabilities.exitCode).toBe(1);
		expect(wrongCapabilities.stderr).toContain("matrix capabilities mismatch");
		await Bun.write(planFile, `${await Bun.file(planFile).text()}\n`);
		const tampered = await runScript(["--validate-plan"], "packages/stats/src/index.ts", {
			CI_DEV_AFFECTED_PLAN: planFile,
			CI_DEV_PLAN_DIGEST: digest as string,
			CI_DEV_PLAN_SOURCE_SHA: head,
		});
		expect(tampered.exitCode).toBe(1);
		expect(tampered.stderr).toContain("digest mismatch");
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
	const bridgeClient: WorkspacePackage = {
		name: "@gajae-code/bridge-client",
		dir: "packages/bridge-client",
		manifest: { name: "@gajae-code/bridge-client", scripts: { check: "biome check .", test: "bun test" } },
	};
	const targetingPackages: WorkspacePackage[] = [codingAgent, bridgeClient];
	const testFiles = [
		"packages/coding-agent/test/edit/foo.test.ts",
		"packages/coding-agent/test/edit/bar.test.ts",
		"packages/coding-agent/test/cli.test.ts",
		"packages/coding-agent/test/rlm-live-model-e2e.test.ts",
		"packages/coding-agent/test/startup-update-contract.test.ts",
		"packages/coding-agent/test/sdk-host-wiring.test.ts",
		"packages/coding-agent/test/sdk/index.test.ts",
		"packages/coding-agent/test/other/index.test.ts",
		"packages/bridge-client/test/client.test.ts",
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

	test("SDK host and coordinator prompt-control changes include only coding-agent shard 1", () => {
		const shardOne = "test:@gajae-code/coding-agent:shard-1-of-8";
		for (const changedPath of [
			"packages/coding-agent/src/sdk/bus/index.ts",
			"packages/coding-agent/src/sdk/host/reverse-leases.ts",
			"packages/coding-agent/src/coordinator-mcp/server.ts",
			"packages/coding-agent/test/sdk-host-wiring.test.ts",
			"packages/coding-agent/test/coordinator-mcp/send-prompt-concurrency.test.ts",
		]) {
			const tasks = targeted([changedPath]);
			const keys = tasks.map(task => task.key);
			expect(keys).toContain(shardOne);
			expect(tasks.find(task => task.key === shardOne)?.command).toEqual(["bun", "test", "--shard=1/8"]);
			expect(keys.filter(key => key.startsWith("test:@gajae-code/coding-agent:shard-"))).toEqual([shardOne]);
		}
	});

	test("basename collisions fall back to package checks instead of arbitrary tests", () => {
		const tasks = targeted(["packages/coding-agent/src/sdk/bus/index.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("test:@gajae-code/coding-agent:shard-1-of-8");
		expect(keys).not.toContain("test:packages/coding-agent/test/sdk/index.test.ts");
		expect(keys).not.toContain("test:packages/coding-agent/test/other/index.test.ts");
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
			identity: "legacy:dGVzdDpwYWNrYWdlcy9jb2RpbmctYWdlbnQvdGVzdC9ybG0tbGl2ZS1tb2RlbC1lMmUudGVzdC50cw:Lg",
			description: "Test packages/coding-agent/test/rlm-live-model-e2e.test.ts",
			command: ["bun", "test", "packages/coding-agent/test/rlm-live-model-e2e.test.ts"],
			cwd: undefined,
			native: true,
			rust: false,
			nextest: false,
			nativeBuild: false,
		});
		expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
	});

	test("a source file with a directly-named test maps exclusively to that test", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/foo.ts"]);
		expect(tasks.map(task => task.key)).toEqual([
			"test:packages/coding-agent/test/edit/foo.test.ts",
			"native-linux-x64",
		]);
	});

	test("a source file with no mapped test runs the owning package check, not its test suite", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/unmapped.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("cli-smoke"); // coding-agent runtime smoke
		expect(keys.some(key => key.startsWith("test:"))).toBe(false);
	});

	test("main entrypoint adds its behavioral contract test without replacing owner fallback coverage", () => {
		const tasks = targeted(["packages/coding-agent/src/main.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toEqual([
			"test:packages/coding-agent/test/startup-update-contract.test.ts",
			"check:@gajae-code/coding-agent",
			"cli-smoke",
			"native-linux-x64",
		]);
		expect(tasks[0]?.command).toEqual(["bun", "test", "packages/coding-agent/test/startup-update-contract.test.ts"]);
		expect(tasks[1]).toMatchObject({
			command: ["bun", "run", "check"],
			cwd: resolvePackageCwd("packages/coding-agent"),
		});
		expect(tasks[2]?.command).toEqual(["bun", "run", "ci:test:smoke"]);
		expect(keys.filter(key => key === "native-linux-x64")).toHaveLength(1);
	});

	test("a CI workflow change plans yaml-parse + ci-selftest + ci-dry-run only", () => {
		const tasks = targeted([".github/workflows/dev-ci.yml"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest", "yaml-parse"]);
	});

	test("a CI harness script change plans ci-selftest + ci-dry-run (no yaml-parse)", () => {
		const tasks = targeted(["scripts/ci-dev-affected.ts"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest"]);
	});

	test("native platform package changes plan release publish validation", () => {
		const tasks = targeted(["packages/natives-linux-x64/package.json"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("release-publish-contract");
		expect(keys).toContain("release-publish-dry-run");
	});

	test("bridge-client changes retain package validation alongside release publish coverage", () => {
		const tasks = targeted(["packages/bridge-client/src/client.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "check:@gajae-code/bridge-client")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
		expect(keys.filter(key => key === "test:scripts/release-evidence.test.ts")).toHaveLength(1);
		expect(keys.filter(key => key === "bridge-client-sdk-package-smoke")).toHaveLength(1);
		expect(keys.filter(key => key === "test:packages/bridge-client/test/client.test.ts")).toHaveLength(1);
		expect(tasks.find(task => task.key === "bridge-client-sdk-package-smoke")?.command).toEqual([
			"bun",
			"packages/coding-agent/scripts/build-sdk-package-smoke.ts",
		]);
		expect(describeTasks(tasks).find(task => task.key === "bridge-client-sdk-package-smoke")?.native).toBe(true);
	});

	test("release evidence source changes select contract, dry-run, and focused evidence coverage once", () => {
		const tasks = targeted(["scripts/release-evidence.ts", "scripts/ci-release-publish.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
		expect(keys.filter(key => key === "test:scripts/release-evidence.test.ts")).toHaveLength(1);
		expect(tasks.find(task => task.key === "test:scripts/release-evidence.test.ts")?.command).toEqual(["bun", "test", "scripts/release-evidence.test.ts"]);
	});

	test("unscoped wrapper package changes keep wrapper-version smoke with release validation", () => {
		const tasks = targeted(["packages/gajae-code/bin/gjc.js"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("release-publish-contract");
		expect(keys).toContain("release-publish-dry-run");
		expect(keys).toContain("wrapper-version");
	});

	test("root-level codeish fallback uses the bounded CI command without native artifacts", () => {
		const tasks = targeted(["scripts/unmapped-tool.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("root-check");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual([]);

		const rootCheck = describeTasks(tasks).find(entry => entry.key === "root-check");
		expect(rootCheck).toMatchObject({ command: ["bun", "run", "ci:check:full"], native: false, nativeBuild: false });
	});

	test("docs/changelog-only changes plan nothing expensive", () => {
		expect(targeted(["docs/guide.md", "CHANGELOG.md", "packages/coding-agent/README.md"])).toEqual([]);
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

	const bridgeClient: WorkspacePackage = {
		name: "@gajae-code/bridge-client",
		dir: "packages/bridge-client",
		manifest: { name: "@gajae-code/bridge-client", scripts: { check: "biome check .", test: "bun test" } },
	};
	test("push mode splits the package-wide coding-agent test across bounded shards", () => {
		const tasks = planTasks(["packages/coding-agent/src/edit/foo.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		const testShards = tasks.filter(task => task.key.startsWith("test:@gajae-code/coding-agent:shard-"));
		// Broad planner keeps the post-merge fuller suite, but not as one 30m shard.
		expect(testShards.map(task => task.key)).toEqual([
			"test:@gajae-code/coding-agent:shard-1-of-8",
			"test:@gajae-code/coding-agent:shard-2-of-8",
			"test:@gajae-code/coding-agent:shard-3-of-8",
			"test:@gajae-code/coding-agent:shard-4-of-8",
			"test:@gajae-code/coding-agent:shard-5-of-8",
			"test:@gajae-code/coding-agent:shard-6-of-8",
			"test:@gajae-code/coding-agent:shard-7-of-8",
			"test:@gajae-code/coding-agent:shard-8-of-8",
		]);
		expect(testShards[0]?.command).toEqual(["bun", "test", "--shard=1/8"]);
		expect(testShards[0]?.cwd).toBe(resolvePackageCwd("packages/coding-agent"));
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).toContain("check:@gajae-code/coding-agent");

		const entries = describeTasks(tasks);
		expect(entries.find(entry => entry.key === "test:@gajae-code/coding-agent:shard-1-of-8")?.native).toBe(true);
	});

	test("push mode schedules release evidence contract, dry-run, and focused coverage once", () => {
		const tasks = planTasks(["scripts/release-evidence.ts", "scripts/ci-release-publish.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
		expect(keys.filter(key => key === "test:scripts/release-evidence.test.ts")).toHaveLength(1);
		expect(tasks.find(task => task.key === "test:scripts/release-evidence.test.ts")?.command).toEqual(["bun", "test", "scripts/release-evidence.test.ts"]);
	});

	test("tooling-script root-check uses the bounded CI command without native artifacts", () => {
		const tasks = planTasks(["scripts/unmapped-tool.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("root-check");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual([]);

		const rootCheck = describeTasks(tasks).find(entry => entry.key === "root-check");
		expect(rootCheck).toMatchObject({ command: ["bun", "run", "ci:check:full"], native: false, nativeBuild: false });
	});

	test("push mode selects the bridge-client SDK package smoke exactly once for package and SDK client changes", () => {
		const tasks = planTasks(
			["packages/bridge-client/package.json", "packages/coding-agent/src/sdk/client/client.ts"],
			[codingAgent, bridgeClient],
		);
		const keys = tasks.map(task => task.key);
		expect(keys.filter(key => key === "bridge-client-sdk-package-smoke")).toHaveLength(1);
		expect(tasks.find(task => task.key === "bridge-client-sdk-package-smoke")?.command).toEqual([
			"bun",
			"packages/coding-agent/scripts/build-sdk-package-smoke.ts",
		]);
		expect(describeTasks(tasks).find(task => task.key === "bridge-client-sdk-package-smoke")?.native).toBe(true);
		expect(keys.filter(key => key === "release-publish-contract")).toHaveLength(1);
		expect(keys.filter(key => key === "release-publish-dry-run")).toHaveLength(1);
	});

	test("full-workspace changes partition root tests into matrix shards", () => {
		const tasks = planTasks(["tsconfig.json"], [codingAgent]);
		const keys = tasks.map(task => task.key);

		expect(keys).toContain("root-check");
		expect(keys).toContain("root-test:release");
		expect(keys).not.toContain("root-test");
		expect(tasks.filter(task => task.key.startsWith("test:@gajae-code/coding-agent:shard-")).map(task => task.key)).toEqual([
			"test:@gajae-code/coding-agent:shard-1-of-8",
			"test:@gajae-code/coding-agent:shard-2-of-8",
			"test:@gajae-code/coding-agent:shard-3-of-8",
			"test:@gajae-code/coding-agent:shard-4-of-8",
			"test:@gajae-code/coding-agent:shard-5-of-8",
			"test:@gajae-code/coding-agent:shard-6-of-8",
			"test:@gajae-code/coding-agent:shard-7-of-8",
			"test:@gajae-code/coding-agent:shard-8-of-8",
		]);
	});
});

describe("normalizeChangedPaths", () => {
	test("normalizes, deduplicates, and orders safe repository-relative paths", () => {
		expect(normalizeChangedPaths(["packages\\stats/src/index.ts", "./packages/stats/src/index.ts"])).toEqual(["packages/stats/src/index.ts"]);
	});

	test("rejects absolute and escaping paths", () => {
		for (const unsafe of ["/etc/passwd", "../package.json", "packages/../package.json", "C:/workspace/package.json"]) {
			expect(() => normalizeChangedPaths([unsafe])).toThrow("affected-path-invalid");
		}
	});
});

describe("build inventory validation", () => {
	test("rejects unknown fields and duplicate Cargo names without the typed emergency", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-inventory-"));
		try {
			const source = JSON.parse(await Bun.file(path.join(import.meta.dir, "ci-dev-affected-build-inventory.json")).text()) as {
				schemaVersion: number;
				typescript: Array<Record<string, unknown>>;
				cargo: Array<Record<string, unknown>>;
				emergency: Record<string, unknown>;
			};
			const unknownPath = path.join(root, "unknown.json");
			await Bun.write(unknownPath, JSON.stringify({ ...source, unexpected: true }));
			await expect(loadBuildInventory(unknownPath)).rejects.toThrow("unexpected build inventory field");

			const duplicatePath = path.join(root, "duplicate.json");
			const duplicateCargo = source.cargo.map((unit, index) => index === 1 ? { ...unit, name: source.cargo[0]?.name } : unit);
			await Bun.write(duplicatePath, JSON.stringify({ ...source, cargo: duplicateCargo, emergency: {} }));
			await expect(loadBuildInventory(duplicatePath)).rejects.toThrow("duplicate Cargo names require workspace emergency");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("workspace dependent closure", () => {
	const leaf: WorkspacePackage = { name: "leaf", dir: "packages/leaf", manifest: { name: "leaf", dependencies: { top: "workspace:*" } } };
	const middle: WorkspacePackage = { name: "middle", dir: "packages/middle", manifest: { name: "middle", dependencies: { leaf: "workspace:*" } } };
	const top: WorkspacePackage = { name: "top", dir: "packages/top", manifest: { name: "top", dependencies: { middle: "workspace:*" } } };
	const graph = [leaf, middle, top];

	test("selects direct and transitive dependents through a cycle without duplicates", () => {
		expect(expandWithDependents([leaf], graph).map(unit => unit.name)).toEqual(["leaf", "middle", "top"]);
		expect(expandWithDependents([middle], graph).map(unit => unit.name)).toEqual(["leaf", "middle", "top"]);
	});
});

describe("Cargo workspace ambiguity", () => {
	const first: CargoInventoryUnit = { id: "first", name: "duplicate", manifestPath: "crates/first/Cargo.toml", supported: true, nativeAddonSource: false };
	const second: CargoInventoryUnit = { id: "second", name: "duplicate", manifestPath: "crates/second/Cargo.toml", supported: true, nativeAddonSource: false };
	const unique: CargoInventoryUnit = { id: "unique", name: "unique", manifestPath: "crates/unique/Cargo.toml", supported: true, nativeAddonSource: false };
	const supported = [first, second, unique];

	test("uses the workspace emergency when any selected name is globally duplicated", () => {
		expect(requiresCargoWorkspaceEmergency([first], supported)).toBe(true);
		expect(requiresCargoWorkspaceEmergency([first, second], supported)).toBe(true);
		expect(requiresCargoWorkspaceEmergency([unique], supported)).toBe(false);
	});
});
