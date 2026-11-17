import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A project `.env` layer that is a FIFO blocks `open(2)` until a writer appears.
 * Bun's own autoload skips it, and GJC's dotenv readers (several run at import
 * time) must too, or every command in that checkout hangs before argument
 * parsing (#7428).
 */

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-fifo-dotenv-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("startup with a FIFO project dotenv layer", () => {
	for (const layer of [".env", ".env.local"]) {
		for (const noEnvFile of [false, true]) {
			it(`gjc --version returns with a FIFO ${layer} (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
				const cwd = tempDir();
				expect(Bun.spawnSync(["mkfifo", path.join(cwd, layer)]).exitCode).toBe(0);
				const home = tempDir();
				const proc = Bun.spawn([process.execPath, ...(noEnvFile ? ["--no-env-file"] : []), CLI, "--version"], {
					cwd,
					// `bun test` sets NODE_ENV=test, which would drop the `.env.local` layer.
					env: { ...process.env, NODE_ENV: "development", HOME: home, TMPDIR: tempDir() },
					stdout: "pipe",
					stderr: "pipe",
					timeout: 15_000,
					killSignal: "SIGKILL",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode, stderr).toBe(0);
				expect(stdout).toMatch(/^gjc\/\d+\.\d+\.\d+/);
			}, 30_000);
		}
	}
});
