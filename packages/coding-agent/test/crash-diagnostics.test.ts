import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyProcessCrash,
	formatCrashDiagnosticNotice,
	writeCrashReport,
} from "@gajae-code/coding-agent/debug/crash-diagnostics";
import { executeBash } from "@gajae-code/coding-agent/exec/bash-executor";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-diagnostics-test-"));
	tempDirs.push(dir);
	return dir;
}

async function modeOf(targetPath: string): Promise<number> {
	return (await fs.stat(targetPath)).mode & 0o777;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
	delete process.env.GJC_CRASH_DIAGNOSTICS;
	delete process.env.GJC_CRASH_DIAGNOSTICS_DIR;
});

describe("crash diagnostics", () => {
	it("classifies subprocess crash classes consistently", () => {
		expect(classifyProcessCrash({ kind: "bash", exitCode: 0 }).class).toBe("clean_exit");
		expect(classifyProcessCrash({ kind: "bash", exitCode: 2 }).class).toBe("non_zero_exit");
		expect(classifyProcessCrash({ kind: "python", signal: "SIGSEGV" }).class).toBe("signal_exit");
		expect(classifyProcessCrash({ kind: "dap", timedOut: true }).class).toBe("timeout");
		expect(classifyProcessCrash({ kind: "lsp", cancelled: true }).crashed).toBe(false);
		expect(classifyProcessCrash({ kind: "mcp", spawnError: new Error("missing") }).class).toBe("spawn_error");
		expect(classifyProcessCrash({ kind: "browser" }).class).toBe("protocol_exit");
	});

	it("writes opt-in structured reports only for crashed classes", async () => {
		const dir = await makeTempDir();
		const env = { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv;
		const clean = await writeCrashReport({ kind: "bash", exitCode: 0 }, { env, cwd: dir });
		expect(clean.path).toBeNull();

		const crashed = await writeCrashReport(
			{ kind: "python", exitCode: 139, stderr: "segmentation fault", protocol: "eval.py.kernel" },
			{ env, cwd: dir, now: new Date("2026-06-04T00:00:00.000Z") },
		);
		expect(crashed.path).not.toBeNull();
		expect(formatCrashDiagnosticNotice(crashed)).toContain("[crash:python:non_zero_exit]");
		const report = JSON.parse(await Bun.file(crashed.path as string).text()) as Record<string, unknown>;
		expect(report.schemaVersion).toBe(1);
		expect(report.kind).toBe("python");
		expect(report.class).toBe("non_zero_exit");
		expect(report.stderrPreview).toBe("segmentation fault");
	});

	it("creates private diagnostics directories and reports under umask 022", async () => {
		const dir = await makeTempDir();
		await fs.chmod(dir, 0o755);
		const env = { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv;
		const previousUmask = process.umask(0o022);
		try {
			const crashed = await writeCrashReport(
				{ kind: "python", exitCode: 139, stderr: "secret-token" },
				{ env, cwd: dir, now: new Date("2026-06-04T00:00:01.000Z") },
			);

			expect(crashed.path).not.toBeNull();
			expect(await modeOf(dir)).toBe(0o700);
			expect(await modeOf(crashed.path as string)).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("creates the default diagnostics directory and reports privately under umask 022", async () => {
		const tempRoot = await makeTempDir();
		const previousTmpdir = process.env.TMPDIR;
		const previousUmask = process.umask(0o022);
		process.env.TMPDIR = tempRoot;
		try {
			const env = { GJC_CRASH_DIAGNOSTICS: "1" } as NodeJS.ProcessEnv;
			const crashed = await writeCrashReport(
				{ kind: "worker", exitCode: 1, stderr: "secret-token" },
				{ env, cwd: tempRoot, now: new Date("2026-06-04T00:00:02.000Z") },
			);

			expect(crashed.path).not.toBeNull();
			const defaultDir = path.join(tempRoot, "gjc-crash-diagnostics");
			expect(crashed.path?.startsWith(`${defaultDir}${path.sep}`)).toBe(true);
			expect(await modeOf(defaultDir)).toBe(0o700);
			expect(await modeOf(crashed.path as string)).toBe(0o600);
		} finally {
			process.umask(previousUmask);
			if (previousTmpdir === undefined) {
				delete process.env.TMPDIR;
			} else {
				process.env.TMPDIR = previousTmpdir;
			}
		}
	});

	it("appends a bash crash notice and artifact when diagnostics are enabled", async () => {
		const dir = await makeTempDir();
		process.env.GJC_CRASH_DIAGNOSTICS = "1";
		process.env.GJC_CRASH_DIAGNOSTICS_DIR = dir;

		const result = await executeBash("echo boom >&2; exit 7", { cwd: dir, timeout: 5000 });
		expect(result.exitCode).toBe(7);
		expect(result.output).toContain("[crash:bash:non_zero_exit]");

		const files = await fs.readdir(dir);
		const reportFile = files.find(file => file.includes("bash-non_zero_exit"));
		expect(reportFile).toBeDefined();
		const report = JSON.parse(await Bun.file(path.join(dir, reportFile as string)).text()) as Record<string, unknown>;
		expect(report.kind).toBe("bash");
		expect(report.class).toBe("non_zero_exit");
		expect(report.exitCode).toBe(7);
	});
});
