import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `PI_COMPILED` is a build-script marker for a standalone binary. A repository
 * `.env` must not install it: foreground `gjc sdk broker run` loads project
 * dotenv in-process. Bun autoloads cwd/.env, and the env module copies the
 * project `.env` itself when autoload is off, so both paths are exercised.
 * A value exported by the launching shell stays in place unless it is the
 * same string the project declares.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "pi-compiled-env-probe.ts");
const KEY = "PI_COMPILED";

const tempDirs: string[] = [];

function tempDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-pi-compiled-dotenv-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, options: { autoload: boolean; inherited?: string }): Promise<string | null> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}
	delete env[KEY];
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	if (options.inherited !== undefined) env[KEY] = options.inherited;

	const args = options.autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { value: string | null }).value;
}

describe.each([
	["Bun dotenv autoload", true],
	["no dotenv autoload", false],
] as const)("PI_COMPILED project dotenv boundary (%s)", (_label, autoload) => {
	it("drops a value declared by the project .env", async () => {
		expect(await resolveIn(tempDir(`${KEY}=true\n`), { autoload })).toBeNull();
	});

	it("drops a dynamic project declaration", async () => {
		expect(await resolveIn(tempDir(`COMPILED=true\n${KEY}=$COMPILED\n`), { autoload })).toBeNull();
	});

	it("keeps a value inherited from the launching shell", async () => {
		expect(await resolveIn(tempDir(), { autoload, inherited: "true" })).toBe("true");
	});

	it("does not let the project .env replace an inherited value", async () => {
		expect(await resolveIn(tempDir(`${KEY}=true\n`), { autoload, inherited: "1" })).toBe("1");
	});

	it("drops an inherited value equal to the project declaration", async () => {
		expect(await resolveIn(tempDir(`${KEY}=true\n`), { autoload, inherited: "true" })).toBeNull();
	});
});
