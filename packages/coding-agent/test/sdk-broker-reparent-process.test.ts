import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { brokerProcessIncarnation, readBrokerDiscovery } from "../src/sdk/broker/discovery";

const ensureModule = path.resolve(import.meta.dir, "../src/sdk/broker/ensure.ts");

function processTable(): Map<number, number> {
	const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
	const table = new Map<number, number>();
	for (const line of Buffer.from(result.stdout).toString("utf8").split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length !== 2) continue;
		const pid = Number(fields[0]);
		const ppid = Number(fields[1]);
		if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) table.set(pid, ppid);
	}
	return table;
}

function killProcessTree(rootPid: number): void {
	const table = processTable();
	const descendants = new Set<number>([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, ppid] of table) {
			if (descendants.has(ppid) && !descendants.has(pid)) {
				descendants.add(pid);
				changed = true;
			}
		}
	}
	for (const pid of [...descendants].sort((left, right) => right - left)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// The process may have exited between the table read and the signal.
		}
	}
}

async function waitForFile(file: string, parent: Bun.Subprocess): Promise<void> {
	for (let attempt = 0; attempt < 800; attempt++) {
		if (
			await fs
				.stat(file)
				.then(() => true)
				.catch(() => false)
		)
			return;
		if (parent.exitCode !== null || parent.signalCode !== null)
			throw new Error(`Spawner exited before writing ${file}.`);
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${file}`);
}

test.serial(
	"reparents the shared broker outside the spawner process tree",
	async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-reparent-"));
		const agentDir = path.join(root, "agent");
		const ready = path.join(root, "ready");
		const parent = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import * as fs from "node:fs/promises"; import { ensureBroker } from ${JSON.stringify(ensureModule)}; try { const d = await ensureBroker({ agentDir: ${JSON.stringify(agentDir)} }); await fs.writeFile(${JSON.stringify(ready)}, JSON.stringify({ pid: d.pid, heartbeatAt: d.heartbeatAt })); await new Promise(() => {}); } catch (error) { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }`,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		let brokerPid: number | undefined;
		try {
			try {
				await waitForFile(ready, parent);
			} catch (error) {
				if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
				await parent.exited;
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\n${await new Response(parent.stderr).text()}`,
				);
			}
			const initial = JSON.parse(await fs.readFile(ready, "utf8")) as { pid: number };
			brokerPid = initial.pid;
			const brokerIncarnation = brokerProcessIncarnation(brokerPid);
			expect(brokerIncarnation).toBeString();
			const parentPid = parent.pid;
			expect(parentPid).toBeGreaterThan(0);
			const brokerPpid = processTable().get(brokerPid);
			expect(brokerPpid).not.toBe(parentPid);
			const firstHeartbeat = (await readBrokerDiscovery(agentDir))?.heartbeatAt;
			expect(firstHeartbeat).toBeNumber();
			killProcessTree(parentPid);
			await parent.exited;
			await Bun.sleep(6_000);
			const after = await readBrokerDiscovery(agentDir);
			expect(after?.pid).toBe(brokerPid);
			expect(after?.heartbeatAt).toBeGreaterThan(firstHeartbeat!);
		} finally {
			if (brokerPid !== undefined) {
				try {
					process.kill(brokerPid, "SIGTERM");
				} catch {
					// already gone
				}
			}
			if (parent.exitCode === null) parent.kill("SIGKILL");
			await parent.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	60_000,
);
