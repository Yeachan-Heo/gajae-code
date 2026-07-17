import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLaunchDisposition, shouldReadPipedInput } from "@gajae-code/coding-agent/main";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const cleanupRoots: string[] = [];

const base = {
	stdinIsTTY: true,
	hasPreparedInput: false,
	hasPipedInput: false,
	print: false,
	mode: undefined,
};

afterAll(async () => {
	await Promise.all(cleanupRoots.map(root => fs.rm(root, { recursive: true, force: true })));
});

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runNonTty(args: string[], stdin: string): Promise<ProcessResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-non-tty-launch-"));
	cleanupRoots.push(root);
	const stateRoot = path.join(root, "state");
	await fs.mkdir(stateRoot, { recursive: true });

	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			XDG_CONFIG_HOME: stateRoot,
			XDG_DATA_HOME: stateRoot,
			GJC_CODING_AGENT_DIR: path.join(stateRoot, "agent"),
			PI_CODING_AGENT_DIR: path.join(stateRoot, "agent"),
			GJC_NOTIFICATIONS: "0",
			GJC_SDK_DISABLE: "1",
			NO_COLOR: "1",
		},
	});
	if (stdin.length > 0) proc.stdin.write(stdin);
	await proc.stdin.end();

	const completion = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">(resolve => {
		timeoutId = setTimeout(() => resolve("timeout"), 10_000);
	});
	const outcome = await Promise.race([
		completion.then(value => ({ kind: "completed" as const, value })),
		timeout.then(() => ({ kind: "timeout" as const })),
	]);
	if (timeoutId) clearTimeout(timeoutId);

	if (outcome.kind === "timeout") {
		proc.kill("SIGKILL");
		await completion;
		throw new Error("non-TTY CLI subprocess did not exit within 10 seconds");
	}
	const [stdout, stderr, exitCode] = outcome.value;
	return { exitCode, stdout, stderr };
}

function expectModelResolutionBoundary(result: ProcessResult): void {
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain('Model "invalid/model" not found');
	expect(result.stderr).not.toContain("stdin is not a TTY and no prompt was provided");
}

describe("resolveLaunchDisposition", () => {
	it("launches interactive on a TTY with no flags", () => {
		expect(resolveLaunchDisposition(base)).toEqual({ autoPrint: false, isInteractive: true });
	});

	it("auto-prints every prepared non-TTY input shape", () => {
		for (const input of [
			{ hasPreparedInput: true, hasPipedInput: true },
			{ hasPreparedInput: true, hasPipedInput: false },
		]) {
			expect(resolveLaunchDisposition({ ...base, ...input, stdinIsTTY: false })).toEqual({
				autoPrint: true,
				isInteractive: false,
			});
		}
	});

	it("fails fast for empty non-TTY stdin without prepared input", () => {
		const disposition = resolveLaunchDisposition({ ...base, stdinIsTTY: false });
		expect(disposition).toEqual({
			autoPrint: false,
			isInteractive: false,
			error: expect.stringContaining("stdin is not a TTY"),
		});
	});

	it("leaves explicit print and protocol modes untouched", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, print: true })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, mode: "rpc" })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
	});

	it("reads pipes only for print-capable modes", () => {
		for (const mode of [undefined, "text", "json"] as const) {
			expect(shouldReadPipedInput(mode, false)).toBe(true);
		}
		for (const mode of ["rpc", "rpc-ui", "acp", "bridge"] as const) {
			expect(shouldReadPipedInput(mode, false)).toBe(false);
		}
		expect(shouldReadPipedInput(undefined, true)).toBe(false);
	});
});

describe("non-TTY CLI subprocess", () => {
	it("fails fast on empty stdin instead of entering the TUI", async () => {
		const result = await runNonTty(["--no-session"], "");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("stdin is not a TTY and no prompt was provided");
	});

	it("reads piped content when Bun reports non-TTY isTTY as undefined", async () => {
		const result = await runNonTty(["--no-session", "--model", "invalid/model"], "review this");
		expectModelResolutionBoundary(result);
	});

	it("preserves piped input for explicit print, text, and json modes", async () => {
		for (const args of [["--print"], ["--mode", "text"], ["--mode", "json"]]) {
			const result = await runNonTty(["--no-session", "--model", "invalid/model", ...args], "review this");
			expectModelResolutionBoundary(result);
		}
	});

	it("leaves protocol stdin unread for every stdio protocol mode", async () => {
		for (const mode of ["rpc", "rpc-ui", "acp", "bridge"]) {
			const result = await runNonTty(
				["--no-session", "--model", "invalid/model", "--mode", mode],
				"protocol-owned input",
			);
			if (mode === "acp") {
				expect(result.exitCode).toBe(0);
				expect(result.stderr).toContain("Failed to parse JSON message: protocol-owned input");
				expect(result.stderr).not.toContain("stdin is not a TTY and no prompt was provided");
			} else {
				expectModelResolutionBoundary(result);
			}
		}
	});

	it("accepts positional and @file text as prepared input with empty stdin", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-non-tty-file-"));
		cleanupRoots.push(root);
		const textPath = path.join(root, "notes.txt");
		await Bun.write(textPath, "review these notes");

		for (const args of [
			["--no-session", "--model", "invalid/model", "review this"],
			["--no-session", "--model", "invalid/model", `@${textPath}`],
		]) {
			const result = await runNonTty(args, "");
			expectModelResolutionBoundary(result);
		}
	});

	it("accepts @file image input with empty stdin", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-non-tty-image-"));
		cleanupRoots.push(root);
		const imagePath = path.join(root, "pixel.png");
		await Bun.write(
			imagePath,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64",
			),
		);

		const result = await runNonTty(["--no-session", "--model", "invalid/model", `@${imagePath}`], "");
		expectModelResolutionBoundary(result);
	});
});
