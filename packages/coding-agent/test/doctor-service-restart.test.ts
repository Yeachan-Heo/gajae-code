import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { artifactTargetId, resolveDoctorRoot, serviceTargetId } from "../src/cli/doctor/ids";
import type { DoctorReport } from "../src/cli/doctor/types";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { chatDaemonGeneration } from "../src/sdk/bus/chat-daemon-control";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const config = path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml");
const roots: string[] = [];
const spawned: Bun.Subprocess[] = [];

async function agentDirectory(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-service-restart-")));
	roots.push(root);
	return root;
}
async function startBroker(agentDir: string): Promise<{ pid: number }> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", `--config=${config}`, cli, "sdk", "broker-internal", "--agent-dir", agentDir],
		{
			env: {
				PATH: process.env.PATH,
				HOME: agentDir,
				GJC_CODING_AGENT_DIR: agentDir,
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	spawned.push(child);
	const deadline = Date.now() + 20_000;
	for (;;) {
		const discovery = await readBrokerDiscovery(agentDir);
		if (discovery) return { pid: discovery.pid };
		if (child.exitCode !== null) throw new Error(`broker exited early: ${await new Response(child.stderr).text()}`);
		if (Date.now() > deadline) throw new Error("broker did not publish discovery");
		await Bun.sleep(50);
	}
}
async function doctor(
	agentDir: string,
	args: string[],
): Promise<{ report: DoctorReport; code: number; output: string }> {
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", `--config=${config}`, cli, "doctor", "--json", ...args],
		{
			cwd: agentDir,
			env: {
				PATH: process.env.PATH,
				HOME: agentDir,
				GJC_CODING_AGENT_DIR: agentDir,
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				NO_COLOR: "1",
				GJC_DOCTOR_DEBUG: path.join(agentDir, "restart-debug.log"),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const debug = await Bun.file(path.join(agentDir, "restart-debug.log"))
			.text()
			.catch(() => "");
		return { report: JSON.parse(stdout) as DoctorReport, code, output: stdout + stderr + debug };
	} finally {
		clearTimeout(timer);
	}
}
afterEach(async () => {
	for (const child of spawned.splice(0)) child.kill("SIGKILL");
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("doctor service.restart-owned budget", () => {
	test("derives the restart budget from the monotonic deadline and grows it with --drain", async () => {
		// Regression lock: the budget is computed against `context.deadline`, which is a
		// performance.now() value. Subtracting Date.now() there yields a large negative
		// remainder that clamps every restart to the 1s floor and silently defeats --drain.
		const source = await Bun.file(path.resolve(import.meta.dir, "../src/cli/doctor/repairs.ts")).text();
		const start = source.indexOf("const deadlineMs = Math.max(");
		expect(start).toBeGreaterThan(-1);
		const expression = source
			.slice(start, source.indexOf("let outcome:", start))
			.split("\n")
			.filter(line => !line.trim().startsWith("//"))
			.join("\n");
		expect(expression).toContain("context.deadline - performance.now()");
		expect(expression).not.toContain("Date.now()");
		expect(expression).toContain("(drainSeconds ?? 0) * 1_000");

		// The same arithmetic, evaluated: a live monotonic deadline must produce the
		// action ceiling rather than the floor, and --drain must raise it.
		const deadline = performance.now() + 120_000;
		const compute = (drainSeconds: number | undefined): number =>
			Math.max(1_000, Math.min(deadline - performance.now(), 15_000 + (drainSeconds ?? 0) * 1_000));
		expect(compute(undefined)).toBe(15_000);
		expect(compute(30)).toBeGreaterThan(compute(undefined));
	});
});

describe("doctor service.restart-owned", () => {
	test("restarts a live owned broker into a new incarnation and never prints its token", async () => {
		const agentDir = await agentDirectory();
		const before = await startBroker(agentDir);
		const rootId = resolveDoctorRoot("agent", agentDir).rootId;
		const target = serviceTargetId(rootId, "broker");
		const published = await readBrokerDiscovery(agentDir);
		expect(published?.pid).toBe(before.pid);

		const result = await doctor(agentDir, [
			"--check",
			"service",
			"--fix",
			"--repair",
			"service.restart-owned",
			"--target",
			target,
			"--allow-risk",
			"service-interruption",
			"--yes",
			"--timeout-ms",
			"60000",
		]);
		const repair = result.report.repairs[0];
		expect(repair.id).toBe("service.restart-owned");
		expect(repair.state, `${JSON.stringify(repair)}\n${result.output.slice(-2000)}`).toBe("verified");
		expect(result.code).toBe(0);
		const after = await readBrokerDiscovery(agentDir);
		expect(after).toBeTruthy();
		expect(after?.pid).not.toBe(before.pid);
		if (after)
			spawned.push({
				kill: (signal: string) => process.kill(after.pid, signal as NodeJS.Signals),
			} as unknown as Bun.Subprocess);
		expect(published?.token && result.output.includes(published.token)).toBeFalsy();
	}, 180_000);

	test("refuses a restart with no owner record without creating service state", async () => {
		const agentDir = await agentDirectory();
		const rootId = resolveDoctorRoot("agent", agentDir).rootId;
		const result = await doctor(agentDir, [
			"--check",
			"service",
			"--fix",
			"--repair",
			"service.restart-owned",
			"--target",
			serviceTargetId(rootId, "broker"),
			"--allow-risk",
			"service-interruption",
			"--yes",
		]);
		expect(result.report.repairs[0]).toMatchObject({
			state: "blocked",
			reasonCode: "service_owner_absent",
			sideEffectStarted: false,
		});
		expect(await fs.readdir(agentDir).catch(() => [])).not.toContain("sdk");
	}, 60_000);

	test("refuses a telegram restart whose recorded owner predates the current protocol generation", async () => {
		const agentDir = await agentDirectory();
		const rootId = resolveDoctorRoot("agent", agentDir).rootId;
		const daemon = path.join(agentDir, "notifications");
		await fs.mkdir(daemon, { recursive: true, mode: 0o700 });
		// A pre-protocol incumbent: the approved contract requires a disclosed manual
		// transition, never an automatic signal or kill from doctor.
		const state = {
			version: 1,
			pid: 0x7fff_fffe,
			incarnation: "darwin:1:1",
			ownerId: "owner-1",
			tokenFingerprint: "fp",
			chatId: "chat",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		await Bun.write(path.join(daemon, "telegram-daemon.state.json"), JSON.stringify(state));
		const result = await doctor(agentDir, [
			"--check",
			"service",
			"--fix",
			"--repair",
			"service.restart-owned",
			"--target",
			serviceTargetId(rootId, "telegram"),
			"--allow-risk",
			"service-interruption",
			"--yes",
		]);
		expect(result.report.repairs[0]).toMatchObject({ state: "blocked", sideEffectStarted: false });
		// The refusal names WHY the owner is undrivable, not merely that it is:
		// a pre-generation incumbent needs the disclosed manual transition.
		expect(result.report.repairs[0].reasonCode).toBe("owner_unavailable:unsupported_incumbent_protocol");
		// The incumbent record is untouched and no control request was published.
		expect(await Bun.file(path.join(daemon, "telegram-daemon.state.json")).json()).toMatchObject({
			pid: state.pid,
			incarnation: "darwin:1:1",
		});
		expect(await Bun.file(path.join(daemon, "doctor-restart.control.json")).exists()).toBe(false);
		expect(artifactTargetId(rootId, "telegram", "discovery")).toContain("telegram");
	}, 60_000);

	test("refuses a chat restart whose recorded owner is not a live current-generation process", async () => {
		const agentDir = await agentDirectory();
		const rootId = resolveDoctorRoot("agent", agentDir).rootId;
		const daemon = path.join(agentDir, "sdk", "daemons", "discord");
		await fs.mkdir(daemon, { recursive: true, mode: 0o700 });
		// A recorded owner whose pid cannot be a live process: the restart must refuse
		// rather than "restart" a service that has no proven incumbent.
		const state = {
			version: 1,
			kind: "discord",
			pid: 0x7fff_fffe,
			ownerId: "owner-1",
			identity: "cfg",
			incarnation: "darwin:1:1",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			transportHealthy: true,
			// The CURRENT generation: this case must exercise the liveness gate, not
			// the pre-protocol gate that precedes it.
			generation: chatDaemonGeneration("discord"),
		};
		await Bun.write(path.join(daemon, "state.json"), JSON.stringify(state));
		const result = await doctor(agentDir, [
			"--check",
			"service",
			"--fix",
			"--repair",
			"service.restart-owned",
			"--target",
			serviceTargetId(rootId, "discord"),
			"--allow-risk",
			"service-interruption",
			"--yes",
		]);
		expect(result.report.repairs[0]).toMatchObject({ state: "blocked", sideEffectStarted: false });
		expect(result.report.repairs[0].reasonCode).toBe("owner_unavailable:owner_not_confirmed_live");
		// No control request was published and the recorded state is untouched.
		expect(await Bun.file(path.join(daemon, "state.json")).json()).toMatchObject({
			pid: state.pid,
			incarnation: "darwin:1:1",
		});
		expect(await Bun.file(path.join(daemon, "doctor-restart.control.json")).exists()).toBe(false);
		expect(artifactTargetId(rootId, "discord", "discovery")).toContain("discord");
	}, 60_000);
});
