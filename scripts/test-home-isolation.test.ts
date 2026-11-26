import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildTestProcessSpec } from "./run-bun-test-files";
import { decideHomeIsolation, inheritedToolchainHomes, TEST_ISOLATED_HOME_ENV } from "./test-home-isolation";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PRELOAD = path.join(REPO_ROOT, "scripts", "test-preload.ts");
const PROBE = path.join(import.meta.dir, "fixtures", "home-isolation-probe.ts");

interface ProbeResult {
	processEnv: string;
	bunSpawn: string;
	bunSpawnSync: string;
	bunSpawnSyncWithOptions: string;
	childProcess: string;
	bunShell: string;
	nativeEnviron: string | null;
	explicitEnv: string;
}

async function runProbe(env: Record<string, string | undefined>): Promise<ProbeResult> {
	const proc = Bun.spawn([process.execPath, "--preload", PRELOAD, PROBE], {
		cwd: REPO_ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, `home probe failed:\n${stdout}\n${stderr}`).toBe(0);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as ProbeResult;
}

async function withSentinelHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-home-sentinel-")));
	try {
		return await run(home);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}

describe("test HOME isolation decision", () => {
	const real = "/Users/operator";

	it.each([
		["no marker", { HOME: "/tmp/runner/home" }, [real], { action: "isolate", reason: "unmarked" }],
		["a marked relative HOME", { HOME: "home", [TEST_ISOLATED_HOME_ENV]: "home" }, [real], { action: "isolate", reason: "absent" }],
		["a marked real home", { HOME: real, [TEST_ISOLATED_HOME_ENV]: real }, [real], { action: "isolate", reason: "real-home" }],
		["an unresolvable real home", { HOME: "/tmp/runner/home", [TEST_ISOLATED_HOME_ENV]: "/tmp/runner/home" }, [], { action: "isolate", reason: "unverifiable" }],
		["a marked temp HOME", { HOME: "/tmp/runner/home", [TEST_ISOLATED_HOME_ENV]: "/tmp/runner/home" }, [real], { action: "honor", home: "/tmp/runner/home" }],
		["a HOME a test chose for its child", { HOME: "/tmp/fixture", [TEST_ISOLATED_HOME_ENV]: "/tmp/parent/home" }, [real], { action: "honor", home: "/tmp/fixture" }],
	] as const)("%s", (_label, env, realHomeAliases, expected) => {
		expect(decideHomeIsolation({ env, realHomeAliases, platform: "linux" })).toEqual(expected);
	});

	it("treats a symlink to the real home as the real home", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-home-alias-")));
		try {
			const realHome = path.join(root, "real");
			const alias = path.join(root, "alias");
			await fs.mkdir(realHome);
			await fs.symlink(realHome, alias, "dir");
			const env = { HOME: alias, [TEST_ISOLATED_HOME_ENV]: alias };
			expect(decideHomeIsolation({ env, realHomeAliases: [realHome], platform: "linux" })).toEqual({
				action: "isolate",
				reason: "real-home",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("recognizes the shard runner's HOME as already isolated", () => {
		const spec = buildTestProcessSpec("packages/x/test/a.test.ts", "/tmp/sandbox", 30_000, REPO_ROOT, {});
		expect(decideHomeIsolation({ env: spec.env, realHomeAliases: [real], platform: "linux" })).toEqual({
			action: "honor",
			home: "/tmp/sandbox/home",
		});
	});
});

describe("toolchain homes under an isolated HOME", () => {
	it("keeps rustup and cargo on the startup home unless already pinned", () => {
		expect(inheritedToolchainHomes({ HOME: "/Users/operator" }, "linux")).toEqual({
			CARGO_HOME: "/Users/operator/.cargo",
			RUSTUP_HOME: "/Users/operator/.rustup",
		});
		expect(
			inheritedToolchainHomes({ HOME: "/Users/operator", CARGO_HOME: "/opt/cargo", RUSTUP_HOME: "/opt/rustup" }, "linux"),
		).toEqual({});
		expect(inheritedToolchainHomes({})).toEqual({});
		expect(inheritedToolchainHomes({ HOME: "/Users/operator" }, "win32")).toEqual({});
	});
});

describe.skipIf(process.platform === "win32")("test preload HOME isolation", () => {
	it("gives every child of a plain run a private HOME, not the inherited one", async () => {
		await withSentinelHome(async sentinel => {
			const env: Record<string, string | undefined> = { ...process.env, HOME: sentinel };
			delete env[TEST_ISOLATED_HOME_ENV];
			const result = await runProbe(env);

			expect(path.basename(path.dirname(result.processEnv))).toMatch(/^gjc-test-home-/);
			expect(result).toEqual({
				processEnv: result.processEnv,
				bunSpawn: result.processEnv,
				bunSpawnSync: result.processEnv,
				bunSpawnSyncWithOptions: result.processEnv,
				childProcess: result.processEnv,
				bunShell: result.processEnv,
				nativeEnviron: result.processEnv,
				explicitEnv: "/explicit-home",
			});
			expect(await fs.readdir(sentinel)).toEqual([]);
		});
	}, 30_000);

	it("leaves a HOME chosen by an isolating parent in place", async () => {
		await withSentinelHome(async sentinel => {
			const result = await runProbe({ ...process.env, HOME: sentinel, [TEST_ISOLATED_HOME_ENV]: sentinel });

			expect(result.processEnv).toBe(sentinel);
			expect(result.bunSpawn).toBe(sentinel);
			expect(result.childProcess).toBe(sentinel);
			expect(result.bunShell).toBe(sentinel);
			expect(result.nativeEnviron).toBe(sentinel);
		});
	}, 30_000);
});
