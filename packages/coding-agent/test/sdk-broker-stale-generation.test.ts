import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { Broker, resolveBrokerPackageGeneration } from "../src/sdk/broker/broker";
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { brokerOwnerIdentityMatchesForTest, ensureBroker } from "../src/sdk/broker/ensure";
import { observeProcessIncarnation } from "../src/sdk/broker/process-incarnation";
import { SdkClient } from "../src/sdk/client/client";

const currentGeneration = (packageJson as { version: string }).version;

async function shutdownPublishedBroker(agentDir: string): Promise<void> {
	const discovery = await readBrokerDiscovery(agentDir);
	if (!discovery) return;
	const client = await SdkClient.connect(discovery.url, discovery.token, { timeoutMs: 2_000 });
	try {
		await client.global("broker.shutdown", {});
	} finally {
		await client.close().catch(() => undefined);
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (discovery.pid === process.pid) {
			const current = await readBrokerDiscovery(agentDir);
			if (!current || current.ownerId !== discovery.ownerId) return;
		} else {
			const observation = observeProcessIncarnation(discovery.pid);
			if (
				observation.status === "absent" ||
				(observation.status === "present" && observation.incarnation !== discovery.incarnation)
			)
				return;
		}
		await Bun.sleep(20);
	}
	throw new Error(`Broker ${discovery.pid} did not exit after authenticated test cleanup.`);
}

describe("sdk broker stale-generation fence (#5227)", () => {
	test("stale retirement requires the exact broker process incarnation", () => {
		const stale = {
			ownerId: "stale-owner",
			pid: 4242,
			incarnation: "linux:old",
		} satisfies Pick<BrokerDiscovery, "ownerId" | "pid" | "incarnation">;

		expect(brokerOwnerIdentityMatchesForTest(stale, stale)).toBe(true);
		expect(brokerOwnerIdentityMatchesForTest({ ...stale, incarnation: "linux:new" }, stale)).toBe(false);
		expect(brokerOwnerIdentityMatchesForTest({ ...stale, pid: 4243 }, stale)).toBe(false);
		expect(brokerOwnerIdentityMatchesForTest({ ...stale, ownerId: "replacement-owner" }, stale)).toBe(false);
	});

	test("broker publishes current package generation, never unknown", async () => {
		const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-gen-"));
		const broker = new Broker({ agentDir });
		try {
			const discovery = await broker.start();
			expect(discovery.packageGeneration).toBe(currentGeneration);
			expect(discovery.packageGeneration).not.toBe("unknown");
			expect(resolveBrokerPackageGeneration()).toBe(currentGeneration);
		} finally {
			await broker.stop().catch(() => {});
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("ensureBroker replaces a stale-generation broker exactly once (owner-fenced)", async () => {
		const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-stale-"));
		// Start a broker that claims to be old generation "unknown"
		const staleBroker = new Broker({ agentDir, packageGeneration: "unknown" });
		let staleDiscovery: BrokerDiscovery;
		try {
			staleDiscovery = await staleBroker.start();
			expect(staleDiscovery.packageGeneration).toBe("unknown");

			// Concurrent ensureBroker callers must not spawn two replacements
			const results = await Promise.all([ensureBroker({ agentDir }), ensureBroker({ agentDir })]);
			expect(results[0].packageGeneration).toBe(currentGeneration);
			expect(results[1].packageGeneration).toBe(currentGeneration);
			expect(results[0].pid).toBe(results[1].pid);
			expect(results[0].ownerId).toBe(results[1].ownerId);
			// Must be a different owner than the stale broker
			expect(results[0].ownerId).not.toBe(staleDiscovery.ownerId);

			// Stale ownership must be gone after the authenticated shutdown request.
			await Bun.sleep(500);
			const after = await readBrokerDiscovery(agentDir);
			expect(after).not.toBeNull();
			expect(after!.packageGeneration).toBe(currentGeneration);
			expect(after!.ownerId).not.toBe(staleDiscovery.ownerId);
		} finally {
			await staleBroker.stop().catch(() => {});
			await shutdownPublishedBroker(agentDir);
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("ensureBroker replaces explicit old generation (0.15.0) with current", async () => {
		const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-oldgen-"));
		const staleBroker = new Broker({ agentDir, packageGeneration: "0.15.0" });
		try {
			const stale = await staleBroker.start();
			expect(stale.packageGeneration).toBe("0.15.0");
			const fresh = await ensureBroker({ agentDir });
			expect(fresh.packageGeneration).toBe(currentGeneration);
			expect(fresh.ownerId).not.toBe(stale.ownerId);
			await Bun.sleep(300);
		} finally {
			await staleBroker.stop().catch(() => {});
			await shutdownPublishedBroker(agentDir);
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("ensureBroker reuses compatible generation without replacement", async () => {
		const agentDir = await fs.mkdtemp(path.join(import.meta.dir, "../.tmp-compat-"));
		const broker = new Broker({ agentDir, packageGeneration: currentGeneration });
		try {
			const first = await broker.start();
			const reused = await ensureBroker({ agentDir });
			expect(reused.ownerId).toBe(first.ownerId);
			expect(reused.pid).toBe(first.pid);
		} finally {
			await broker.stop().catch(() => {});
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
