import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createTrustTempDirs } from "./helpers/trust-temp-dirs";

/**
 * A repository `.env` must not move the harness control socket or the
 * session-root registry. Both names are read from the process environment
 * after the env module loads. Bun autoloads cwd/.env, and the env module
 * copies the project `.env` itself when autoload is off, so both paths
 * are exercised. A value exported by the launching shell stays in place.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "harness-dotenv-probe.ts");
const KEYS: Array<"GJC_HARNESS_SOCKET_DIR" | "GJC_HARNESS_ROOT_REGISTRY_DIR"> = [
	"GJC_HARNESS_SOCKET_DIR",
	"GJC_HARNESS_ROOT_REGISTRY_DIR",
];

const trustDirs = createTrustTempDirs("gjc-harness-dotenv-");
const { tempDir, projectDir } = trustDirs;

async function resolveIn(
	cwd: string,
	key: "GJC_HARNESS_SOCKET_DIR" | "GJC_HARNESS_ROOT_REGISTRY_DIR",
	options: { autoload: boolean; inherited?: string },
): Promise<string | null> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}
	for (const name of KEYS) delete env[name];
	// Keep user-owned env files (agent `.env`, `~/.env`, shell rc) out of the result.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	if (options.inherited !== undefined) env[key] = options.inherited;

	const args = options.autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as Record<string, string | null>)[key] ?? null;
}

describe.each([
	["Bun dotenv autoload", true],
	["no dotenv autoload", false],
] as const)("harness directory trust boundary (%s)", (_label, autoload) => {
	describe.each(KEYS)("%s", key => {
		it("drops a value declared by the project .env", async () => {
			expect(await resolveIn(projectDir(`${key}=/attacker/${key}\n`), key, { autoload })).toBeNull();
		});

		it("drops a dynamic project declaration", async () => {
			expect(await resolveIn(projectDir(`ATTACK=/attacker/${key}\n${key}=$ATTACK\n`), key, { autoload })).toBeNull();
		});

		it("keeps a value inherited from the launching shell", async () => {
			const inherited = `/operator/${key}`;
			expect(await resolveIn(tempDir(), key, { autoload, inherited })).toBe(inherited);
		});

		it("keeps an inherited shell value when the project .env disagrees", async () => {
			const inherited = `/operator/${key}`;
			expect(await resolveIn(projectDir(`${key}=/attacker/${key}\n`), key, { autoload, inherited })).toBe(inherited);
		});

		it("drops an inherited value equal to the project declaration", async () => {
			const inherited = `/operator/${key}`;
			expect(await resolveIn(projectDir(`${key}=${inherited}\n`), key, { autoload, inherited })).toBeNull();
		});

		it("drops an inherited value when the project declaration is dynamic", async () => {
			const inherited = `/operator/${key}`;
			expect(
				await resolveIn(projectDir(`ATTACK=/other/${key}\n${key}=$ATTACK\n`), key, { autoload, inherited }),
			).toBeNull();
		});

		it("drops a double-quoted newline escape Bun autoload decodes", async () => {
			expect(await resolveIn(projectDir(`${key}="/repo/.gjc/roots\\n"\n`), key, { autoload })).toBeNull();
		});

		it("drops a shell value when the project declaration is a quoted escape", async () => {
			const inherited = `/operator/${key}`;
			expect(await resolveIn(projectDir(`${key}="/repo/.gjc/roots\\n"\n`), key, { autoload, inherited })).toBeNull();
		});

		it("keeps a different shell value when the project quote is plain", async () => {
			const inherited = `/operator/${key}`;
			expect(await resolveIn(projectDir(`${key}="/attacker/${key}"\n`), key, { autoload, inherited })).toBe(
				inherited,
			);
		});
	});
});

describe("harness directory backslash-hash comment", () => {
	describe.each(KEYS)("%s", key => {
		it("drops a project assignment whose hash is preceded by a backslash", async () => {
			expect(await resolveIn(projectDir(`${key}=/repo/${key}\\#note\n`), key, { autoload: true })).toBeNull();
		});

		it("keeps a different shell value when the project assignment uses a backslash hash", async () => {
			const inherited = `/operator/${key}`;
			expect(await resolveIn(projectDir(`${key}=/repo/${key}\\#note\n`), key, { autoload: true, inherited })).toBe(
				inherited,
			);
		});
	});
});
