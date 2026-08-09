import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { BROKER_SPAWN_LOG_TAIL_BYTES, openBrokerSpawnLog, readBrokerSpawnLogTail } from "../src/sdk/broker/ensure";

test("concurrent broker spawn logs retain only their own diagnostics", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawnlog-"));
	let firstPath: string | undefined;
	let secondPath: string | undefined;
	try {
		const [first, second] = await Promise.all([openBrokerSpawnLog(agentDir), openBrokerSpawnLog(agentDir)]);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) throw new Error("Broker spawn log could not be opened.");
		firstPath = first.path;
		secondPath = second.path;
		expect(first.path).not.toBe(second.path);

		await first.handle.writeFile(`${"A".repeat(BROKER_SPAWN_LOG_TAIL_BYTES + 1_904)}\n`);
		await second.handle.writeFile("B: entrypoint is not a readable regular file\n");
		await first.handle.writeFile("A: later diagnostic\n");
		await Promise.all([first.handle.close(), second.handle.close()]);

		const secondTail = await readBrokerSpawnLogTail(second.path);
		expect(secondTail).toBe("B: entrypoint is not a readable regular file");
		expect(secondTail).not.toContain("A: later diagnostic");
		expect(secondTail).not.toContain("\0");
	} finally {
		await Promise.all([
			...(firstPath ? [fs.unlink(firstPath).catch(() => {})] : []),
			...(secondPath ? [fs.unlink(secondPath).catch(() => {})] : []),
		]);
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
