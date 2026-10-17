import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { getCurrentSessionLaunchEnvironment, setCurrentSessionLaunchEnvironment } from "../src/sdk/session-environment";
import * as git from "../src/utils/git";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = {
	cmd: string[];
	options: SpawnOptions;
};

function createTextStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) {
		throw new Error("Failed to create response stream.");
	}
	return body;
}

function createFakeProcess(stdout = "", stderr = "", exitCode = 0): Subprocess {
	return {
		pid: 12345,
		stdout: createTextStream(stdout),
		stderr: createTextStream(stderr),
		exited: Promise.resolve(exitCode),
	} as Subprocess;
}

function createSpawnMock(calls: SpawnCall[]) {
	function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		if (Array.isArray(first)) {
			calls.push({ cmd: first, options: second ?? ({} as SpawnOptions) });
		} else {
			const { cmd, ...options } = first;
			calls.push({ cmd, options });
		}
		return createFakeProcess();
	}

	return mockSpawn;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("git subprocess config", () => {
	it("disables fsmonitor and untracked cache for read-only commands", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		expect(await git.status.summary("/work/pi")).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"--no-optional-locks",
			"status",
			"--porcelain",
		]);
	});

	it("disables fsmonitor and untracked cache for mutating commands", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		await git.stage.files("/work/pi", ["tracked.txt"]);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"add",
			"--",
			"tracked.txt",
		]);
	});

	it("resolves gh from the session PATH and applies its environment overlay", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-gh-session-env-"));
		const binDir = path.join(tempDir, "bin");
		await fs.mkdir(binDir);
		const ghPath = path.join(binDir, process.platform === "win32" ? "gh.exe" : "gh");
		await Bun.write(ghPath, "");
		if (process.platform !== "win32") await fs.chmod(ghPath, 0o755);

		const previousEnvironment = getCurrentSessionLaunchEnvironment();
		const previousToken = process.env.GH_TOKEN;
		process.env.GH_TOKEN = "inherited-token";
		setCurrentSessionLaunchEnvironment({
			env: { PATH: binDir, SESSION_ENV_MARKER: "session-value" },
			unsetEnv: ["GH_TOKEN"],
		});
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		try {
			expect(git.github.available()).toBe(true);
			await git.github.run(tempDir, ["--version"]);
			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0]?.cmd[0]).toBe(ghPath);
			expect(spawnCalls[0]?.options.env?.SESSION_ENV_MARKER).toBe("session-value");
			expect(spawnCalls[0]?.options.env?.GH_TOKEN).toBeUndefined();
		} finally {
			setCurrentSessionLaunchEnvironment(previousEnvironment);
			if (previousToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = previousToken;
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("checks Git availability against the session PATH", async () => {
		if (process.platform !== "linux") return;
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-git-session-path-"));
		try {
			const hostBinDir = path.join(tempDir, "host-bin");
			const sessionBinDir = path.join(tempDir, "session-bin");
			await fs.mkdir(hostBinDir);
			await fs.mkdir(sessionBinDir);
			const gitPath = path.join(sessionBinDir, "git");
			await Bun.write(gitPath, '#!/bin/sh\n[ "$PATH" = "$GJC_TEST_SESSION_BIN" ] || exit 90\nexit 0\n');
			await fs.chmod(gitPath, 0o755);
			const probePath = path.join(tempDir, "session-git-probe.ts");
			const gitModule = new URL("../src/utils/git.ts", import.meta.url).href;
			const environmentModule = new URL("../src/sdk/session-environment.ts", import.meta.url).href;
			await Bun.write(
				probePath,
				`import { setCurrentSessionLaunchEnvironment } from ${JSON.stringify(environmentModule)};\n` +
					`import * as git from ${JSON.stringify(gitModule)};\n` +
					'setCurrentSessionLaunchEnvironment({ env: { PATH: process.env.GJC_TEST_SESSION_BIN ?? "" } });\n' +
					'await git.status.summary(process.env.GJC_TEST_REPO ?? "");\n',
			);

			const child = Bun.spawn([process.execPath, "run", probePath], {
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					PATH: hostBinDir,
					GJC_TEST_REPO: tempDir,
					GJC_TEST_SESSION_BIN: sessionBinDir,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 10_000);
});
