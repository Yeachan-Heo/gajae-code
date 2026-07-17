import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";

describe("SDK broker restart", () => {
	it("takes over a stale lock and rotates discovery token", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-restart-"));
		const a = new Broker({ agentDir: dir });
		const first = await a.start();
		await a.stop();
		const b = new Broker({ agentDir: dir });
		const second = await b.start();
		expect(second.token).not.toBe(first.token);
		await b.stop();
	});

	it("allows one owner during simultaneous primary lock takeover", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-restart-race-"));
		const lock = path.join(dir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true });
		await fs.writeFile(
			path.join(lock, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "stale-owner", pid: 999_999_999, acquiredAt: 0 }),
		);

		const a = new Broker({ agentDir: dir });
		const b = new Broker({ agentDir: dir });
		try {
			const [first, second] = await Promise.all([a.start(), b.start()]);
			expect(first.ownerId).toBe(second.ownerId);
			expect(first.token).toBe(second.token);
			expect([a, b].filter(broker => broker.ownsDiscovery)).toHaveLength(1);
		} finally {
			await a.stop();
			await b.stop();
		}
	});

	it("takes over a legacy regular-file stale lock", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-restart-legacy-"));
		const lock = path.join(dir, "sdk", "broker.lock");
		await fs.mkdir(path.dirname(lock), { recursive: true });
		await fs.writeFile(lock, JSON.stringify({ ownerId: "stale-owner", pid: 999_999_999, ts: 0 }));

		const broker = new Broker({ agentDir: dir });
		try {
			await broker.start();
			expect(broker.ownsDiscovery).toBe(true);
		} finally {
			await broker.stop();
		}
	});
});
