import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The browser launch overrides choose which binary runs and how its traffic is
 * routed and verified:
 *
 * - `PUPPETEER_EXECUTABLE_PATH` becomes `puppeteer.launch({ executablePath })`
 * - `PUPPETEER_PROXY` becomes `--proxy-server=...`
 * - `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` becomes `--ignore-certificate-errors`
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could plant `.env` and pick
 * the executable, intercept every request, or disable certificate validation.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "..", "..", "fixtures", "browser-env-probe.ts");
const BROWSER_KEYS = [
	"PUPPETEER_EXECUTABLE_PATH",
	"PUPPETEER_PROXY",
	"PUPPETEER_PROXY_BYPASS_LOOPBACK",
	"PUPPETEER_PROXY_IGNORE_CERT_ERRORS",
	"LOCALAPPDATA",
	"CHROME_USER_DATA_DIR",
	"CHROME_CONFIG_HOME",
	"XDG_CONFIG_HOME",
	"ProgramFiles",
	"ProgramFiles(x86)",
] as const;

interface BrowserEnvOverrides {
	executablePath: string | undefined;
	proxy: string | undefined;
	proxyBypassLoopback: boolean;
	ignoreCertErrors: boolean;
	profileEnv: {
		localAppData?: string;
		chromeUserDataDir?: string;
		chromeConfigHome?: string;
		xdgConfigHome?: string;
	};
	programFiles?: string;
	programFilesX86?: string;
	localAppData?: string;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-trust-iso-"));
	tempDirs.push(dir);
	return dir;
}

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-browser-env-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<BrowserEnvOverrides> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak an override into the child.
	for (const key of BROWSER_KEYS) delete env[key];
	// `$credentialEnv` also consults file sources the child env cannot mask:
	// the agent `.env`, the GJC config `.env`, `~/.env` and the login shell rc
	// files. Point HOME and the agent dir at empty temp dirs so a contributor who
	// exports one of these names from a shell rc still sees a hermetic result.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as BrowserEnvOverrides;
}

describe("browser launch env trust boundary", () => {
	it("resolves no overrides when nothing sets them", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved).toEqual({
			executablePath: undefined,
			proxy: undefined,
			proxyBypassLoopback: false,
			ignoreCertErrors: false,
			profileEnv: {},
		});
	});

	it("ignores an executable path planted by the project .env", async () => {
		const cwd = projectDir("PUPPETEER_EXECUTABLE_PATH=/tmp/attacker-browser\n");
		expect((await resolveIn(cwd)).executablePath).toBeUndefined();
	});

	it("ignores a proxy planted by the project .env", async () => {
		const cwd = projectDir("PUPPETEER_PROXY=http://attacker.example:8080\n");
		expect((await resolveIn(cwd)).proxy).toBeUndefined();
	});

	it("ignores certificate-validation opt-out planted by the project .env", async () => {
		const cwd = projectDir("PUPPETEER_PROXY_IGNORE_CERT_ERRORS=1\nPUPPETEER_PROXY_BYPASS_LOOPBACK=1\n");
		const resolved = await resolveIn(cwd);
		expect(resolved.ignoreCertErrors).toBe(false);
		expect(resolved.proxyBypassLoopback).toBe(false);
	});

	it("still honors overrides inherited from the launching shell", async () => {
		const resolved = await resolveIn(projectDir(), {
			PUPPETEER_EXECUTABLE_PATH: "/opt/chrome/chrome",
			PUPPETEER_PROXY: "http://localhost:8080",
			PUPPETEER_PROXY_IGNORE_CERT_ERRORS: "true",
		});
		expect(resolved.executablePath).toBe("/opt/chrome/chrome");
		expect(resolved.proxy).toBe("http://localhost:8080");
		expect(resolved.ignoreCertErrors).toBe(true);
	});

	it("does not let the project .env override inherited values", async () => {
		const cwd = projectDir("PUPPETEER_EXECUTABLE_PATH=/tmp/attacker-browser\n");
		expect((await resolveIn(cwd, { PUPPETEER_EXECUTABLE_PATH: "/opt/chrome/chrome" })).executablePath).toBe(
			"/opt/chrome/chrome",
		);
	});

	it("ignores profile discovery roots planted by the project .env", async () => {
		const cwd = projectDir(
			"LOCALAPPDATA=/repo/windows\nCHROME_USER_DATA_DIR=/repo/data\nCHROME_CONFIG_HOME=/repo/chrome\nXDG_CONFIG_HOME=/repo/xdg\n",
		);
		expect((await resolveIn(cwd)).profileEnv).toEqual({});
	});

	it("ignores Windows executable roots planted by the project .env", async () => {
		const cwd = projectDir("ProgramFiles=/repo/programs\nLOCALAPPDATA=/repo/local\n");
		const resolved = await resolveIn(cwd);
		expect(resolved.programFiles).toBeUndefined();
		expect(resolved.localAppData).toBeUndefined();
	});

	it("honors profile discovery roots inherited from the launching shell", async () => {
		const resolved = await resolveIn(projectDir(), {
			LOCALAPPDATA: "/trusted/windows",
			CHROME_USER_DATA_DIR: "/trusted/data",
			CHROME_CONFIG_HOME: "/trusted/chrome",
			XDG_CONFIG_HOME: "/trusted/xdg",
		});
		expect(resolved.profileEnv).toEqual({
			localAppData: "/trusted/windows",
			chromeUserDataDir: "/trusted/data",
			chromeConfigHome: "/trusted/chrome",
			xdgConfigHome: "/trusted/xdg",
		});
	});

	it("honors Windows executable roots inherited from the launching shell", async () => {
		const resolved = await resolveIn(projectDir(), {
			ProgramFiles: "C:\\Trusted\\Programs",
			LOCALAPPDATA: "C:\\Trusted\\Local",
		});
		expect(resolved.programFiles).toBe("C:\\Trusted\\Programs");
		expect(resolved.localAppData).toBe("C:\\Trusted\\Local");
	});
});
