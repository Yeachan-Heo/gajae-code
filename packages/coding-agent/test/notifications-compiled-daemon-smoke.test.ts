import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonPaths } from "../src/notifications/telegram-daemon";

describe("compiled daemon smoke coverage", () => {
	function tempDir(prefix: string): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	}

	test("hidden daemon CLI smoke creates and removes its temp lock without leaking tokens", async () => {
		const agentDir = tempDir("gjc-compiled-daemon-agent-");
		const cwd = tempDir("gjc-compiled-daemon-cwd-");
		const token = "123456:super-secret-token";
		const proc = Bun.spawn(
			["bun", "run", path.resolve("packages/coding-agent/src/cli.ts"), "notify", "daemon-internal", "--smoke"],
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

	test("build script preserves the dynamic daemon entrypoint for compiled binaries", () => {
		const buildScript = fs.readFileSync(path.resolve("packages/coding-agent/scripts/build-binary.ts"), "utf8");
		expect(buildScript).toContain("telegram-daemon-cli.ts");
	});
});
