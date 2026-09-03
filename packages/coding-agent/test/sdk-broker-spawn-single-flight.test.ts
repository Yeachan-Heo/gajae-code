import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as brokerDiscovery from "../src/sdk/broker/discovery";
import { brokerOwnerForTest, ensureBroker } from "../src/sdk/broker/ensure";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const ensureModule = path.resolve(import.meta.dir, "../src/sdk/broker/ensure.ts");
const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-spawn-race-"));
type LockWorker = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			await fs.stat(file);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error(`Timed out waiting for ${file}`);
}

function spawnLockWorker(dir: string, ready: string, journal: string, label: string, holdMs: number): LockWorker {
	const source = `
		import * as fs from "node:fs/promises";
		import { acquireSpawnLockForTest } from ${JSON.stringify(ensureModule)};
		const release = await acquireSpawnLockForTest(${JSON.stringify(dir)}, { retries: 400, retryDelayMs: 10 });
		await fs.writeFile(${JSON.stringify(ready)}, "ready");
		await fs.appendFile(${JSON.stringify(journal)}, ${JSON.stringify(`${label}:start\n`)});
		await Bun.sleep(${holdMs});
		await fs.appendFile(${JSON.stringify(journal)}, ${JSON.stringify(`${label}:end\n`)});
		await release();
	`;
	return Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

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
		const results = await Promise.all(
			invocations.map(async child => ({ code: await child.exited, out: await new Response(child.stdout).text() })),
		);
		for (const result of results) expect(result.code).toBe(0);
		const discovery = await brokerDiscovery.readBrokerDiscovery(dir, undefined);
		expect(discovery).toBeDefined();
		brokerPids.add(discovery!.pid);
		const sdk = path.join(dir, "sdk");
		const names = await fs.readdir(sdk);
		expect(names.filter(name => name.startsWith(".broker.lock.stale-"))).toEqual([]);
		expect(names).not.toContain("broker.spawn.lock");
		const sessions = await fs.readdir(path.join(sdk, "sessions")).catch(() => [] as string[]);
		expect(sessions.filter(name => name.startsWith("index.jsonl.lock"))).toEqual([]);
		// Exactly one broker process bound to this dir.
		const ps = Bun.spawnSync(["ps", "-Ao", "args="]).stdout.toString();
		const brokers = ps
			.split("\n")
			.filter(line => line.includes("broker-internal") && line.includes(`--agent-dir ${dir}`));
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

it("releases the spawn lock when the under-lock discovery read fails so the next spawn succeeds", async () => {
	const dir = await temp();
	const readBrokerDiscovery = brokerDiscovery.readBrokerDiscovery;
	let reads = 0;
	const readSpy = spyOn(brokerDiscovery, "readBrokerDiscovery").mockImplementation(async (...args) => {
		reads += 1;
		if (reads === 1) return null;
		if (reads === 2) throw new Error("injected under-lock discovery failure");
		return readBrokerDiscovery(...args);
	});
	try {
		await expect(ensureBroker({ agentDir: dir })).rejects.toThrow("injected under-lock discovery failure");
		readSpy.mockRestore();
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");

		const discovery = await ensureBroker({ agentDir: dir });
		expect(discovery.pid).toBeGreaterThan(0);
		expect(await brokerDiscovery.readBrokerDiscovery(dir)).toMatchObject({ pid: discovery.pid });
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		readSpy.mockRestore();
		await brokerOwnerForTest(dir)?.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("the spawn lock rejects an incomplete published owner instead of acquiring over it", async () => {
	const { acquireSpawnLockForTest } = await import("../src/sdk/broker/ensure");
	const dir = await temp();
	try {
		await fs.mkdir(path.join(dir, "sdk", "broker.spawn.lock"), { recursive: true });
		await expect(acquireSpawnLockForTest(dir, { retries: 1, retryDelayMs: 1 })).rejects.toThrow(
			"held by an unrecognized owner record",
		);
		expect(await fs.readdir(path.join(dir, "sdk", "broker.spawn.lock"))).toEqual([]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

it("two OS processes reclaim a dead holder without overlapping critical sections", async () => {
	const dir = await temp();
	const journal = path.join(dir, "journal");
	const deadReady = path.join(dir, "dead.ready");
	const leftReady = path.join(dir, "left.ready");
	const rightReady = path.join(dir, "right.ready");
	const children = new Set<LockWorker>();
	try {
		const dead = spawnLockWorker(dir, deadReady, journal, "dead", 60_000);
		children.add(dead);
		await waitForFile(deadReady);
		dead.kill("SIGKILL");
		await dead.exited;
		children.delete(dead);
		await fs.writeFile(journal, "");

		const left = spawnLockWorker(dir, leftReady, journal, "left", 150);
		const right = spawnLockWorker(dir, rightReady, journal, "right", 150);
		children.add(left);
		children.add(right);
		const [leftCode, rightCode, leftError, rightError] = await Promise.all([
			left.exited,
			right.exited,
			new Response(left.stderr).text(),
			new Response(right.stderr).text(),
		]);
		children.delete(left);
		children.delete(right);
		expect({ leftCode, leftError, rightCode, rightError }).toEqual({
			leftCode: 0,
			leftError: "",
			rightCode: 0,
			rightError: "",
		});
		const events = (await fs.readFile(journal, "utf8")).trim().split("\n");
		expect([
			["left:start", "left:end", "right:start", "right:end"],
			["right:start", "right:end", "left:start", "left:end"],
		]).toContainEqual(events);
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		for (const child of children) child.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("a recycled live PID does not keep a dead spawn-lock generation alive", async () => {
	const { acquireSpawnLockForTest } = await import("../src/sdk/broker/ensure");
	const dir = await temp();
	const ready = path.join(dir, "holder.ready");
	const journal = path.join(dir, "journal");
	const holder = spawnLockWorker(dir, ready, journal, "holder", 60_000);
	try {
		await waitForFile(ready);
		holder.kill("SIGKILL");
		await holder.exited;
		const infoPath = path.join(dir, "sdk", "broker.spawn.lock", "info");
		const info = JSON.parse(await fs.readFile(infoPath, "utf8")) as Record<string, unknown>;
		expect(typeof info.process_incarnation).toBe("string");
		info.pid = process.pid;
		info.process_incarnation = "recycled-process-generation";
		await fs.writeFile(infoPath, JSON.stringify(info));

		const release = await acquireSpawnLockForTest(dir, { retries: 20, retryDelayMs: 10 });
		await release();
		expect(await fs.readdir(path.join(dir, "sdk"))).not.toContain("broker.spawn.lock");
	} finally {
		holder.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 30_000);
