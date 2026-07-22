import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const packageRoot = path.join(import.meta.dir, "..");
const cliEntry = path.join(packageRoot, "src", "cli.ts");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-daemon-timeout-validation-"));

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runDaemon(args: string[], agentDir: string): CliResult {
	const result = Bun.spawnSync([process.execPath, cliEntry, "daemon", ...args], {
		cwd: packageRoot,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

describe("daemon command timeout validation", () => {
	test("rejects public daemon timeout tokens before command dispatch", () => {
		const invalidTokens = ["", " ", "22junk", "1.5", "1e3", "+1", "-1", "0", "9007199254740992"];

		for (const flag of ["--graceful-timeout-ms", "--kill-timeout-ms"]) {
			const missing = runDaemon(["status", "unknown-kind", flag], path.join(tempRoot, "missing"));
			expect(missing.exitCode, `${flag} missing operand unexpectedly succeeded`).not.toBe(0);
			expect(missing.stderr).toContain(flag);
			expect(missing.stderr).not.toContain("Unknown daemon kind");

			for (const token of invalidTokens) {
				const effectDir = path.join(tempRoot, `${flag.slice(2)}-${invalidTokens.indexOf(token)}`);
				const result = runDaemon(["status", "unknown-kind", `${flag}=${token}`], effectDir);
				expect(result.exitCode, `${flag} accepted ${JSON.stringify(token)}`).not.toBe(0);
				expect(result.stderr).toContain(`Expected ${flag} to be a positive safe integer`);
				expect(result.stderr).not.toContain("Unknown daemon kind");
				expect(fs.existsSync(effectDir), `${flag} dispatched for ${JSON.stringify(token)}`).toBe(false);
			}
		}
	}, 30_000);

	test("preserves valid timeout values and omission", () => {
		for (const token of [undefined, "1", "2500", "9007199254740991"]) {
			const args = ["status", "--json"];
			if (token !== undefined) {
				args.push("--graceful-timeout-ms", token, "--kill-timeout-ms", token);
			}
			const result = runDaemon(args, path.join(tempRoot, `valid-${token ?? "omitted"}`));
			expect(result.exitCode, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toBeArray();
		}
	}, 15_000);
});
