import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGjcGcCommand } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { harnessLeasesGcAdapter } from "@gajae-code/coding-agent/harness-control-plane/gc-adapter";
import { SessionIndex } from "../src/sdk/broker/session-index";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-e2e-"));
	tempDirs.push(dir);
	return dir;
}

/** Spawn and reap a process so its pid is guaranteed dead (ESRCH on probe). */
async function reapedPid(): Promise<number> {
	const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function seedDeadLease(base: string, registryDir: string, deadPid: number): Promise<string> {
	const root = path.join(base, "root");
	await writeJson(path.join(registryDir, "h-e2e.json"), {
		sessionId: "h-e2e",
		roots: [{ root, updatedAt: new Date().toISOString() }],
	});
	const leaseFile = path.join(root, "sessions", "h-e2e", "lease.json");
	const now = new Date();
	await writeJson(leaseFile, {
		ownerId: "owner-e2e",
		sessionId: "h-e2e",
		pid: deadPid,
		leaseTokenHash: "deadbeef",
		endpoint: null,
		eventsPath: "events.jsonl",
		heartbeatAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
		leaseEpoch: 1,
		writer: { ownerId: "owner-e2e", leaseEpoch: 1 },
	});
	return leaseFile;
}

describe("gjc gc end-to-end (harness lease adapter)", () => {
	test("dry-run reports a dead lease as would_remove and deletes nothing", async () => {
		const base = await makeTemp();
		const registryDir = path.join(base, "reg");
		const deadPid = await reapedPid();
		const leaseFile = await seedDeadLease(base, registryDir, deadPid);
		const env = { ...process.env, GJC_CODING_AGENT_DIR: base, GJC_HARNESS_ROOT_REGISTRY_DIR: registryDir };

		const result = await runGjcGcCommand(["--json"], base, env, [harnessLeasesGcAdapter]);
		const report = JSON.parse(result.stdout);
		expect(report.dry_run).toBe(true);
		const rec = report.stores.harness_leases.find((r: { id: string }) => r.id === "h-e2e");
		expect(rec?.action).toBe("would_remove");
		expect(rec?.removable).toBe(true);
		// nothing removed in dry-run
		expect(await fs.exists(leaseFile)).toBe(true);
		expect(result.status).toBe(0);
	});

	test("--prune removes the dead lease and exits 0", async () => {
		const base = await makeTemp();
		const registryDir = path.join(base, "reg");
		const deadPid = await reapedPid();
		const leaseFile = await seedDeadLease(base, registryDir, deadPid);
		const env = { ...process.env, GJC_CODING_AGENT_DIR: base, GJC_HARNESS_ROOT_REGISTRY_DIR: registryDir };

		const result = await runGjcGcCommand(["--prune", "--json"], base, env, [harnessLeasesGcAdapter]);
		const report = JSON.parse(result.stdout);
		expect(report.dry_run).toBe(false);
		const rec = report.stores.harness_leases.find((r: { id: string }) => r.id === "h-e2e");
		expect(rec?.action).toBe("removed");
		expect(await fs.exists(leaseFile)).toBe(false);
		expect(result.status).toBe(0);
	});

	test("text dry-run output names the harness store and dry-run mode", async () => {
		const base = await makeTemp();
		const env = {
			...process.env,
			GJC_CODING_AGENT_DIR: base,
			GJC_HARNESS_ROOT_REGISTRY_DIR: path.join(base, "reg-empty"),
		};
		const result = await runGjcGcCommand([], base, env, [harnessLeasesGcAdapter]);
		expect(result.stdout).toContain("dry run");
		expect(result.stdout).toContain("Harness owner leases");
		expect(result.status).toBe(0);
	});

	test("explicit repair quarantines corruption and is idempotent", async () => {
		const base = await makeTemp();
		const agentDir = path.join(base, "agent");
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId: "repairable-session",
			locator: { repo: base, stateRoot: path.join(base, "state") },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: Date.now(),
		});
		const log = path.join(agentDir, "sdk", "sessions", "index.jsonl");
		await fs.appendFile(log, "broken\n");

		const repairEnv = { ...process.env, GJC_CODING_AGENT_DIR: agentDir };
		const repaired = await runGjcGcCommand(["--repair-session-index", "--json"], base, repairEnv, [
			harnessLeasesGcAdapter,
		]);
		const repairReport = JSON.parse(repaired.stdout);
		expect(repairReport.session_index).toMatchObject({ status: "repaired", valid_prefix_seq: 1 });
		expect(repairReport.session_index.quarantine_path).toEqual(expect.any(String));
		expect(await fs.exists(repairReport.session_index.quarantine_path)).toBe(true);
		expect(repaired.status).toBe(0);

		const retry = await runGjcGcCommand(["--repair-session-index", "--json"], base, repairEnv, [
			harnessLeasesGcAdapter,
		]);
		expect(JSON.parse(retry.stdout).session_index).toMatchObject({ status: "healthy", valid_prefix_seq: 1 });
		expect(JSON.parse(retry.stdout).session_index.quarantine_path).toBeUndefined();
		expect(retry.status).toBe(0);
	});
});
