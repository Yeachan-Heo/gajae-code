import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildTestProcessSpec,
	enumerateTestFiles,
	parseHarnessOptions,
	probeLinuxProcess,
	processIdentityIsExecuting,
	runHarness,
	selectShard,
	type TestProcessRunner,
} from "./run-bun-test-files";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-bun-test-files "));
	tempDirs.push(directory);
	await fs.mkdir(path.join(directory, "tests", "nested dir"), { recursive: true });
	await Bun.write(path.join(directory, "tests", "alpha.test.ts"), "test('a', () => {});\n");
	await Bun.write(path.join(directory, "tests", "nested dir", "beta spec.spec.ts"), "test('b', () => {});\n");
	await Bun.write(path.join(directory, "tests", "test_gamma.ts"), "test('c', () => {});\n");
	await Bun.write(path.join(directory, "tests", "helper.ts"), "export {};\n");
	return directory;
}

describe("fresh-process test harness contracts", () => {
	test("parses bounded shard and timeout options", () => {
		expect(
			parseHarnessOptions([
				"--root=packages/ai",
				"--shard=2/8",
				"--timeout=30000",
				"--file-timeout=90000",
				"--concurrency=3",
			]),
		).toEqual({
			root: "packages/ai",
			shard: { index: 2, total: 8 },
			testTimeoutMs: 30_000,
			fileTimeoutMs: 90_000,
			concurrency: 3,
		});
	});

	test("enumerates deterministic test paths with spaces without shell parsing", async () => {
		const root = await fixture();
		expect(await enumerateTestFiles("tests", root)).toEqual([
			"tests/alpha.test.ts",
			"tests/nested dir/beta spec.spec.ts",
			"tests/test_gamma.ts",
		]);
	});

	test("keeps source-bound evidence out of unrelated AI runtime suites", async () => {
		const files = await enumerateTestFiles("packages/ai", path.join(import.meta.dir, ".."));
		expect(files).not.toContain("packages/ai/test/anthropic-cache-eval.integration.test.ts");
	});

	test("assigns the provider safety-stop regression to exactly one normal coding-agent shard", async () => {
		const files = await enumerateTestFiles("packages/coding-agent", path.join(import.meta.dir, ".."));
		const regression = "packages/coding-agent/test/provider-safety-stop-hint.e2e.test.ts";
		expect(files).toContain(regression);
		const assignedShards = Array.from({ length: 8 }, (_, index) => index + 1).filter(shard =>
			selectShard(files, { index: shard, total: 8 }).includes(regression),
		);
		expect(assignedShards).toHaveLength(1);
		const regressionIndex = files.indexOf(regression);
		expect(regressionIndex).toBeGreaterThanOrEqual(0);
		const expectedShard = (regressionIndex % 8) + 1;
		expect(assignedShards).toEqual([expectedShard]);
		expect(selectShard(files, { index: expectedShard, total: 8 })).toContain(regression);
	});

	test("keeps Bun shard assignment deterministic", () => {
		const files = ["a", "b", "c", "d", "e"];
		expect(selectShard(files, { index: 1, total: 2 })).toEqual(["a", "c", "e"]);
		expect(selectShard(files, { index: 2, total: 2 })).toEqual(["b", "d"]);
	});

	test("constructs argv safely, runs from repository root, and pins the root preload", () => {
		const spec = buildTestProcessSpec(
			"packages/coding-agent/test/path with spaces.test.ts",
			"/tmp/sandbox with spaces",
			30_000,
			"/repo root",
			{
				PATH: "/bin",
				ANTHROPIC_API_KEY: "host-secret",
				ANTHROPIC_BASE_URL: "https://host.invalid",
				GEMINI_API_KEY: "host-secret",
				MISTRAL_API_KEY: "host-secret",
				AWS_SECRET_ACCESS_KEY: "host-secret",
				OPENAI_API_KEY: "host-secret",
			},
		);
		expect(spec.argv).toEqual([
			"bun",
			"test",
			"--timeout=30000",
			"--preload",
			"./scripts/test-preload.ts",
			"./packages/coding-agent/test/path with spaces.test.ts",
		]);
		expect(spec.cwd).toBe("/repo root");
		expect(spec.argv).not.toContain("--isolate");
		expect(spec.env.HOME).toBe("/tmp/sandbox with spaces/home");
		expect(spec.env.GJC_HOME).toBe("/tmp/sandbox with spaces/gjc-home");
		expect(spec.env.XDG_STATE_HOME).toBe("/tmp/sandbox with spaces/xdg/state");
		expect(spec.env.XDG_RUNTIME_DIR).toBe("/tmp/sandbox with spaces/xdg/runtime");
		expect(spec.env.GJC_CODING_AGENT_DIR).toBeUndefined();
		expect(spec.env.GJC_SESSION_ID).toBeUndefined();
		expect(spec.env.GJC_STATE_ROOT).toBeUndefined();
		expect(spec.env.E2E).toBeUndefined();
		expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(spec.env.ANTHROPIC_BASE_URL).toBeUndefined();
		expect(spec.env.GEMINI_API_KEY).toBeUndefined();
		expect(spec.env.MISTRAL_API_KEY).toBeUndefined();
		expect(spec.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(spec.env.OPENAI_API_KEY).toBeUndefined();
	});

	test("preserves credentials and provider endpoints for explicit E2E children", () => {
		const spec = buildTestProcessSpec(
			"packages/ai/test/oauth.test.ts",
			"/tmp/e2e-sandbox",
			30_000,
			"/repo",
			{
				E2E: "true",
				OPENAI_API_KEY: "e2e-key",
				OPENAI_BASE_URL: "https://e2e-provider.invalid/v1",
				AWS_SECRET_ACCESS_KEY: "e2e-secret",
			},
		);
		expect(spec.env.E2E).toBe("true");
		expect(spec.env.OPENAI_API_KEY).toBe("e2e-key");
		expect(spec.env.OPENAI_BASE_URL).toBe("https://e2e-provider.invalid/v1");
		expect(spec.env.AWS_SECRET_ACCESS_KEY).toBe("e2e-secret");
	});

	test("fresh children prevent process environment and global state leaks", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dir, ".run-bun-test-contamination-"));
		tempDirs.push(root);
		await fs.mkdir(path.join(root, "scripts"), { recursive: true });
		await Bun.write(path.join(root, "scripts", "test-preload.ts"), "export {};\n");
		await fs.mkdir(path.join(root, "tests"), { recursive: true });
		await Bun.write(
			path.join(root, "tests", "01-leak.test.ts"),
			'import { test } from "bun:test"; test("leak shared state", () => { process.env.GJC_TEST_NUDGE_BUDGET = "10"; (globalThis as Record<string, unknown>).sdkMemoryStartup = Promise.resolve(); });\n',
		);
		await Bun.write(
			path.join(root, "tests", "02-sdk-memory-startup.test.ts"),
			'import { expect, test } from "bun:test"; test("sdk startup still rejects", async () => { expect((globalThis as Record<string, unknown>).sdkMemoryStartup).toBeUndefined(); await expect(Promise.reject(new Error("startup rejected"))).rejects.toThrow("startup rejected"); });\n',
		);
		await Bun.write(
			path.join(root, "tests", "03-ultragoal-nudge-guard.test.ts"),
			'import { expect, test } from "bun:test"; test("nudge budget stays private", () => { expect(Number(process.env.GJC_TEST_NUDGE_BUDGET ?? "3")).toBe(3); });\n',
		);
		expect(
			await runHarness({ root: "tests", testTimeoutMs: 30_000, fileTimeoutMs: 30_000, concurrency: 1 }, undefined, root),
		).toBe(0);
	});

	test("the two exact shard-6 regression files receive distinct process specs", async () => {
		const root = path.join(import.meta.dir, "..");
		const files = [
			"packages/coding-agent/test/sdk-memory-startup.test.ts",
			"packages/coding-agent/test/gjc-runtime/ultragoal-nudge-guard.test.ts",
		];
		const sandboxes = await Promise.all(files.map(() => fs.mkdtemp(path.join(os.tmpdir(), "gjc-exact-leak-spec-"))));
		tempDirs.push(...sandboxes);
		const specs = files.map((file, index) => buildTestProcessSpec(file, sandboxes[index]!, 30_000, root));
		expect(specs.map(spec => spec.file)).toEqual(files);
		expect(specs[0]?.argv.at(-1)).toBe(`./${files[0]}`);
		expect(specs[1]?.argv.at(-1)).toBe(`./${files[1]}`);
		expect(specs[0]?.env.HOME).not.toBe(specs[1]?.env.HOME);
		expect(specs[0]?.env.XDG_STATE_HOME).not.toBe(specs[1]?.env.XDG_STATE_HOME);
		expect(specs[0]?.env.GJC_HOME).not.toBe(specs[1]?.env.GJC_HOME);
	});

	test("runs every file and aggregates non-zero, signal, and timeout failures", async () => {
		const root = await fixture();
		const seen: string[] = [];
		const runner: TestProcessRunner = async spec => {
			seen.push(spec.file);
			if (spec.file.includes("alpha")) return { exitCode: 0, timedOut: false };
			if (spec.file.includes("beta")) return { exitCode: 143, signal: "SIGTERM", timedOut: false };
			return { exitCode: 137, signal: "SIGKILL", timedOut: true };
		};
		expect(
			await runHarness({ root: "tests", testTimeoutMs: 30_000, fileTimeoutMs: 50, concurrency: 1 }, runner, root),
		).toBe(1);
		expect(seen).toEqual([
			"tests/alpha.test.ts",
			"tests/nested dir/beta spec.spec.ts",
			"tests/test_gamma.ts",
		]);
	});

	test("a real timed-out child has its process group terminated", async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-bun-test-timeout-"));
		tempDirs.push(root);
		await fs.mkdir(path.join(root, "scripts"), { recursive: true });
		await Bun.write(path.join(root, "scripts", "test-preload.ts"), "export {};\n");
		await fs.mkdir(path.join(root, "tests"), { recursive: true });
		const pidFile = path.join(root, "descendant.pid");
		await Bun.write(
			path.join(root, "tests", "timeout.test.ts"),
			'import { test } from "bun:test"; import * as fs from "node:fs/promises"; test("hang", async () => { const child = Bun.spawn(["bun", "-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }); const stat = await fs.readFile(`/proc/${child.pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); await fs.writeFile(process.env.DESCENDANT_PID!, `${child.pid}:${fields[19]}`); await new Promise(() => {}); });\n',
		);
		const priorPidFile = process.env.DESCENDANT_PID;
		process.env.DESCENDANT_PID = pidFile;
		let exitCode: number;
		try {
			exitCode = await runHarness(
					{ root: "tests", testTimeoutMs: 60_000, fileTimeoutMs: 5_000, concurrency: 1 },
				undefined,
				root,
			);
		} finally {
			if (priorPidFile === undefined) delete process.env.DESCENDANT_PID;
			else process.env.DESCENDANT_PID = priorPidFile;
		}
		expect(exitCode).toBe(1);
		const [pidText, startTime] = (await Bun.file(pidFile).text()).trim().split(":");
		const descendantPid = Number(pidText);
		expect(descendantPid).toBeInteger();
		const observed = await probeLinuxProcess(descendantPid);
		if (observed?.startTime === startTime) expect(await processIdentityIsExecuting(observed)).toBe(false);
	}, 20_000);

	test("a normally exited test file cannot leave an active descendant", async () => {
		if (process.platform !== "linux") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-bun-test-clean-exit-"));
		tempDirs.push(root);
		await fs.mkdir(path.join(root, "scripts"), { recursive: true });
		await Bun.write(path.join(root, "scripts", "test-preload.ts"), "export {};\n");
		await fs.mkdir(path.join(root, "tests"), { recursive: true });
		const pidFile = path.join(root, "descendant.pid");
		await Bun.write(
			path.join(root, "tests", "background.test.ts"),
			'import { test } from "bun:test"; import * as fs from "node:fs/promises"; test("background", async () => { const child = Bun.spawn(["bun", "-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }); const stat = await fs.readFile(`/proc/${child.pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); await fs.writeFile(process.env.DESCENDANT_PID!, `${child.pid}:${fields[19]}`); child.unref(); });\n',
		);
		const priorPidFile = process.env.DESCENDANT_PID;
		process.env.DESCENDANT_PID = pidFile;
		let exitCode: number;
		try {
			exitCode = await runHarness(
				{ root: "tests", testTimeoutMs: 30_000, fileTimeoutMs: 30_000, concurrency: 1 },
				undefined,
				root,
			);
		} finally {
			if (priorPidFile === undefined) delete process.env.DESCENDANT_PID;
			else process.env.DESCENDANT_PID = priorPidFile;
		}
		expect(exitCode).toBe(0);
		const [pidText, startTime] = (await Bun.file(pidFile).text()).trim().split(":");
		const observed = await probeLinuxProcess(Number(pidText));
		if (observed?.startTime === startTime) expect(await processIdentityIsExecuting(observed)).toBe(false);
	});

	test("SIGTERM cleans up the active test process group before the harness exits", async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(import.meta.dir, ".run-bun-test-signal-"));
		tempDirs.push(root);
		await fs.mkdir(path.join(root, "scripts"), { recursive: true });
		await Bun.write(path.join(root, "scripts", "test-preload.ts"), "export {};\n");
		await fs.mkdir(path.join(root, "tests"), { recursive: true });
		const pidFile = path.join(root, "descendant.pid");
		await Bun.write(
			path.join(root, "tests", "signal.test.ts"),
			`import { test } from "bun:test";\nimport * as fs from "node:fs/promises";\ntest("hang", async () => { const child = Bun.spawn(["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }); const stat = await fs.readFile(\`/proc/\${child.pid}/stat\`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); await fs.writeFile(process.env.DESCENDANT_PID!, \`\${child.pid}:\${fields[19]}\`); await new Promise(() => {}); });\n`,
		);
		const harness = Bun.spawn(
			[
				"bun",
				path.join(import.meta.dir, "run-bun-test-files.ts"),
				`--root=${path.relative(path.join(import.meta.dir, ".."), path.join(root, "tests"))}`,
				"--timeout=60000",
				"--file-timeout=60000",
			],
			{
				cwd: path.join(import.meta.dir, ".."),
				env: { ...process.env, DESCENDANT_PID: pidFile },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		let descendantPid: number | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await Bun.file(pidFile).exists()) {
				descendantPid = Number((await Bun.file(pidFile).text()).trim().split(":")[0]);
				break;
			}
			await Bun.sleep(20);
		}
		expect(descendantPid).toBeInteger();
		harness.kill("SIGTERM");
		expect(await harness.exited).toBe(143);
		const startTime = (await Bun.file(pidFile).text()).trim().split(":")[1];
		for (let attempt = 0; attempt < 100; attempt++) {
			const observed = await probeLinuxProcess(descendantPid!);
			if (!observed || observed.startTime !== startTime || !(await processIdentityIsExecuting(observed))) return;
			await Bun.sleep(20);
		}
		throw new Error(`Descendant process ${descendantPid} survived harness SIGTERM cleanup.`);
	});
});
