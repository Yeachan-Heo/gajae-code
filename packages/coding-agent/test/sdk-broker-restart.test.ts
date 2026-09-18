import { describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as native from "@gajae-code/natives";
import { Broker } from "../src/sdk/broker/broker";
import { brokerProcessIncarnation } from "../src/sdk/broker/discovery";

const cliEntrypoint = path.join(import.meta.dir, "../src/cli.ts");

async function pathExists(file: string): Promise<boolean> {
	return fs.lstat(file).then(
		() => true,
		() => false,
	);
}

async function waitForPath(file: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await pathExists(file)) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${file}`);
}

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
	it("reclaims repeated identical stale locks into distinct tombstones", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-restart-repeat-"));
		const lock = path.join(dir, "sdk", "broker.lock");
		const owner = JSON.stringify({ version: 1, ownerId: "stale-owner", pid: 999_999_999, acquiredAt: 0 });
		await fs.mkdir(lock, { recursive: true });
		await fs.writeFile(path.join(lock, "owner.json"), owner);

		const first = new Broker({ agentDir: dir });
		try {
			await first.start();
		} finally {
			await first.stop();
		}

		await fs.mkdir(lock, { recursive: true });
		await fs.writeFile(path.join(lock, "owner.json"), owner);
		const second = new Broker({ agentDir: dir });
		try {
			const discovery = await second.start();
			expect(discovery.ownerId).toBeDefined();
			expect(second.ownsDiscovery).toBe(true);
			const tombstones = (await fs.readdir(path.dirname(lock))).filter(name =>
				name.startsWith(".broker.lock.stale-"),
			);
			expect(tombstones).toHaveLength(2);
			expect(new Set(tombstones).size).toBe(2);
		} finally {
			await second.stop();
		}
	});

	it("reclaims a recycled live PID whose incarnation differs", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-restart-recycled-pid-"));
		const lock = path.join(dir, "sdk", "broker.lock");
		const incarnation = brokerProcessIncarnation(process.pid);
		expect(incarnation).toBeDefined();
		await fs.mkdir(lock, { recursive: true });
		await fs.writeFile(
			path.join(lock, "owner.json"),
			JSON.stringify({
				version: 1,
				ownerId: "recycled-owner",
				pid: process.pid,
				incarnation: `${incarnation}-recycled`,
				acquiredAt: 0,
			}),
		);

		const broker = new Broker({ agentDir: dir });
		try {
			await broker.start();
			expect(broker.ownsDiscovery).toBe(true);
			expect((await fs.readdir(path.dirname(lock))).some(name => name.startsWith(".broker.lock.stale-"))).toBe(true);
		} finally {
			await broker.stop();
		}
	});

	it("refuses stale-lock detach after its parent directory is replaced", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-restart-parent-race-"));
		const sdk = path.join(dir, "sdk");
		const lock = path.join(sdk, "broker.lock");
		const replacedSdk = `${sdk}.replaced`;
		const owner = JSON.stringify({ version: 1, ownerId: "stale-owner", pid: 999_999_999, acquiredAt: 0 });
		await fs.mkdir(lock, { recursive: true });
		await fs.writeFile(path.join(lock, "owner.json"), owner);

		const originalExactUnlink = native.exactUnlink;
		let parentReplaced = false;
		const exactUnlinkSpy = vi.spyOn(native, "exactUnlink").mockImplementation((target, identity) => {
			const replaceParent = !parentReplaced && target === lock;
			if (replaceParent) {
				parentReplaced = true;
				fsSync.renameSync(sdk, replacedSdk);
				fsSync.mkdirSync(lock, { recursive: true, mode: 0o700 });
				fsSync.writeFileSync(path.join(lock, "owner.json"), owner);
			}
			const currentParent = fsSync.statSync(sdk, { bigint: true });
			// The replacement is made on the same filesystem, so `dev` is unchanged by
			// construction; only the inode distinguishes the captured parent from the
			// directory the pathname now resolves to.
			expect(identity.parentDev).toBe(currentParent.dev);
			if (replaceParent) expect(identity.parentIno).not.toBe(currentParent.ino);
			else expect(identity.parentIno).toBe(currentParent.ino);
			return originalExactUnlink(target, identity);
		});
		const broker = new Broker({ agentDir: dir });
		try {
			await broker.start();
			expect(parentReplaced).toBe(true);
			expect(await pathExists(path.join(replacedSdk, "broker.lock"))).toBe(true);
			expect(broker.ownsDiscovery).toBe(true);
		} finally {
			exactUnlinkSpy.mockRestore();
			await broker.stop();
			await fs.rm(replacedSdk, { recursive: true, force: true });
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("records the discovery process incarnation in a newly acquired lock", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-restart-incarnation-"));
		const broker = new Broker({ agentDir: dir });
		try {
			const discovery = await broker.start();
			const owner = JSON.parse(await fs.readFile(path.join(dir, "sdk", "broker.lock", "owner.json"), "utf8")) as {
				ownerId?: unknown;
				pid?: unknown;
				incarnation?: unknown;
			};
			expect(owner).toMatchObject({
				ownerId: discovery.ownerId,
				pid: discovery.pid,
				incarnation: discovery.incarnation,
			});
			expect(owner.incarnation).toBe(brokerProcessIncarnation(process.pid));
		} finally {
			await broker.stop();
		}
	});

	it("keeps canonical lock ownership with the sole simultaneous takeover winner", async () => {
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
			const owners = [a, b].filter(broker => broker.ownsDiscovery);
			expect(owners).toHaveLength(1);
			const [winner] = owners;
			const loser = winner === a ? b : a;
			await loser.stop();
			const owner = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as {
				ownerId?: unknown;
				pid?: unknown;
				incarnation?: unknown;
			};
			expect(owner).toMatchObject({
				ownerId: first.ownerId,
				pid: first.pid,
				incarnation: first.incarnation,
			});
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

	it("drains broker lock and discovery before signal exit", async () => {
		for (const [signal, expectedExitCode] of [
			["SIGTERM", 143],
			["SIGINT", 130],
		] as const) {
			const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-broker-${signal.toLowerCase()}-`));
			const lock = path.join(dir, "sdk", "broker.lock");
			const discovery = path.join(dir, "sdk", "broker.json");
			const child = Bun.spawn(
				[process.execPath, "run", cliEntrypoint, "sdk", "broker-internal", "--agent-dir", dir],
				{
					cwd: path.join(import.meta.dir, ".."),
					env: {
						...process.env,
						GJC_AGENT_DIR: dir,
						GJC_CODING_AGENT_DIR: dir,
					},
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
				},
			);
			try {
				await waitForPath(discovery);
				expect(await pathExists(path.join(lock, "owner.json"))).toBe(true);
				child.kill(signal);
				const exitCode = await Promise.race([
					child.exited,
					Bun.sleep(10_000).then(() => {
						throw new Error(`broker-internal did not exit after ${signal}`);
					}),
				]);
				expect(exitCode).toBe(expectedExitCode);
				expect(await pathExists(lock)).toBe(false);
				expect(await pathExists(discovery)).toBe(false);
			} catch (error) {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
				const stderr = await new Response(child.stderr).text();
				throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		}
	}, 30_000);
});
