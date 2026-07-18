import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLaunchDisposition } from "@gajae-code/coding-agent/cli/launch-disposition";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const base = {
	stdinIsTTY: true as boolean | undefined,
	pipedInput: undefined as string | undefined,
	hasPreparedInput: false,
	print: false,
	mode: undefined as "text" | "json" | "acp" | undefined,
};

describe("resolveLaunchDisposition", () => {
	it("keeps a TTY with no prepared input interactive", () => {
		expect(resolveLaunchDisposition({ ...base })).toEqual({ autoPrint: false, isInteractive: true });
	});
	it("keeps a TTY with prepared input interactive", () => {
		expect(resolveLaunchDisposition({ ...base, hasPreparedInput: true })).toEqual({
			autoPrint: false,
			isInteractive: true,
		});
	});

	it("fails fast when non-TTY stdin has no input, including Bun's undefined isTTY", () => {
		const disposition = resolveLaunchDisposition({ ...base, stdinIsTTY: undefined });

		expect(disposition).toEqual({
			autoPrint: false,
			isInteractive: false,
			nonInteractiveError: expect.stringContaining("stdin is not a TTY"),
		});
	});

	it("auto-prints piped input and positional prompts on non-TTY stdin", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, pipedInput: "review this" })).toEqual({
			autoPrint: true,
			isInteractive: false,
		});
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, hasPreparedInput: true })).toEqual({
			autoPrint: true,
			isInteractive: false,
		});
	});

	it("auto-prints @file input even when the file contains only an image", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: undefined, hasPreparedInput: true })).toEqual({
			autoPrint: true,
			isInteractive: false,
		});
	});

	it("leaves explicit print and protocol modes non-interactive", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: undefined, print: true })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: undefined, mode: "acp" })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
	});
});

async function runCliWithIgnoredStdin(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const result = await Promise.race([
		proc.exited.then(exitCode => ({ timedOut: false as const, exitCode })),
		Bun.sleep(8_000).then(() => ({ timedOut: true as const, exitCode: -1 })),
	]);
	if (result.timedOut) {
		proc.kill();
		await proc.exited;
		throw new Error(`CLI did not exit within the timeout for: ${args.join(" ")}`);
	}
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	return { stdout, stderr, exitCode: result.exitCode };
}

describe("non-TTY CLI startup", () => {
	it("exits instead of hanging when stdin is ignored and no prompt is provided", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-non-tty-startup-"));
		try {
			const result = await runCliWithIgnoredStdin(["--no-session"], {
				...process.env,
				GJC_CODING_AGENT_DIR: root,
				PI_CODING_AGENT_DIR: root,
				GJC_NOTIFICATIONS: "0",
				NO_COLOR: "1",
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("stdin is not a TTY");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("routes a positional prompt to print mode instead of starting the TUI", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-non-tty-prompt-"));
		try {
			const result = await runCliWithIgnoredStdin(["--no-session", "hello"], {
				...process.env,
				GJC_CODING_AGENT_DIR: root,
				PI_CODING_AGENT_DIR: root,
				GJC_NOTIFICATIONS: "0",
				NO_COLOR: "1",
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_OAUTH_TOKEN: "",
				OPENAI_API_KEY: "",
				GEMINI_API_KEY: "",
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("No models available");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 15_000);
});
