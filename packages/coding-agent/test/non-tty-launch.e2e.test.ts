import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NON_TTY_NO_INPUT_ERROR } from "../src/main";

/**
 * Subprocess matrix for issue #2507: non-TTY stdin launch dispositions.
 *
 * Every case spawns the real CLI with non-TTY stdio (pipes), an isolated HOME,
 * and a model pattern that cannot resolve — so prepared-input runs terminate
 * deterministically at model resolution instead of hanging in the TUI or
 * calling the network. The matrix axes are the ones from the #2010/#2508
 * reviews: {empty EOF, piped content, open pipe without EOF} × {no input,
 * positional prompt, @file}.
 */

const cliPath = path.resolve(import.meta.dir, "../src/cli.ts");
let homeDir = "";
let promptFile = "";

beforeAll(async () => {
	homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-nontty-e2e-"));
	promptFile = path.join(homeDir, "prompt.txt");
	await fs.writeFile(promptFile, "prepared prompt from a file\n");
});

afterAll(async () => {
	if (homeDir) await fs.rm(homeDir, { recursive: true, force: true });
});

type LaunchResult = {
	exitCode: number | "timeout";
	stderr: string;
	stdout: string;
};

function spawnCli(args: string[], stdin: "ignore" | "pipe") {
	return Bun.spawn(["bun", cliPath, "--no-session", "--model", "no-such-provider/no-such-model", ...args], {
		cwd: path.dirname(cliPath),
		env: {
			...process.env,
			HOME: homeDir,
			GJC_NOTIFICATIONS: "0",
			GJC_SDK_DISABLE: "1",
		},
		stdin,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function pipedStdin(child: ReturnType<typeof spawnCli>): NonNullable<typeof child.stdin> {
	if (!child.stdin) throw new Error("expected the child to be spawned with piped stdin");
	return child.stdin;
}

async function collect(child: ReturnType<typeof spawnCli>, timeoutMs: number): Promise<LaunchResult> {
	const exited = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
	if (exited === "timeout") {
		child.kill("SIGKILL");
		await child.exited;
		return { exitCode: "timeout", stderr: "", stdout: "" };
	}
	const [stderr, stdout] = await Promise.all([new Response(child.stderr).text(), new Response(child.stdout).text()]);
	return { exitCode: exited, stderr, stdout };
}

describe("non-TTY launch disposition (subprocess matrix, issue #2507)", () => {
	test("empty EOF stdin with nothing to run fails fast with the diagnostic", async () => {
		const child = spawnCli([], "ignore"); // "ignore" = /dev/null: immediate EOF
		const result = await collect(child, 30_000);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(NON_TTY_NO_INPUT_ERROR);
	}, 40_000);

	test("empty EOF stdin with a positional prompt runs non-interactively (no fail-fast, no hang)", async () => {
		const child = spawnCli(["hello"], "ignore");
		const result = await collect(child, 30_000);
		expect(result.exitCode).not.toBe("timeout");
		expect(result.stderr).not.toContain(NON_TTY_NO_INPUT_ERROR);
	}, 40_000);

	test("empty EOF stdin with @file input runs non-interactively (blocker 1 in the #2010 review)", async () => {
		const child = spawnCli([`@${promptFile}`], "ignore");
		const result = await collect(child, 30_000);
		expect(result.exitCode).not.toBe("timeout");
		expect(result.stderr).not.toContain(NON_TTY_NO_INPUT_ERROR);
	}, 40_000);

	test("open stdin without EOF must not block a positional prompt (open/no-EOF prepared-input case)", async () => {
		const child = spawnCli(["hello"], "pipe"); // pipe held open, never closed by us
		const result = await collect(child, 30_000);
		expect(result.exitCode).not.toBe("timeout");
		expect(result.stderr).not.toContain(NON_TTY_NO_INPUT_ERROR);
	}, 40_000);

	test("open stdin without EOF must not block @file input (open/no-EOF prepared-input case)", async () => {
		const child = spawnCli([`@${promptFile}`], "pipe");
		const result = await collect(child, 30_000);
		expect(result.exitCode).not.toBe("timeout");
		expect(result.stderr).not.toContain(NON_TTY_NO_INPUT_ERROR);
	}, 40_000);

	test("piped stdin content becomes the prompt (blocker 2 in the #2010 review: Bun isTTY === undefined)", async () => {
		const child = spawnCli([], "pipe");
		const stdin = pipedStdin(child);
		stdin.write("what is 2+2\n");
		await stdin.end();
		const result = await collect(child, 30_000);
		expect(result.exitCode).not.toBe("timeout");
		// The piped bytes must be read and treated as prepared input — the
		// launch must not fail fast claiming no prompt was provided.
		expect(result.stderr).not.toContain(NON_TTY_NO_INPUT_ERROR);
	}, 40_000);

	test("open stdin with no other input waits for the writer (filter semantics), then runs the piped prompt", async () => {
		const child = spawnCli([], "pipe");
		// Give the CLI time to boot and reach the stdin read; it must still be
		// alive (waiting for input like `cat`), not fail-fast and not in a TUI.
		const early = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "alive" as const)]);
		expect(early).toBe("alive");
		const stdin = pipedStdin(child);
		stdin.write("late prompt\n");
		await stdin.end();
		const result = await collect(child, 30_000);
		expect(result.exitCode).not.toBe("timeout");
		expect(result.stderr).not.toContain(NON_TTY_NO_INPUT_ERROR);
	}, 45_000);
});
