import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface TerminalScenario {
	name: string;
	exitCode: number;
	signal?: NodeJS.Signals;
}

const probe = path.join(import.meta.dir, "fixtures", "session-state-lock-terminal-probe.ts");
const roots: string[] = [];

async function waitForFile(file: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (
			await fs.stat(file).then(
				() => true,
				() => false,
			)
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${file}`);
}

async function runScenario(scenario: TerminalScenario): Promise<Record<string, unknown>> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-terminal-lock-${scenario.name}-`));
	roots.push(root);
	const child = Bun.spawn([process.execPath, probe, scenario.name, root], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: {
			...process.env,
			GJC_CLEANUP_DEADLINE_MS: "750",
			GJC_CODING_AGENT_DIR: path.join(root, "agent"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	try {
		await waitForFile(path.join(root, "ready"));
		if (scenario.signal) child.kill(scenario.signal);
		const timedOut = Symbol("timed-out");
		const exit = await Promise.race([child.exited, Bun.sleep(5_000).then(() => timedOut)]);
		if (exit === timedOut) {
			child.kill("SIGKILL");
			await child.exited;
			throw new Error(`terminal lock probe timed out: ${scenario.name}`);
		}
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exit !== scenario.exitCode) {
			throw new Error(
				`terminal lock probe ${scenario.name} exited ${String(exit)}, expected ${scenario.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		await waitForFile(path.join(root, "cleanup-lock-entered"));
		return JSON.parse(await fs.readFile(path.join(root, "runtime-state.json.lock"), "utf8")) as Record<
			string,
			unknown
		>;
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("session-state locks at process-terminal boundaries", () => {
	for (const scenario of [
		{ name: "sigint", signal: "SIGINT", exitCode: 130 },
		{ name: "sigterm", signal: "SIGTERM", exitCode: 143 },
		{ name: "sighup", signal: "SIGHUP", exitCode: 129 },
		{ name: "uncaught-exception", exitCode: 1 },
		{ name: "unhandled-rejection", exitCode: 1 },
		{ name: "quit", exitCode: 7 },
	] satisfies TerminalScenario[]) {
		it(`tombstones a lock acquired during ${scenario.name} cleanup`, async () => {
			expect(await runScenario(scenario)).toMatchObject({
				pid: 1,
				start_time: "unknown",
				owner_host_id: "terminal-probe-host",
				released: true,
			});
		}, 10_000);
	}
});
