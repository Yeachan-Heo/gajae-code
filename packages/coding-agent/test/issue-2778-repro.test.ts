import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, VERSION } from "@gajae-code/utils/cli-metadata";
import { signMacOSBinary } from "../../../scripts/macos-code-signing";
import { buildDevCompileArgs, devEntrypoints } from "../scripts/compile-args";

const packageRoot = path.resolve(import.meta.dir, "..");
const fixture = path.join(import.meta.dir, "fixtures/compiled-main-startup.ts");

interface Invocation {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function invoke(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Invocation> {
	const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}

describe("compiled main CLI handoff", () => {
	// #2778: exercise the real compiled graph and handoff, not the import spelling.
	test("runs version and help from a standalone main entry outside the source tree", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-compiled-main-"));
		try {
			const env: NodeJS.ProcessEnv = Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) =>
						!key.startsWith("GJC_") &&
						!key.startsWith("PI_") &&
						!["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].includes(key),
				),
			);
			Object.assign(env, {
				HOME: root,
				USERPROFILE: root,
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: path.join(root, "agent"),
				GJC_SDK_BROKER_AUTOSTART: "0",
				NO_COLOR: "1",
			});
			const executable = path.join(root, process.platform === "win32" ? "main.exe" : "main");
			const args = buildDevCompileArgs(executable);
			const primary = args.indexOf(devEntrypoints[0]!);
			if (primary < 0) throw new Error("Missing primary development compile entrypoint");
			args[0] = process.execPath;
			args[primary] = fixture;
			args.splice(1, 0, "--no-env-file");
			const buildEnv = process.platform === "darwin" ? { ...env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : env;
			const compiled = await invoke(args, packageRoot, buildEnv, 120_000);
			expect(compiled.exitCode, compiled.stderr).toBe(0);

			// Match the dev builder's real native sidecars without rewriting shared embed modules.
			const nativeDir = path.resolve(packageRoot, "../natives/native");
			await Array.fromAsync(new Bun.Glob("pi_natives.*.node").scan({ cwd: nativeDir }), async filename => {
				await Bun.write(path.join(root, filename), Bun.file(path.join(nativeDir, filename)));
			});
			if (process.platform === "darwin") {
				await signMacOSBinary(executable, async command => {
					const signed = await invoke(command, packageRoot, env, 30_000);
					if (signed.exitCode !== 0) throw new Error(`Ad-hoc signing failed: ${signed.stderr}`);
				});
			}

			const cwd = path.join(root, "unrelated-cwd");
			await fs.mkdir(cwd);
			expect(await invoke([executable, "--version"], cwd, env, 10_000)).toEqual({
				exitCode: 0,
				stdout: `${APP_NAME}/${VERSION}\n`,
				stderr: "",
			});
			const help = await invoke([executable, "--help"], cwd, env, 10_000);
			expect(help).toMatchObject({ exitCode: 0, stderr: "" });
			expect(help.stdout).toMatch(/\busage\b/i);
			expect(help.stdout).toContain("--model");
			expect(help.stdout).toContain(VERSION);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 240_000);
});
