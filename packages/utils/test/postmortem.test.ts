import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isKnownSinkPeerClosedError } from "../src/broken-pipe";

interface ScenarioResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface FixtureResult {
	count: number;
	exitBeforeCleanupFinished?: boolean;
}

const fixturePath = path.join(import.meta.dir, "postmortem-fixture.ts");
const utilsDirectory = path.join(import.meta.dir, "..");

async function captureProcess(command: string[], cwd: string): Promise<ScenarioResult> {
	const proc = Bun.spawn(command, {
		cwd,
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

async function runScenario(scenario: string): Promise<ScenarioResult> {
	return captureProcess([process.execPath, fixturePath, scenario], utilsDirectory);
}

async function runPipelineCommand(command: readonly string[]): Promise<ScenarioResult> {
	return captureProcess(
		["bash", "-o", "pipefail", "-c", '"$@" | true', "postmortem-pipeline", ...command],
		utilsDirectory,
	);
}

async function runPipelineScenario(scenario: string, extraArgs: readonly string[] = []): Promise<ScenarioResult> {
	return runPipelineCommand([process.execPath, fixturePath, scenario, ...extraArgs]);
}

function parseResult(stdout: string): FixtureResult {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) {
		throw new Error("postmortem fixture produced no JSON result");
	}
	return JSON.parse(line) as FixtureResult;
}

function combinedOutput(result: ScenarioResult): string {
	return `${result.stdout}\n${result.stderr}`;
}

function hasRecursiveCleanupError(stderr: string): boolean {
	return stderr.includes('"level":"error"') && stderr.includes('"message":"Cleanup invoked recursively"');
}

function expectOrdinaryFatal(result: ScenarioResult, label: string, message: string): void {
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain(`[${label}]`);
	expect(result.stderr).toContain(message);
}

describe("postmortem cleanup re-entry", () => {
	it("does not log an error when the exit handler re-enters while cleanup is running", async () => {
		const result = await runScenario("exit-reentry-while-running");

		expect(result.exitCode).toBe(0);
		expect(parseResult(result.stdout).count).toBe(1);
		expect(hasRecursiveCleanupError(combinedOutput(result))).toBe(false);
	});

	it("keeps the recursive cleanup error for non-exit re-entry", async () => {
		const result = await runScenario("non-exit-recursive-cleanup");

		expect(result.exitCode).toBe(0);
		expect(parseResult(result.stdout).count).toBe(1);
		expect(hasRecursiveCleanupError(combinedOutput(result))).toBe(true);
		expect(combinedOutput(result)).toContain('"stack"');
	});

	it("waits for cleanup when synchronous re-entry calls quit", async () => {
		const result = await runScenario("quit-reentry-waits-for-cleanup");

		expect(result.exitCode).toBe(0);
		expect(parseResult(result.stdout)).toEqual({ count: 2, exitBeforeCleanupFinished: false });
	});

	it("keeps completed cleanup a no-op when the exit handler fires", async () => {
		const result = await runScenario("completed-cleanup-exit-noop");

		expect(result.exitCode).toBe(0);
		expect(parseResult(result.stdout).count).toBe(1);
		expect(hasRecursiveCleanupError(combinedOutput(result))).toBe(false);
	});
});

describe("known-sink peer closure classification", () => {
	it("accepts structural errors without requiring Error instances", () => {
		expect(isKnownSinkPeerClosedError({ code: "EPIPE" })).toBe(true);
		expect(isKnownSinkPeerClosedError({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
		expect(isKnownSinkPeerClosedError({ code: "ECONNRESET" })).toBe(false);
	});
});

describe("postmortem process stdout EPIPE policy", () => {
	it("exits quietly with 141 for a synchronous actual stdout pipe EPIPE", async () => {
		const result = await runPipelineScenario("broken-pipe-stdout-write");

		expect(result.exitCode).toBe(141); // 128 + SIGPIPE
		expect(result.stderr).not.toContain("[Uncaught Exception]");
		expect(result.stderr).not.toContain("EPIPE");
	}, 15_000);

	it("exits quietly with 141 for an attributed stdout EPIPE unhandled rejection", async () => {
		const result = await runPipelineScenario("broken-pipe-unhandled-rejection");

		expect(result.exitCode).toBe(141);
		expect(result.stderr).not.toContain("[Unhandled Rejection]");
		expect(result.stderr).not.toContain("EPIPE");
	}, 15_000);

	it("accepts an unmarked structural rejection only with process stdout's exact write descriptor", async () => {
		const result = await runScenario("stdout-fd-unhandled-rejection");

		expect(result.exitCode).toBe(141);
		expect(result.stderr).not.toContain("[Unhandled Rejection]");
	}, 15_000);

	it("runs quiet cleanup once and suppresses cleanup-failure logging", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-quiet-cleanup-"));
		const resultPath = path.join(temporaryDirectory, "result.json");
		try {
			const result = await runPipelineScenario("quiet-cleanup-failure", [resultPath]);

			expect(result.exitCode).toBe(141);
			expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual({ count: 1 });
			expect(result.stderr).not.toContain("Cleanup callback failed");
			expect(result.stderr).not.toContain("Cleanup invoked recursively");
			expect(result.stderr).not.toContain("EPIPE");
		} finally {
			await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 15_000);

	it("runs late quiet-cleanup registrations without diagnostics", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-quiet-late-registration-"));
		const resultPath = path.join(temporaryDirectory, "result.json");
		try {
			const result = await runPipelineScenario("quiet-cleanup-late-registration", [resultPath]);

			expect(result.exitCode).toBe(141);
			expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual({ count: 2 });
			expect(result.stderr).not.toContain("Cleanup callback failed");
			expect(result.stderr).not.toContain("Cleanup invoked recursively");
		} finally {
			await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 15_000);

	it("keeps a later ordinary fatal diagnostic and status 1 without rerunning quiet cleanup", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-ordinary-fatal-"));
		const resultPath = path.join(temporaryDirectory, "result.json");
		try {
			const result = await runPipelineScenario("quiet-cleanup-ordinary-fatal", [resultPath]);

			expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual({ count: 1 });
			expectOrdinaryFatal(result, "Uncaught Exception", "fixture: ordinary fatal during quiet cleanup");
			expect(combinedOutput(result)).not.toContain('"message":"Uncaught exception"');
		} finally {
			await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 15_000);

	it("keeps an earlier ordinary fatal status and cleanup behavior when stdout EPIPE arrives later", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-ordinary-first-"));
		const resultPath = path.join(temporaryDirectory, "result.json");
		try {
			const result = await runPipelineScenario("ordinary-fatal-then-broken-pipe", [resultPath]);

			expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual({ count: 1 });
			expectOrdinaryFatal(result, "Uncaught Exception", "fixture: ordinary fatal before quiet EPIPE");
		} finally {
			await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	}, 15_000);

	it("keeps a socket send EPIPE fatal even when its fd is process stdout", async () => {
		const result = await runScenario("socket-send-epipe");

		expectOrdinaryFatal(result, "Uncaught Exception", "fixture: socket send EPIPE");
	}, 15_000);

	it("keeps an unrelated write EPIPE with another open fd fatal", async () => {
		const result = await runScenario("unrelated-fd-write-epipe");

		expectOrdinaryFatal(result, "Uncaught Exception", "fixture: unrelated fd write EPIPE");
	}, 15_000);

	it("keeps missing syscall and invalid descriptor evidence fatal", async () => {
		const missingSyscall = await runScenario("stdout-fd-missing-syscall-epipe");
		const missingFd = await runScenario("missing-fd-write-epipe");
		const invalid = await runScenario("invalid-fd-write-epipe");
		const closed = await runScenario("closed-fd-write-epipe");
		const reused = await runScenario("reused-fd-write-epipe");

		expectOrdinaryFatal(missingSyscall, "Uncaught Exception", "fixture: stdout fd EPIPE without syscall");
		expectOrdinaryFatal(missingFd, "Uncaught Exception", "fixture: missing fd write EPIPE");
		expectOrdinaryFatal(invalid, "Uncaught Exception", "fixture: invalid fd write EPIPE");
		expectOrdinaryFatal(closed, "Uncaught Exception", "fixture: closed fd write EPIPE");
		expectOrdinaryFatal(reused, "Uncaught Exception", "fixture: reused fd write EPIPE");
	}, 15_000);

	it("keeps ERR_STREAM_DESTROYED fatal at process scope", async () => {
		const result = await runScenario("destroyed-stream-error");

		expectOrdinaryFatal(result, "Uncaught Exception", "fixture: destroyed stream");
	}, 15_000);

	it("keeps non-pipe exceptions and rejections unchanged", async () => {
		const exception = await runScenario("non-pipe-uncaught-exception");
		const rejection = await runScenario("non-pipe-unhandled-rejection");

		expectOrdinaryFatal(exception, "Uncaught Exception", "fixture: genuine fatal error");
		expectOrdinaryFatal(rejection, "Unhandled Rejection", "fixture: genuine rejected fatal error");
	}, 15_000);
});
