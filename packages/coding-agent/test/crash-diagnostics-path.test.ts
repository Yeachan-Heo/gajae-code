import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@gajae-code/utils";
import { formatCrashDiagnosticNotice, writeCrashReport } from "../src/debug/crash-diagnostics";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-path-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("crash diagnostics path", () => {
	it("does not follow a project dotenv directory or chmod a symlink target", async () => {
		const cwd = await makeTempDir();
		const planted = path.join(cwd, "planted");
		const real = path.join(cwd, "real");
		const link = path.join(cwd, "link");
		await fs.mkdir(real);
		await fs.chmod(real, 0o755);
		await fs.symlink(real, link);
		await fs.writeFile(path.join(cwd, ".env"), `GJC_CRASH_DIAGNOSTICS_DIR=${planted}\n`);
		const fromDotenv = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom" },
			{
				cwd,
				envSourceCwd: cwd,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: planted } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:03.000Z"),
			},
		);
		expect(fromDotenv.path === null || !fromDotenv.path.startsWith(planted)).toBe(true);
		await expect(fs.stat(planted)).rejects.toThrow();

		const viaLink = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom" },
			{
				cwd,
				envSourceCwd: cwd,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: link } as NodeJS.ProcessEnv,
			},
		);
		expect(viaLink.path).toBeNull();
		expect((await fs.stat(real)).mode & 0o777).toBe(0o755);
	});

	it("scrubs a persisted stderr secret", async () => {
		const dir = await makeTempDir();
		const crashed = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom sk-abcdefghijklmnop" },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:04.000Z"),
			},
		);
		const report = JSON.parse(await Bun.file(crashed.path as string).text()) as { stderrPreview?: string };
		expect(report.stderrPreview).not.toContain("sk-abcdefghijklmnop");
		expect(report.stderrPreview).toContain("«redacted-api-key»");
	});

	it("treats a commented project dotenv value as a project declaration", async () => {
		const cwd = await makeTempDir();
		const planted = path.join(cwd, "planted");
		await fs.writeFile(path.join(cwd, ".env"), `GJC_CRASH_DIAGNOSTICS_DIR=${planted} # comment\n`);
		const fromDotenv = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom" },
			{
				cwd,
				envSourceCwd: cwd,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: planted } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:05.000Z"),
			},
		);
		expect(fromDotenv.path === null || !fromDotenv.path.startsWith(planted)).toBe(true);
		await expect(fs.stat(planted)).rejects.toThrow();
	});

	it("scrubs a spawn error secret from the persisted reason and notice", async () => {
		const dir = await makeTempDir();
		const secret = "sk-abcdefghijklmnop";
		const crashed = await writeCrashReport(
			{ kind: "bash", spawnError: new Error(`spawn failed ${secret}`) },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:06.000Z"),
			},
		);
		const report = JSON.parse(await Bun.file(crashed.path as string).text()) as {
			reason: string;
			spawnError?: string;
		};
		expect(report.reason).not.toContain(secret);
		expect(report.reason).toContain("«redacted-api-key»");
		expect(report.spawnError).not.toContain(secret);
		const notice = formatCrashDiagnosticNotice(crashed);
		expect(notice).not.toContain(secret);
		expect(notice).toContain("«redacted-api-key»");
	});

	it("keeps a project crash directory ignored after the process cwd changes", async () => {
		const source = await makeTempDir();
		const destination = await makeTempDir();
		const planted = path.join(source, "planted");
		await fs.writeFile(path.join(source, ".env"), `GJC_CRASH_DIAGNOSTICS_DIR=${planted}\n`);
		const childEnv: Record<string, string | undefined> = { ...process.env, GJC_CRASH_DIAGNOSTICS: "1" };
		delete childEnv.GJC_CRASH_DIAGNOSTICS_DIR;
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "crash-diagnostics-cwd-pin.child.ts"), destination],
			{ cwd: source, env: childEnv, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr, `child exit ${exitCode}\n${stdout}`).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout.trim().startsWith(planted)).toBe(false);
		await expect(fs.stat(planted)).rejects.toThrow();
	});

	it("ignores a crash directory declared by the environment source when the command cwd differs", async () => {
		const source = await makeTempDir();
		const child = await makeTempDir();
		const planted = path.join(source, "planted");
		await fs.writeFile(path.join(source, ".env"), `GJC_CRASH_DIAGNOSTICS_DIR=${planted}\n`);
		const fromChild = await writeCrashReport(
			{ kind: "bash", exitCode: 1, stderr: "boom" },
			{
				cwd: child,
				envSourceCwd: source,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: planted } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:07.000Z"),
			},
		);
		expect(fromChild.path === null || !fromChild.path.startsWith(planted)).toBe(true);
		await expect(fs.stat(planted)).rejects.toThrow();
	});

	it("ignores a crash directory declared in the NODE_ENV dotenv layer", async () => {
		const source = await makeTempDir();
		const planted = path.join(source, "planted");
		const previous = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		try {
			await fs.writeFile(path.join(source, ".env.development"), `GJC_CRASH_DIAGNOSTICS_DIR=${planted}\n`);
			const fromLayer = await writeCrashReport(
				{ kind: "bash", exitCode: 1, stderr: "boom" },
				{
					cwd: source,
					envSourceCwd: source,
					env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: planted } as NodeJS.ProcessEnv,
					now: new Date("2026-06-04T00:00:08.000Z"),
				},
			);
			expect(fromLayer.path === null || !fromLayer.path.startsWith(planted)).toBe(true);
			await expect(fs.stat(planted)).rejects.toThrow();
		} finally {
			if (previous === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previous;
		}
	});

	it("scrubs a bearer token before the stderr preview drops its marker", async () => {
		const dir = await makeTempDir();
		const token = "A".repeat(32);
		const stderr = `Bearer ${token}${"x".repeat(4096)}`;
		const crashed = await writeCrashReport(
			{ kind: "lsp", exitCode: 1, stderr },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:09.000Z"),
			},
		);
		const report = JSON.parse(await Bun.file(crashed.path as string).text()) as { stderrPreview?: string };
		expect(report.stderrPreview).not.toContain(token);
		expect(report.stderrPreview).toContain("«redacted-auth»");
	});

	it("scrubs a bearer token retained after the stderr tail drops its marker", async () => {
		const dir = await makeTempDir();
		const token = `sk-${"A".repeat(16)}/${"B".repeat(32748)}`;
		const child = ptree.spawn([process.execPath, "-e", `process.stderr.write("Bearer ${token}"); process.exit(1);`]);
		await child.wait({ allowNonZero: true });
		const retained = child.peekStderr().trim();
		expect(retained.includes("Bearer")).toBe(false);
		expect(retained.length).toBeGreaterThan(4096);
		expect(retained.startsWith("sk-")).toBe(true);
		expect(retained.endsWith("B".repeat(64))).toBe(true);

		const crashed = await writeCrashReport(
			{ kind: "dap", exitCode: 1, stderr: retained },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:10.000Z"),
			},
		);
		const report = JSON.parse(await Bun.file(crashed.path as string).text()) as { stderrPreview?: string };
		expect(report.stderrPreview).not.toContain("B".repeat(64));
		expect(report.stderrPreview).not.toContain("sk-");
		expect(report.stderrPreview).toContain("«redacted-auth»");

		const withSuffix = await writeCrashReport(
			{ kind: "dap", exitCode: 1, stderr: `${retained}\nadapter exited` },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:10.500Z"),
			},
		);
		const suffixReport = JSON.parse(await Bun.file(withSuffix.path as string).text()) as { stderrPreview?: string };
		expect(suffixReport.stderrPreview).not.toContain("B".repeat(64));
		expect(suffixReport.stderrPreview).toContain("«redacted-auth»");
		expect(suffixReport.stderrPreview).toContain("adapter exited");

		const short = await writeCrashReport(
			{ kind: "dap", exitCode: 1, stderr: "A".repeat(32) },
			{
				cwd: dir,
				env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
				now: new Date("2026-06-04T00:00:11.000Z"),
			},
		);
		const shortReport = JSON.parse(await Bun.file(short.path as string).text()) as { stderrPreview?: string };
		expect(shortReport.stderrPreview).toBe("A".repeat(32));
	});
});
