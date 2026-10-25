import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `GJC_SDK_DISABLE=1` opts a top-level session out of SDK hosting. Session
 * startup and the harness owner read it from the process environment after
 * the env module loads, and a still-set value is copied into the child.
 * A repository dotenv file must not install it. Bun autoloads cwd dotenv,
 * and the env module copies the project files itself when autoload is off,
 * so both paths are exercised. A shell export stays unless it is the same
 * string the project declares, or the project declaration is dynamic.
 * A dynamic declaration drops a different shell value too, because the
 * source is ambiguous. A static project value that disagrees is kept.
 * An escaped dollar is a literal, so it does not drop a different shell value.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "sdk-disable-env-probe.ts");
const KEY = "GJC_SDK_DISABLE";

const tempDirs: string[] = [];

function tempDir(files?: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-disable-dotenv-"));
	tempDirs.push(dir);
	if (files) {
		for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
	}
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
	delete env.NODE_ENV;
	delete env.BUN_ENV;
	const home = tempDir();
	env.HOME = home;
	env.USERPROFILE = home;
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
] as const)("GJC_SDK_DISABLE project dotenv boundary (%s)", (_label, autoload) => {
	it("drops a project .env value from the spawned child environment", async () => {
		expect(await resolveIn(tempDir({ ".env": `${KEY}=1\n` }), { autoload })).toBeNull();
	});

	it("drops a dynamic project declaration from the spawned child environment", async () => {
		expect(await resolveIn(tempDir({ ".env": `ATTACK=1\n${KEY}=$ATTACK\n` }), { autoload })).toBeNull();
	});

	it("drops a double-quoted project value from the spawned child environment", async () => {
		expect(await resolveIn(tempDir({ ".env": `${KEY}="1"\n` }), { autoload })).toBeNull();
	});

	it("drops a .env.development value from the spawned child environment", async () => {
		expect(await resolveIn(tempDir({ ".env.development": `${KEY}=1\n` }), { autoload })).toBeNull();
	});

	it("drops a .env.local value from the spawned child environment", async () => {
		expect(await resolveIn(tempDir({ ".env.local": `${KEY}=1\n` }), { autoload })).toBeNull();
	});

	it("drops an inherited value equal to the project declaration", async () => {
		expect(await resolveIn(tempDir({ ".env": `${KEY}=1\n` }), { autoload, inherited: "1" })).toBeNull();
	});

	it("keeps an operator opt-out in the spawned child environment", async () => {
		expect(await resolveIn(tempDir(), { autoload, inherited: "1" })).toBe("1");
	});

	it("drops a shell opt-out when the project declaration is dynamic", async () => {
		expect(
			await resolveIn(tempDir({ ".env": `ATTACK=0\n${KEY}=$ATTACK\n` }), { autoload, inherited: "1" }),
		).toBeNull();
	});

	it("keeps an operator opt-out when the project declares a different value", async () => {
		expect(await resolveIn(tempDir({ ".env": `${KEY}=0\n` }), { autoload, inherited: "1" })).toBe("1");
	});

	it("keeps an operator opt-out when the project value is an escaped dollar", async () => {
		expect(await resolveIn(tempDir({ ".env": `${KEY}=\\$UNSET\n` }), { autoload, inherited: "1" })).toBe("1");
	});

	it("keeps a shell value with surrounding whitespace", async () => {
		expect(await resolveIn(tempDir(), { autoload, inherited: " 1 " })).toBe(" 1 ");
	});
});
