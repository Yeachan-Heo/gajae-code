import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectEnvSnapshot } from "@gajae-code/utils/env-file";
import fc from "fast-check";
import { brokerSpawnEnvironmentForTest, emitBrokerStartupTestSignal } from "../src/sdk/broker/ensure";
import type { SdkInternalSpawnCommand } from "../src/sdk/broker/runtime";

const SIGNAL_DIR = "GJC_SDK_TEST_BROKER_SIGNAL_DIR";
const SIGNAL = "retirement-finished";
const PROPERTY_SEED = 309733;

const spawnCommand: SdkInternalSpawnCommand = {
	kind: "compiled",
	file: "gjc",
	args: ["sdk", "broker-internal"],
	env: {},
};

async function withRepo(
	envText: string,
	body: (paths: { root: string; attack: string }) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-signal-"));
	const repo = path.join(root, "repo");
	const attack = path.join(root, "attacker-chosen");
	await fs.mkdir(repo);
	if (envText.length > 0) await fs.writeFile(path.join(repo, ".env"), envText);
	const previous = process.cwd();
	const prior = process.env[SIGNAL_DIR];
	try {
		process.chdir(repo);
		await body({ root, attack });
	} finally {
		if (prior === undefined) delete process.env[SIGNAL_DIR];
		else process.env[SIGNAL_DIR] = prior;
		process.chdir(previous);
		await fs.rm(root, { recursive: true, force: true });
	}
}

const homeDir = (): string => process.env.USERPROFILE ?? process.env.HOME ?? os.tmpdir();

function handedEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const home = homeDir();
	return brokerSpawnEnvironmentForTest(spawnCommand, {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		...extra,
	});
}

async function childSignal(env: NodeJS.ProcessEnv): Promise<string> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "-e", `console.log(process.env[${JSON.stringify(SIGNAL_DIR)}] ?? "")`],
		{ cwd: os.tmpdir(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`signal child exited ${code}: ${stderr}`);
	return stdout.trim();
}

async function signalFile(directory: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path.join(directory, SIGNAL), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Fresh process: Bun loads the origin dotenv, then cwd moves the way
 * `launch --worktree` does, then the broker child is started with `--no-env-file`.
 */
async function probeWorktreeLaunch(
	mode: "project" | "operator" | "incomplete",
): Promise<{ seen: string; spawned: string; child: string; marker: string | undefined; directory: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-signal-wt-"));
	const origin = path.join(root, "origin");
	const worktree = path.join(root, "worktree");
	const directory = path.join(root, mode === "project" ? "attacker-chosen" : "operator-signal");
	const originEnv =
		mode === "project"
			? `${SIGNAL_DIR}=${directory}\n`
			: mode === "incomplete"
				? "A".repeat(128 * 1024)
				: "UNRELATED_PROJECT_FLAG=1\n";
	await fs.mkdir(origin);
	await fs.mkdir(worktree);
	await fs.writeFile(path.join(origin, ".env"), originEnv);
	await fs.writeFile(path.join(worktree, ".env"), "UNRELATED_WORKTREE=1\n");
	const ensurePath = path.join(import.meta.dir, "../src/sdk/broker/ensure.ts");
	const script = `
		import { brokerSpawnEnvironmentForTest, emitBrokerStartupTestSignal } from ${JSON.stringify(ensurePath)};
		const worktree = process.env.PROBE_WORKTREE;
		const key = ${JSON.stringify(SIGNAL_DIR)};
		const signal = ${JSON.stringify(SIGNAL)};
		if (!worktree) throw new Error("missing worktree");
		const seen = process.env[key] ?? "";
		process.chdir(worktree);
		await emitBrokerStartupTestSignal(signal);
		const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
		const extra = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, USERPROFILE: home };
		if (seen) extra[key] = seen;
		const spawned = brokerSpawnEnvironmentForTest(
			{ kind: "compiled", file: "gjc", args: ["sdk", "broker-internal"], env: {} },
			extra,
		);
		const child = Bun.spawn(
			[process.execPath, "--no-env-file", "-e", "console.log(process.env[" + JSON.stringify(key) + "] ?? '')"],
			{ cwd: worktree, env: spawned, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error("broker child exited " + code + ": " + stderr);
		console.log("WORKTREE_PROBE " + JSON.stringify({ seen, spawned: spawned[key] ?? "", child: stdout.trim() }));
	`;
	const home = homeDir();
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		PROBE_WORKTREE: worktree,
	};
	if (mode !== "project") env[SIGNAL_DIR] = directory;
	try {
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: origin,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`worktree probe exited ${code}: ${stderr || stdout}`);
		const line = stdout.split("\n").find(item => item.startsWith("WORKTREE_PROBE "));
		if (!line) throw new Error(`missing worktree probe line: ${stderr || stdout}`);
		const parsed = JSON.parse(line.slice("WORKTREE_PROBE ".length)) as {
			seen: string;
			spawned: string;
			child: string;
		};
		return { ...parsed, directory, marker: await signalFile(directory) };
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("broker startup signal directory provenance", () => {
	it("refuses a project dotenv signal directory before writing a broker signal file", async () => {
		await withRepo("", async ({ attack }) => {
			await fs.writeFile(path.join(process.cwd(), ".env"), `${SIGNAL_DIR}=${attack}\n`);
			process.env[SIGNAL_DIR] = attack;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(attack)).toBeUndefined();
		});
	});

	it("refuses a dynamic project dotenv signal directory before writing", async () => {
		await withRepo(`${SIGNAL_DIR}=$GJC_PLANTED_SIGNAL_DIR\n`, async ({ attack }) => {
			process.env[SIGNAL_DIR] = attack;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(attack)).toBeUndefined();
		});
	});

	it("drops a project dotenv signal directory from the spawned broker environment", async () => {
		await withRepo("", async ({ attack }) => {
			await fs.writeFile(path.join(process.cwd(), ".env"), `${SIGNAL_DIR}=${attack}\n`);
			process.env[SIGNAL_DIR] = attack;
			const spawned = handedEnv({ [SIGNAL_DIR]: attack, [SIGNAL_DIR.toLowerCase()]: attack });
			expect(spawned[SIGNAL_DIR]).toBeUndefined();
			expect(spawned[SIGNAL_DIR.toLowerCase()]).toBeUndefined();
			expect(await childSignal(spawned)).toBe("");
		});
	});

	it("keeps an operator signal directory the project does not declare", async () => {
		await withRepo("UNRELATED_PROJECT_FLAG=1\n", async ({ root }) => {
			const operator = path.join(root, "operator-signal");
			process.env[SIGNAL_DIR] = operator;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(operator)).toContain(`${process.pid}`);
		});
	});

	it("still allows an operator signal directory when the project declares another value", async () => {
		await withRepo("", async ({ root }) => {
			const declared = path.join(root, "project-declared");
			const operator = path.join(root, "operator-override");
			await fs.writeFile(path.join(process.cwd(), ".env"), `${SIGNAL_DIR}=${declared}\n`);
			process.env[SIGNAL_DIR] = operator;
			await emitBrokerStartupTestSignal(SIGNAL);
			expect(await signalFile(operator)).toContain(`${process.pid}`);
			expect(await signalFile(declared)).toBeUndefined();
		});
	});

	it("keeps the operator signal directory in the spawned broker environment", async () => {
		await withRepo("UNRELATED_PROJECT_FLAG=1\n", async ({ root }) => {
			const operator = path.join(root, "operator-child");
			const spawned = handedEnv({ [SIGNAL_DIR]: operator, OWNED_SENTINEL: "kept" });
			expect(spawned[SIGNAL_DIR]).toBe(operator);
			expect(spawned.OWNED_SENTINEL).toBe("kept");
			expect(await childSignal(spawned)).toBe(operator);
		});
	});

	it.skipIf(process.platform === "win32")(
		"finishes when project dotenv is a fifo and the signal directory is unset",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-signal-fifo-"));
			const repo = path.join(root, "repo");
			const attack = path.join(root, "attacker-chosen");
			await fs.mkdir(repo);
			const made = Bun.spawn(["mkfifo", path.join(repo, ".env")], { stdout: "ignore", stderr: "pipe" });
			const mkCode = await made.exited;
			if (mkCode !== 0) {
				await fs.rm(root, { recursive: true, force: true });
				throw new Error(`mkfifo exited ${mkCode}`);
			}
			const ensurePath = path.join(import.meta.dir, "../src/sdk/broker/ensure.ts");
			const script = `
			import { brokerSpawnEnvironmentForTest, emitBrokerStartupTestSignal } from ${JSON.stringify(ensurePath)};
			process.chdir(${JSON.stringify(repo)});
			const key = ${JSON.stringify(SIGNAL_DIR)};
			const attack = ${JSON.stringify(attack)};
			const mode = process.env.PROBE_MODE;
			if (mode !== "set") delete process.env[key];
			else process.env[key] = attack;
			console.log("before");
			if (mode === "set") await emitBrokerStartupTestSignal(${JSON.stringify(SIGNAL)});
			const env = brokerSpawnEnvironmentForTest(
				{ kind: "compiled", file: "gjc", args: [], env: {} },
				{ PATH: "/usr/bin:/bin", ...(mode === "set" ? { [key]: attack } : {}) },
			);
			console.log("after");
			console.log("seen=" + (env[key] ?? ""));
		`;
			try {
				for (const mode of ["unset", "set"] as const) {
					const home = homeDir();
					const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
						cwd: os.tmpdir(),
						env: {
							PATH: process.env.PATH ?? "/usr/bin:/bin",
							HOME: home,
							USERPROFILE: home,
							PROBE_MODE: mode,
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					});
					const killer = setTimeout(() => child.kill(), 5_000);
					const [stdout, stderr, code] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					clearTimeout(killer);
					expect({ mode, code, stderr, stdout }).toMatchObject({ mode, code: 0 });
					expect(stdout).toContain("before");
					expect(stdout).toContain("after");
					expect(stdout).toContain("seen=");
					expect(stdout).not.toContain(`seen=${attack}`);
				}
				expect(await signalFile(attack)).toBeUndefined();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it("refuses a project dotenv file larger than the read cap", async () => {
		await withRepo("", async ({ attack }) => {
			await fs.writeFile(path.join(process.cwd(), ".env"), "A".repeat(128 * 1024));
			process.env[SIGNAL_DIR] = attack;
			await emitBrokerStartupTestSignal(SIGNAL);
			const spawned = handedEnv({ [SIGNAL_DIR]: attack });
			expect(await signalFile(attack)).toBeUndefined();
			expect(spawned[SIGNAL_DIR]).toBeUndefined();
			expect(await childSignal(spawned)).toBe("");
		});
	});

	it("drops a startup dotenv signal directory after a worktree chdir before the broker child starts", async () => {
		const result = await probeWorktreeLaunch("project");
		expect(result.seen).toBe(result.directory);
		expect(result.spawned).toBe("");
		expect(result.child).toBe("");
		expect(result.marker).toBeUndefined();
	});

	it("keeps an operator signal directory after a worktree chdir when the project does not declare it", async () => {
		const result = await probeWorktreeLaunch("operator");
		expect(result.seen).toBe(result.directory);
		expect(result.spawned).toBe(result.directory);
		expect(result.child).toBe(result.directory);
		expect(result.marker).toMatch(/^\d+\n$/);
	});

	it("rejects the signal directory after a worktree chdir when the startup dotenv snapshot is incomplete", async () => {
		const result = await probeWorktreeLaunch("incomplete");
		expect(result.seen).toBe(result.directory);
		expect(result.spawned).toBe("");
		expect(result.child).toBe("");
		expect(result.marker).toBeUndefined();
	});

	it("property: broker signal directory matches operator provenance, seed 309733, 64 inputs", async () => {
		const mod = await import("../src/sdk/broker/ensure");
		const decide = mod.trustedBrokerSignalDirectoryForTest;
		if (typeof decide !== "function") throw new Error("trustedBrokerSignalDirectoryForTest is required");
		const directory = fc
			.string({ minLength: 1, maxLength: 48 })
			.filter(value => value.trim().length > 0 && !value.includes("\0"));
		fc.assert(
			fc.property(directory, fc.boolean(), (raw, dynamic) => {
				const declared: ProjectEnvSnapshot = {
					values: { [SIGNAL_DIR]: raw },
					dynamic: dynamic ? new Set([SIGNAL_DIR]) : new Set<string>(),
				};
				const empty: ProjectEnvSnapshot = { values: {}, dynamic: new Set() };
				const incomplete: ProjectEnvSnapshot = { values: {}, dynamic: new Set(), incomplete: true };
				expect(decide({ [SIGNAL_DIR]: raw }, declared)).toBeUndefined();
				expect(decide({}, declared)).toBeUndefined();
				expect(decide({ [SIGNAL_DIR]: raw }, [declared, empty])).toBeUndefined();
				expect(decide({ [SIGNAL_DIR]: raw }, [empty, declared])).toBeUndefined();
				expect(decide({ [SIGNAL_DIR]: raw }, [incomplete, empty])).toBeUndefined();
				expect(decide({ [SIGNAL_DIR]: raw }, [empty, incomplete])).toBeUndefined();
				if (dynamic) {
					expect(decide({ [SIGNAL_DIR]: `${raw}-operator` }, declared)).toBeUndefined();
					expect(decide({ [SIGNAL_DIR]: `${raw}-operator` }, [declared, empty])).toBeUndefined();
				} else {
					const operator = `${raw}-operator`;
					expect(decide({ [SIGNAL_DIR]: operator }, declared)).toBe(operator.trim());
					expect(decide({ [SIGNAL_DIR]: operator }, [declared, empty])).toBe(operator.trim());
					expect(decide({ [SIGNAL_DIR]: operator }, [empty, declared])).toBe(operator.trim());
				}
				const accepted = decide({ [SIGNAL_DIR]: raw }, empty);
				expect(accepted).toBe(raw.trim());
				expect(decide({ [SIGNAL_DIR]: raw }, empty)).toBe(accepted);
				expect(decide({ [SIGNAL_DIR]: raw }, [empty, empty])).toBe(accepted);
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});
