import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { devEntrypoints, releaseEntrypoints } from "../scripts/compile-args";
import { buildChatDaemonSpawnArgs } from "../src/sdk/bus/chat-daemon-control";
import { buildTelegramDaemonSpawnArgs, daemonPaths } from "../src/sdk/bus/telegram-daemon";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";

describe("compiled daemon smoke coverage", () => {
	function tempDir(prefix: string): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	}

	async function runWithTimeout(
		command: string[],
		opts: { cwd: string; env?: Record<string, string | undefined> },

		timeoutMs: number,
	): Promise<{
		exitCode: number | null;
		stdout: string;
		stderr: string;
		timedOut: boolean;
	}> {
		const proc = Bun.spawn(command, {
			cwd: opts.cwd,
			...(opts.env ? { env: opts.env } : {}),
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		const timeout = new Promise<null>(resolve => {
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill();
				resolve(null);
			}, timeoutMs);
			proc.exited.finally(() => clearTimeout(timer));
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			Promise.race([proc.exited, timeout]),
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr, timedOut };
	}
	const cliEntrypoint = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

	function rootCliStaticImports(source: string): string[] {
		const importsFrom = Array.from(source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];?$/gm), match => match[1]);
		const sideEffectImports = Array.from(source.matchAll(/^import\s+["']([^"']+)["'];?$/gm), match => match[1]);
		return [...importsFrom, ...sideEffectImports];
	}

	test("root CLI defers the chat daemon bus graph while the hidden daemon child still spawns", async () => {
		const agentDir = tempDir("gjc-chat-daemon-root-entry-");
		const cwd = tempDir("gjc-chat-daemon-root-cwd-");
		const configPath = path.join(agentDir, "config.yml");
		const config = "notifications:\n  enabled: false\n";
		fs.writeFileSync(configPath, config);
		try {
			const staticImports = rootCliStaticImports(fs.readFileSync(cliEntrypoint, "utf8"));
			expect(staticImports).not.toContain("./sdk/bus/chat-daemon-cli");

			const result = await runWithTimeout(
				[
					"bun",
					"run",
					cliEntrypoint,
					"daemon",
					"discord-internal",
					"--owner-id",
					`${process.pid}-root-entry-test`,
					"--agent-dir",
					agentDir,
				],
				{ cwd },
				10_000,
			);
			expect(result.timedOut).toBe(false);
			expect(`${result.exitCode}\n${result.stdout}\n${result.stderr}`).toStartWith("0\n");
			expect(fs.readFileSync(configPath, "utf8")).toBe(config);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	async function buildCompiledDaemonSmokeBinary(outPath: string): Promise<void> {
		const proc = Bun.spawn(["bun", "run", "build"], {
			cwd: path.join(repoRoot, "packages/coding-agent"),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(`${exitCode}\n${stdout}\n${stderr}`).toStartWith("0\n");
		fs.copyFileSync(path.join(repoRoot, `packages/coding-agent/dist/gjc${executableSuffix}`), outPath);
		fs.chmodSync(outPath, 0o755);
	}

	test("hidden daemon CLI smoke creates and removes its temp lock without leaking tokens", async () => {
		const agentDir = tempDir("gjc-compiled-daemon-agent-");
		const cwd = tempDir("gjc-compiled-daemon-cwd-");
		const token = "123456:super-secret-token";
		const proc = Bun.spawn(
			[
				"bun",
				"run",
				path.join(repoRoot, "packages/coding-agent/src/cli.ts"),
				"notify",
				"daemon-internal",
				"--smoke",
			],
			{
				cwd,
				env: {
					...process.env,
					GJC_CODING_AGENT_DIR: agentDir,
					GJC_TG_BOT_TOKEN: token,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(`${exitCode}\n${stdout}\n${stderr}`).toStartWith("0\n");
		expect(stdout).not.toContain(token);
		expect(stderr).not.toContain(token);

		const smokeDirs = fs.readdirSync(cwd).filter(name => name.startsWith(".telegram-daemon-smoke-"));
		expect(smokeDirs).toHaveLength(1);
		const paths = daemonPaths(path.join(cwd, smokeDirs[0]));
		expect(fs.existsSync(paths.dir)).toBe(true);
		expect(fs.readdirSync(paths.dir).filter(name => name.includes(".smoke."))).toEqual([]);
	});

	test("source chat worker reads disabled config without modifying it", async () => {
		const agentDir = tempDir("gjc-chat-daemon-disabled-");
		const configPath = path.join(agentDir, "config.yml");
		const config = "notifications:\n  enabled: false\n";
		fs.writeFileSync(configPath, config);
		try {
			const result = await runWithTimeout(
				[
					"bun",
					"run",
					path.join(repoRoot, "packages/coding-agent/src/cli.ts"),
					"daemon",
					"discord-internal",
					"--owner-id",
					`${process.pid}-test`,
					"--agent-dir",
					agentDir,
				],
				{ cwd: repoRoot },
				10_000,
			);
			expect(result.timedOut).toBe(false);
			expect(`${result.exitCode}\n${result.stdout}\n${result.stderr}`).toStartWith("0\n");
			expect(fs.readFileSync(configPath, "utf8")).toBe(config);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
	test("compiled binary preserves the shipped chat worker entrypoint", async () => {
		const temp = tempDir("gjc-compiled-daemon-binary-");
		const binaryPath = path.join(temp, `gjc-repro${executableSuffix}`);
		try {
			await buildCompiledDaemonSmokeBinary(binaryPath);
			const nativeVersion = (
				JSON.parse(fs.readFileSync(path.join(repoRoot, "packages/natives/package.json"), "utf8")) as {
					version: string;
				}
			).version;
			const xdgDataHome = path.join(temp, "xdg");
			const nativeCache = path.join(xdgDataHome, "gjc", "natives", nativeVersion);
			fs.mkdirSync(nativeCache, { recursive: true });
			const nativeSrcDir = path.join(repoRoot, "packages/natives/native");
			for (const nativeFile of fs.readdirSync(nativeSrcDir)) {
				if (/^pi_natives\..*\.node$/.test(nativeFile)) {
					fs.copyFileSync(path.join(nativeSrcDir, nativeFile), path.join(nativeCache, nativeFile));
				}
			}
			const version = await runWithTimeout(
				[binaryPath, "--version"],
				{ cwd: temp, env: { ...process.env, XDG_DATA_HOME: xdgDataHome } },
				10_000,
			);
			expect(version.timedOut).toBe(false);
			expect(`${version.exitCode}\n${version.stdout}\n${version.stderr}`).toStartWith("0\ngjc/");
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	}, 300_000);

	test("compile entrypoint lists preserve the dynamic daemon entrypoint for compiled binaries", () => {
		expect(devEntrypoints).toEqual(
			expect.arrayContaining(["./src/sdk/bus/telegram-daemon-cli.ts", "./src/sdk/bus/chat-daemon-cli.ts"]),
		);
		expect(releaseEntrypoints).toEqual(
			expect.arrayContaining([
				"./packages/coding-agent/src/sdk/bus/telegram-daemon-cli.ts",
				"./packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts",
			]),
		);
	});

	test("compiled-mode spawn args self-spawn the binary without a script prefix and carry a reload warning", () => {
		const { command, args, runtime } = buildTelegramDaemonSpawnArgs({
			execPath: "/opt/gjc/gjc",
			ownerId: "owner-1",
			agentDir: "/tmp/agent",
		});
		expect(command).toBe("/opt/gjc/gjc");
		// No bun/node entry-script prefix in compiled mode: the binary self-spawns its subcommand.
		expect(args[0]).toBe("notify");
		expect(args).toContain("daemon-internal");
		expect(args).toEqual(expect.arrayContaining(["--owner-id", "owner-1", "--agent-dir", "/tmp/agent"]));
		expect(runtime.mode).toBe("compiled");
		expect(runtime.reloadPicksUpSourceEdits).toBe(false);
		expect(runtime.warning).toContain("Rebuild");
	});

	test("compiled chat spawn self-invokes daemon internal workers without a source entrypoint", () => {
		for (const kind of ["discord", "slack"] as const) {
			const { command, args, runtime } = buildChatDaemonSpawnArgs({
				kind,
				execPath: "/opt/gjc/gjc",
				ownerId: "owner-1",
				agentDir: "/tmp/agent",
			});
			expect(command).toBe("/opt/gjc/gjc");
			expect(args).toEqual(expect.arrayContaining(["daemon", `${kind}-internal`, "--owner-id", "owner-1"]));
			expect(runtime.mode).toBe("compiled");
		}
	});
});
