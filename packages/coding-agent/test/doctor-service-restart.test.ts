import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DoctorContext, DoctorServiceTarget } from "../src/cli/doctor/context";
import { artifactTargetId, resolveDoctorRoot, serviceTargetId } from "../src/cli/doctor/ids";
import { executeSelectedDoctorRepair, planSelectedDoctorRepair } from "../src/cli/doctor/repairs";
import type { DoctorServiceObservation } from "../src/cli/doctor/service-targets";
import * as serviceTargets from "../src/cli/doctor/service-targets";
import type { DoctorCheck, DoctorReport } from "../src/cli/doctor/types";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import type { DoctorBrokerRestartOutcome } from "../src/sdk/broker/doctor-restart";
import * as doctorRestart from "../src/sdk/broker/doctor-restart";
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
	extraEnv: Record<string, string> = {},
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
				...extraEnv,
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
		// No directory or owner exists: even a missed adapter interception cannot
		// discover an incumbent. These records are synthetic, not restart authority.
		const root = resolveDoctorRoot("agent", path.join(os.tmpdir(), `doctor-budget-absent-${crypto.randomUUID()}`));
		await expect(fs.lstat(root.locator)).rejects.toMatchObject({ code: "ENOENT" });
		const targetId = serviceTargetId(root.rootId, "broker");
		const observation: DoctorServiceObservation = {
			service: "broker",
			paths: serviceTargets.doctorServicePaths(root.locator, "broker"),
			state: {
				status: "read",
				text: JSON.stringify({ incarnation: "synthetic-incumbent" }),
				identity: {
					device: 0,
					inode: 0,
					size: 0,
					modifiedMs: 0,
					changedMs: 0,
					mode: 0,
					owner: 0,
					links: 1,
				},
				exactIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
			},
			owner: { status: "missing" },
			restartIntent: { status: "missing" },
		};
		const target: DoctorServiceTarget = { kind: "service", targetId, service: "broker", root, observation };
		const beforeCheck: DoctorCheck = {
			id: "service.broker.synthetic-before",
			targetId,
			execution: "completed",
			health: "unknown",
			evidenceLevel: "not_probed",
			dependsOn: [],
			evidence: { present: true },
			remediationIds: ["service.restart-owned"],
		};
		const beforeChecks: readonly DoctorCheck[] = [beforeCheck];
		const afterChecks: readonly DoctorCheck[] = [{ ...beforeCheck, id: "service.broker.synthetic-after" }];
		const refusal: DoctorBrokerRestartOutcome = { kind: "attach_only_refused", reason: "supervisor_owned" };
		const boundaries: string[] = [];
		const restore: (() => void)[] = [];
		try {
			const now = spyOn(performance, "now");
			restore.push(() => now.mockRestore());
			now.mockReturnValue(10_000);
			const restart = spyOn(doctorRestart, "restartBrokerForDoctor");
			restore.push(() => restart.mockRestore());
			restart.mockImplementation(async () => {
				boundaries.push("restart");
				return refusal;
			});
			const reread = spyOn(serviceTargets, "readDoctorService");
			restore.push(() => reread.mockRestore());
			reread.mockImplementation(async () => {
				boundaries.push("reread");
				return observation;
			});
			for (const scenario of [
				{ remaining: 120_000, drainSeconds: undefined, deadlineMs: 15_000, drain: false },
				{ remaining: 120_000, drainSeconds: 30, deadlineMs: 45_000, drain: true },
				{ remaining: 5_000, drainSeconds: undefined, deadlineMs: 5_000, drain: false },
				{ remaining: 500, drainSeconds: undefined, deadlineMs: 1_000, drain: false },
			]) {
				restart.mockClear();
				reread.mockClear();
				boundaries.length = 0;
				const context: DoctorContext = {
					options: {
						mode: "fix",
						json: false,
						help: false,
						checks: ["service"],
						repair: "service.restart-owned",
						targetId,
						allowRisks: ["service-interruption"],
						yes: true,
						drainSeconds: scenario.drainSeconds,
					},
					cwd: root.locator,
					agentRoot: root,
					installRoot: resolveDoctorRoot("install", root.locator),
					sources: [],
					targets: new Map([[targetId, target]]),
					compiled: false,
					executable: process.execPath,
					deadline: 10_000 + scenario.remaining,
				};
				const plan = planSelectedDoctorRepair(context, beforeChecks);
				expect(plan?.state).toBe("planned");
				if (!plan) throw new Error("synthetic selected repair was not planned");
				const requestId = `synthetic-budget-${scenario.remaining}-${scenario.drain}`;
				const result = await executeSelectedDoctorRepair(context, requestId, plan, async () => {
					boundaries.push("after-check");
					return afterChecks;
				});
				expect(restart).toHaveBeenCalledTimes(1);
				expect(restart).toHaveBeenCalledWith({
					agentDir: root.locator,
					requestId,
					deadlineMs: scenario.deadlineMs,
					drain: scenario.drain,
				});
				expect(result.repair).toMatchObject({
					state: "blocked",
					reasonCode: "attach_only_refused:supervisor_owned",
					sideEffectStarted: false,
				});
				expect(result.invocationError).toBeUndefined();
				expect(result.afterChecks).toBe(afterChecks);
				expect(reread).toHaveBeenCalledTimes(1);
				expect(reread).toHaveBeenCalledWith(root.locator, "broker");
				expect(boundaries).toEqual(["restart", "after-check", "reread"]);
			}
		} finally {
			for (const cleanup of restore.reverse()) cleanup();
		}
		await expect(fs.lstat(root.locator)).rejects.toMatchObject({ code: "ENOENT" });
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

	test("refuses to restart a supervisor-owned broker in attach-only mode before any effect", async () => {
		const agentDir = await agentDirectory();
		const before = await startBroker(agentDir);
		const rootId = resolveDoctorRoot("agent", agentDir).rootId;
		const result = await doctor(
			agentDir,
			[
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
			],
			{ GJC_SDK_BROKER_AUTOSTART: "0" },
		);
		expect(result.report.repairs[0]).toMatchObject({
			state: "blocked",
			reasonCode: "attach_only_refused:supervisor_owned",
			sideEffectStarted: false,
		});
		// The supervised incumbent keeps serving under the same identity.
		expect((await readBrokerDiscovery(agentDir))?.pid).toBe(before.pid);
	}, 60_000);

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
