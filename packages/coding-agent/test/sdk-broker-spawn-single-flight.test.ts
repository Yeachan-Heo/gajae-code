import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-spawn-race-"));

/**
 * #5198: N CLI invocations that all miss discovery on a cold agent dir must
 * not each spawn a detached broker. Exactly one broker may exist afterwards
 * and the lock tree must carry no quarantine tombstones.
 */
it("concurrent CLI invocations on a cold agent dir spawn exactly one broker and leave no tombstones", async () => {
	const dir = await temp();
	const brokerPids = new Set<number>();
	try {
		const invocations = Array.from({ length: 6 }, (_, i) =>
			Bun.spawn([process.execPath, "run", cli, "sdk", "session", "list", "--scope", "all", "--agent-dir", dir], {
				cwd: import.meta.dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GJC_TEST_SPAWN_RACE: String(i) },
			}),
		);
		const results = await Promise.all(invocations.map(async (child) => ({ code: await child.exited, out: await new Response(child.stdout).text() })));
		for (const result of results) expect(result.code).toBe(0);
		const discovery = await readBrokerDiscovery(dir, undefined);
		expect(discovery).toBeDefined();
		brokerPids.add(discovery!.pid);
		const sdk = path.join(dir, "sdk");
		const names = await fs.readdir(sdk);
		expect(names.filter((name) => name.startsWith(".broker.lock.stale-"))).toEqual([]);
		expect(names).not.toContain("broker.spawn.lock");
		const sessions = await fs.readdir(path.join(sdk, "sessions")).catch(() => [] as string[]);
		expect(sessions.filter((name) => name.startsWith("index.jsonl.lock"))).toEqual([]);
		// Exactly one broker process bound to this dir.
		const ps = Bun.spawnSync(["ps", "-Ao", "args="]).stdout.toString();
		const brokers = ps.split("\n").filter((line) => line.includes("broker-internal") && line.includes(`--agent-dir ${dir}`));
		expect(brokers).toHaveLength(1);
	} finally {
		for (const pid of brokerPids)
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// gone
			}
		await Bun.sleep(300);
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60_000);

it("the spawn lock is exclusive across processes and reclaims a dead holder", async () => {
	const { acquireSpawnLockForTest } = await import("../src/sdk/broker/ensure");
	const dir = await temp();
	try {
		const release = await acquireSpawnLockForTest(dir);
		expect(release).toBeDefined();
		// A second contender (same or another process) must not spawn while held.
		expect(await acquireSpawnLockForTest(dir)).toBeUndefined();
		await release!();
		// A marker left by a dead pid is reclaimed instead of blocking forever.
		await fs.writeFile(path.join(dir, "sdk", "broker.spawn.lock"), "999999999\n");
		const reclaimed = await acquireSpawnLockForTest(dir);
		expect(reclaimed).toBeDefined();
		await reclaimed!();
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
