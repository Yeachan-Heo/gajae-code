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
import fc from "fast-check";

const tempDirs: string[] = [];

function isPrivilegedUser(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

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

	it.skipIf(process.platform === "win32")("refuses a pre-planted symlink diagnostics directory", async () => {
		const root = await makeTempDir();
		const victim = await plantedVictim(root);
		const link = path.join(root, "gjc-crash-diagnostics");
		await fs.symlink(victim, link, "dir");
		const previousTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = root;
		try {
			const crashed = await writeCrashReport(
				{ kind: "python", exitCode: 1, stderr: "secret-token" },
				{
					env: { GJC_CRASH_DIAGNOSTICS: "1" } as NodeJS.ProcessEnv,
					cwd: root,
					now: new Date("2026-06-04T00:00:03.000Z"),
				},
			);
			expect(crashed.path).toBeNull();
			await expectUntouched(victim);
		} finally {
			restoreTmpdir(previousTmpdir);
		}
	});

	it.skipIf(process.platform === "win32")(
		"refuses a diagnostics symlink with a trailing separator or dot segment",
		async () => {
			const root = await makeTempDir();
			const victim = await plantedVictim(root);
			const link = path.join(root, "diagnostics-link");
			await fs.symlink(victim, link, "dir");
			const suffixes = ["/", "//", "///", "/.", "/./", "/.//"];
			for (const [index, suffix] of suffixes.entries()) {
				const crashed = await writeCrashReport(
					{ kind: "python", exitCode: 1, stderr: "secret-token" },
					{
						env: {
							GJC_CRASH_DIAGNOSTICS: "1",
							GJC_CRASH_DIAGNOSTICS_DIR: `${link}${suffix}`,
						} as NodeJS.ProcessEnv,
						cwd: root,
						now: new Date(`2026-06-04T00:00:1${index}.000Z`),
					},
				);
				expect(crashed.path).toBeNull();
				await expectUntouched(victim);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"still allows a real diagnostics directory with a trailing separator",
		async () => {
			const root = await makeTempDir();
			const realDir = path.join(root, "diagnostics");
			await fs.mkdir(realDir, { mode: 0o755 });
			const parent = path.join(root, "real-parent");
			await fs.mkdir(parent, { mode: 0o755 });
			const parentLink = path.join(root, "parent-link");
			await fs.symlink(parent, parentLink, "dir");
			const cases = [`${realDir}/`, `${realDir}/.`, `${path.join(parentLink, "diagnostics")}/`];
			for (const [index, dir] of cases.entries()) {
				const crashed = await writeCrashReport(
					{ kind: "worker", exitCode: 1, stderr: "secret-token" },
					{
						env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
						cwd: root,
						now: new Date(`2026-06-04T00:01:0${index}.000Z`),
					},
				);
				expect(crashed.path).not.toBeNull();
				expect(await modeOf(path.dirname(await fs.realpath(crashed.path as string)))).toBe(0o700);
				expect(await modeOf(crashed.path as string)).toBe(0o600);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"still allows a diagnostics directory whose name ends with a backslash",
		async () => {
			const root = await makeTempDir();
			await expectBackslashNameKept(root, "diag\\", 0);
			await expectBackslashNameKept(root, "diag\\.", 1);
		},
	);

	it.skipIf(process.platform !== "darwin" || isPrivilegedUser())(
		"still allows an owner directory without read permission",
		async () => {
			const root = await makeTempDir();
			for (const [index, mode] of [0o300, 0o000].entries()) {
				const dir = path.join(root, `locked-${mode.toString(8)}`);
				await fs.mkdir(dir, { mode: 0o700 });
				await fs.chmod(dir, mode);
				try {
					const crashed = await writeCrashReport(
						{ kind: "python", exitCode: 1, stderr: "secret-token" },
						{
							env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
							cwd: root,
							now: new Date(`2026-06-04T00:05:0${index}.000Z`),
						},
					);
					expect(crashed.path).not.toBeNull();
					expect((await fs.lstat(dir)).mode & 0o777).toBe(0o700);
					expect(path.dirname(crashed.path as string)).toBe(dir);
					expect((await fs.readdir(dir)).includes(path.basename(crashed.path as string))).toBe(true);
				} finally {
					await fs.chmod(dir, 0o700);
				}
			}
		},
	);

	it.skipIf(process.platform !== "linux" || isPrivilegedUser())(
		"refuses an owner directory without read permission on linux",
		async () => {
			const root = await makeTempDir();
			for (const [index, mode] of [0o300, 0o000].entries()) {
				const dir = path.join(root, `locked-${mode.toString(8)}`);
				await fs.mkdir(dir, { mode: 0o700 });
				await fs.chmod(dir, mode);
				try {
					const crashed = await writeCrashReport(
						{ kind: "python", exitCode: 1, stderr: "secret-token" },
						{
							env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: dir } as NodeJS.ProcessEnv,
							cwd: root,
							now: new Date(`2026-06-04T00:06:0${index}.000Z`),
						},
					);
					expect(crashed.path).toBeNull();
					expect((await fs.lstat(dir)).mode & 0o777).toBe(mode);
				} finally {
					await fs.chmod(dir, 0o700);
				}
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"still allows a directory whose name looks like a drive letter",
		async () => {
			const root = await makeTempDir();
			const realDir = path.join(root, "C:");
			await fs.mkdir(realDir, { mode: 0o755 });
			const neighbor = path.join(root, "C:\\");
			await fs.mkdir(neighbor, { mode: 0o755 });
			await fs.writeFile(path.join(neighbor, "marker.txt"), "keep");
			await fs.chmod(neighbor, 0o755);
			const crashed = await writeCrashReport(
				{ kind: "worker", exitCode: 1, stderr: "ok" },
				{
					env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: `${realDir}/` } as NodeJS.ProcessEnv,
					cwd: root,
					now: new Date("2026-06-04T00:03:00.000Z"),
				},
			);
			expect(crashed.path).not.toBeNull();
			expect(path.dirname(crashed.path as string)).toBe(realDir);
			expect(await modeOf(neighbor)).toBe(0o755);
			expect(await fs.readdir(neighbor)).toEqual(["marker.txt"]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps backslash names inside the named directory, seed 342, 64 inputs",
		async () => {
			const root = await makeTempDir();
			let sampleIndex = 0;
			const sample = fc.record({
				stem: fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/),
				tail: fc.constantFrom("", "\\", "\\.", "\\\\"),
				suffix: fc.constantFrom("", "/", "//", "/.", "/./"),
			});
			await fc.assert(
				fc.asyncProperty(sample, async ({ stem, tail, suffix }) => {
					const id = sampleIndex;
					sampleIndex += 1;
					await expectBackslashNameKept(root, `n${id}${stem}${tail}`, id, suffix);
				}),
				{
					seed: 342,
					numRuns: 64,
					examples: [
						[{ stem: "diag", tail: "\\", suffix: "" }],
						[{ stem: "diag", tail: "\\.", suffix: "" }],
						[{ stem: "diag", tail: "\\", suffix: "/" }],
						[{ stem: "diag", tail: "\\.", suffix: "/." }],
					],
				},
			);
		},
	);
});

async function plantedVictim(root: string): Promise<string> {
	const victim = path.join(root, "victim");
	await fs.mkdir(victim, { mode: 0o755 });
	await fs.chmod(victim, 0o755);
	await fs.writeFile(path.join(victim, "marker.txt"), "keep");
	return victim;
}

async function expectUntouched(victim: string): Promise<void> {
	expect(await modeOf(victim)).toBe(0o755);
	expect(await fs.readdir(victim)).toEqual(["marker.txt"]);
}

function restoreTmpdir(previousTmpdir: string | undefined): void {
	if (previousTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmpdir;
}

async function expectBackslashNameKept(root: string, name: string, index: number, suffix = ""): Promise<void> {
	const realDir = path.join(root, name);
	await fs.mkdir(realDir, { mode: 0o755 });
	const neighbors = new Set<string>();
	const withoutBackslash = name.replaceAll("\\", "");
	if (withoutBackslash !== name && withoutBackslash !== "" && withoutBackslash !== "." && withoutBackslash !== "..") {
		neighbors.add(withoutBackslash);
	}
	if (name.endsWith("\\.") && !name.endsWith("\\..")) {
		const stripped = name.slice(0, -2);
		if (stripped !== "" && stripped !== "." && stripped !== "..") neighbors.add(stripped);
	}
	const markers = new Map<string, string>();
	for (const neighborName of neighbors) {
		const neighbor = path.join(root, neighborName);
		if (neighbor === realDir) continue;
		await fs.mkdir(neighbor, { recursive: true, mode: 0o755 });
		await fs.writeFile(path.join(neighbor, "marker.txt"), "keep");
		await fs.chmod(neighbor, 0o755);
		markers.set(neighbor, "keep");
	}
	const crashed = await writeCrashReport(
		{ kind: "python", exitCode: 1, stderr: "ok" },
		{
			env: { GJC_CRASH_DIAGNOSTICS: "1", GJC_CRASH_DIAGNOSTICS_DIR: `${realDir}${suffix}` } as NodeJS.ProcessEnv,
			cwd: root,
			now: new Date(Date.UTC(2026, 5, 4, 0, 4, index)),
		},
	);
	expect(crashed.path).not.toBeNull();
	const reportPath = crashed.path as string;
	expect(path.dirname(reportPath)).toBe(realDir);
	expect((await fs.readdir(realDir)).includes(path.basename(reportPath))).toBe(true);
	expect((await fs.lstat(reportPath)).isFile()).toBe(true);
	for (const [neighbor, marker] of markers) {
		expect(await modeOf(neighbor)).toBe(0o755);
		expect(await fs.readFile(path.join(neighbor, "marker.txt"), "utf8")).toBe(marker);
		expect(await fs.readdir(neighbor)).toEqual(["marker.txt"]);
	}
}
