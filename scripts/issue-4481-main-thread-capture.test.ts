import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const script = path.join(import.meta.dir, "issue-4481-main-thread-capture.py");
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-4481-capture-test-"));
	tempDirs.push(dir);
	return dir;
}

async function runHarness(dir: string, args: string[], source: string): Promise<{ exitCode: number; summary: Record<string, unknown> }> {
	const child = Bun.spawn(
		[
			"python3",
			script,
			"--artifact-dir",
			dir,
			...args,
			"--",
			process.execPath,
			"-e",
			source,
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const exitCode = await child.exited;
	const stderr = await new Response(child.stderr).text();
	if (exitCode !== 0 && exitCode !== 2) throw new Error(stderr);
	return { exitCode, summary: await Bun.file(path.join(dir, "summary.json")).json() };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("issue #4481 PTY capture harness", () => {
	test("keeps a healthy event-loop heartbeat live and SIGTERM reaps", async () => {
		const dir = await tempDir();
		const { exitCode, summary } = await runHarness(
			dir,
			["--duration", "1", "--sample-seconds", "0.25", "--term-grace", "1"],
			"setInterval(() => {}, 1000)",
		);
		expect(exitCode).toBe(0);
		expect(summary).toMatchObject({
			wedge_detected: false,
			alive_after_cleanup: false,
			termination: { sigterm_sent: true, sigterm_exited: true, sigkill_sent: false },
		});
		expect((await Bun.file(path.join(dir, "heartbeat.txt")).text()).trim()).not.toBe("");
	});

	test("detects an allocating main-thread loop with a stale heartbeat", async () => {
		const dir = await tempDir();
		const { exitCode, summary } = await runHarness(
			dir,
			[
				"--duration",
				"6",
				"--sample-seconds",
				"0.5",
				"--stale-seconds",
				"0.5",
				"--consecutive",
				"2",
				"--term-grace",
				"1",
			],
			"const sink=[]; for (;;) { sink.push(`${Math.random()}`.repeat(8)); if (sink.length > 200000) sink.length=0 }",
		);
		expect(exitCode).toBe(2);
		expect(summary).toMatchObject({ wedge_detected: true, alive_after_cleanup: false });
		const samples = (await Bun.file(path.join(dir, "samples.jsonl")).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { main_percent: number });
		expect(Math.max(...samples.map(sample => sample.main_percent))).toBeGreaterThan(70);
	});

	test("closing the real PTY reaps an event-loop-responsive process", async () => {
		const dir = await tempDir();
		const { exitCode, summary } = await runHarness(
			dir,
			["--duration", "4", "--sample-seconds", "0.25", "--pty-loss-after", "0.75", "--term-grace", "1"],
			"process.stdin.resume(); setInterval(() => {}, 1000)",
		);
		expect(exitCode).toBe(0);
		expect(summary).toMatchObject({ pty_closed: true, wedge_detected: false, alive_after_cleanup: false });
	});

	test("instruments the actual CLI process behind the repository dev command", async () => {
		const dir = await tempDir();
		const child = Bun.spawn(
			[
				"python3",
				script,
				"--artifact-dir",
				dir,
				"--duration",
				"2",
				"--sample-seconds",
				"0.25",
				"--pty-loss-after",
				"0.75",
				"--",
				process.execPath,
				"run",
				"dev",
				"--",
				"--version",
			],
			{ cwd: path.resolve(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" },
		);
		const exitCode = await child.exited;
		const stderr = await new Response(child.stderr).text();
		if (exitCode !== 0) throw new Error(stderr);
		const summary = (await Bun.file(path.join(dir, "summary.json")).json()) as { command: string[] };
		expect(summary.command).toContain("--cwd=packages/coding-agent");
		expect(summary.command).toContain("src/cli.ts");
		expect((await Bun.file(path.join(dir, "heartbeat.txt")).text()).trim()).not.toBe("");
	});

	test("does not classify CPU as a wedge when no heartbeat was established", async () => {
		const dir = await tempDir();
		await Bun.write(path.join(dir, "heartbeat.txt"), `999999 8 ${Date.now() - 60_000}\n`);
		const child = Bun.spawn(
			[
				"python3",
				script,
				"--artifact-dir",
				dir,
				"--duration",
				"1",
				"--sample-seconds",
				"0.25",
				"--stale-seconds",
				"0.25",
				"--consecutive",
				"2",
				"--",
				"python3",
				"-c",
				"while True: object()",
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const exitCode = await child.exited;
		const stderr = await new Response(child.stderr).text();
		if (exitCode !== 0) throw new Error(stderr);
		const summary = (await Bun.file(path.join(dir, "summary.json")).json()) as { wedge_detected: boolean };
		expect(summary.wedge_detected).toBe(false);
		expect(await Bun.file(path.join(dir, "heartbeat.txt")).exists()).toBe(false);
	});
});
