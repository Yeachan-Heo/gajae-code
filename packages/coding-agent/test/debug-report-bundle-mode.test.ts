/**
 * `createReportBundle()` writes `gjc-report-*.tar.gz`.
 * A fresh path and an existing regular file still produce an archive.
 * A symlink already at that path is refused and its target stays unchanged.
 */
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getReportsDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { createReportBundle } from "../src/debug/report-bundle";

const FIXED_ISO = "2026-01-02T03:04:05.006Z";
const BUNDLE_NAME = `gjc-report-${FIXED_ISO.replace(/[:.]/g, "-")}.tar.gz`;
const skipPosix = process.platform === "win32";

async function symlinkSupported(): Promise<boolean> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-link-probe-"));
	try {
		const target = path.join(dir, "target");
		await fs.writeFile(target, "x");
		await fs.symlink(target, path.join(dir, "link"));
		return true;
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "EPERM" || code === "EACCES") return false;
		throw error;
	} finally {
		await safeRm(dir, { recursive: true, force: true });
	}
}

const canSymlink = await symlinkSupported();

function restoreVar(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function withReports<T>(run: (reportsDir: string) => Promise<T>): Promise<T> {
	const originalHome = process.env.HOME;
	const originalProfile = process.env.USERPROFILE;
	const originalConfig = process.env.GJC_CONFIG_DIR;
	const originalPiConfig = process.env.PI_CONFIG_DIR;
	const originalAgentEnv = process.env.GJC_CODING_AGENT_DIR;
	const originalLogDir = process.env.GJC_LOG_DIR;
	const originalAgent = getAgentDir();
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-mode-home-"));
	const agent = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-mode-agent-"));
	const logs = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-mode-log-"));
	const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
	const iso = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(FIXED_ISO);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.GJC_CONFIG_DIR = "gjc-report-mode";
	process.env.PI_CONFIG_DIR = "gjc-report-mode";
	setAgentDir(agent);
	process.env.GJC_LOG_DIR = logs;
	try {
		const reportsDir = getReportsDir();
		if (!reportsDir.startsWith(`${home}${path.sep}`)) {
			throw new Error("reports directory escaped the fixture home");
		}
		await fs.mkdir(reportsDir, { recursive: true });
		return await run(reportsDir);
	} finally {
		iso.mockRestore();
		homedir.mockRestore();
		restoreVar("GJC_LOG_DIR", originalLogDir);
		restoreVar("PI_CONFIG_DIR", originalPiConfig);
		restoreVar("GJC_CONFIG_DIR", originalConfig);
		restoreVar("GJC_CODING_AGENT_DIR", originalAgentEnv);
		setAgentDir(originalAgent);
		restoreVar("USERPROFILE", originalProfile);
		restoreVar("HOME", originalHome);
		await safeRm(agent, { recursive: true, force: true });
		await safeRm(logs, { recursive: true, force: true });
		await safeRm(home, { recursive: true, force: true });
	}
}

async function archiveEntryNames(archivePath: string): Promise<string[]> {
	const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
	const files = await archive.files();
	return [...files.keys()];
}

describe.serial("createReportBundle archive file", () => {
	test("still allows a new bundle at a fresh path", async () => {
		await withReports(async reportsDir => {
			const result = await createReportBundle({ sessionFile: undefined });
			expect(path.basename(result.path)).toBe(BUNDLE_NAME);
			expect(result.path.startsWith(`${reportsDir}${path.sep}`)).toBe(true);
			expect((await fs.lstat(result.path)).isSymbolicLink()).toBe(false);
			expect(await archiveEntryNames(result.path)).toContain("system.json");
		});
	});

	test("still allows replacing an existing regular bundle file", async () => {
		await withReports(async reportsDir => {
			const output = path.join(reportsDir, BUNDLE_NAME);
			await fs.writeFile(output, "not-an-archive");
			const result = await createReportBundle({ sessionFile: undefined });
			expect(result.path).toBe(output);
			expect((await fs.lstat(output)).isFile()).toBe(true);
			expect(await archiveEntryNames(output)).toContain("system.json");
		});
	});

	test.skipIf(skipPosix || !canSymlink)("refuses a pre-placed symlink and leaves the target unchanged", async () => {
		await withReports(async reportsDir => {
			const output = path.join(reportsDir, BUNDLE_NAME);
			const secret = path.join(reportsDir, "secret-target.txt");
			await fs.writeFile(secret, "SECRET-BYTES");
			await fs.symlink(secret, output);
			await expect(createReportBundle({ sessionFile: undefined })).rejects.toThrow(/not a regular file/);
			expect(await fs.readFile(secret, "utf8")).toBe("SECRET-BYTES");
			expect((await fs.lstat(output)).isSymbolicLink()).toBe(true);
		});
	});

	test.skipIf(skipPosix)("tightens an existing mode 0666 bundle file to 0600", async () => {
		await withReports(async reportsDir => {
			const output = path.join(reportsDir, BUNDLE_NAME);
			await fs.writeFile(output, "not-an-archive", { mode: 0o666 });
			await fs.chmod(output, 0o666);
			expect((await fs.lstat(output)).mode & 0o777).toBe(0o666);
			const result = await createReportBundle({ sessionFile: undefined });
			expect(result.path).toBe(output);
			expect((await fs.lstat(output)).mode & 0o777).toBe(0o600);
			expect(await archiveEntryNames(output)).toContain("system.json");
		});
	});

	test.skipIf(skipPosix)("creates the bundle as mode 0600 under a permissive umask", async () => {
		const previous = process.umask(0);
		try {
			await withReports(async reportsDir => {
				const result = await createReportBundle({ sessionFile: undefined });
				expect(result.path).toBe(path.join(reportsDir, BUNDLE_NAME));
				expect((await fs.lstat(result.path)).mode & 0o777).toBe(0o600);
			});
		} finally {
			process.umask(previous);
		}
	});
});
