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
			const missing = runDaemon(["restart", "unknown-kind", "--json", flag], path.join(tempRoot, "missing"));
			expect(missing.exitCode).toBe(2);
			expect(missing.stderr).toBe("");
			expect(JSON.parse(missing.stdout).error.code).toBe("usage");

			for (const token of invalidTokens) {
				const effectDir = path.join(tempRoot, `${flag.slice(2)}-${invalidTokens.indexOf(token)}`);
				const result = runDaemon(["restart", "unknown-kind", "--json", `${flag}=${token}`], effectDir);
				expect(result.exitCode, `${flag} accepted ${JSON.stringify(token)}`).toBe(2);
				expect(result.stderr).toBe("");
				expect(JSON.parse(result.stdout).error.code).toBe("usage");
				expect(fs.existsSync(effectDir), `${flag} dispatched for ${JSON.stringify(token)}`).toBe(false);
			}
		}
	}, 30_000);

	test("valid timeout values reach runtime kind validation without operations", () => {
		for (const token of [undefined, "1", "2500", "9007199254740991"]) {
			const args = ["restart", "unknown-kind", "--json"];
			if (token !== undefined) {
				args.push("--graceful-timeout-ms", token, "--kill-timeout-ms", token);
			}
			const result = runDaemon(args, path.join(tempRoot, `valid-${token ?? "omitted"}`));
			expect(result.exitCode, result.stderr).toBe(1);
			expect(JSON.parse(result.stdout).error.code).toBe("operation_failed");
		}
	}, 15_000);

	test("public help hides worker grammar without initializing state", () => {
		const agentDir = path.join(tempRoot, "help-only");
		const result = runDaemon(["restart", "--help", "--json"], agentDir);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		for (const token of ["discord-internal", "slack-internal", "owner-id", "smoke"])
			expect(result.stdout).not.toContain(token);
		expect(fs.existsSync(agentDir)).toBe(false);
	});
});
