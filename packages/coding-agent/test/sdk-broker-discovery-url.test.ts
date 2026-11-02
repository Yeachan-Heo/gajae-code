import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { readBrokerDiscovery, writeBrokerDiscovery } from "../src/sdk/broker/discovery";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-discovery-url-"));
	tempDirs.push(dir);
	return dir;
}

function discoveryRecord(port: number, url: string) {
	return {
		version: 1 as const,
		protocolVersion: 3 as const,
		packageGeneration: "test",
		ownerId: "x",
		pid: process.pid,
		host: "127.0.0.1" as const,
		port,
		url,
		token: "secret",
		startedAt: 1,
		heartbeatAt: Date.now(),
	};
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("readBrokerDiscovery url", () => {
	it("rejects a link-local url on an otherwise loopback discovery record", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(80, "ws://169.254.169.254:80"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("rejects a private url on an otherwise loopback discovery record", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(9, "ws://10.0.0.8:9"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("rejects a localhost discovery url", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(1, "ws://localhost:1"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("rejects an ipv6 loopback discovery url", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(1, "ws://[::1]:1"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("rejects a discovery url whose port disagrees with the record", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(80, "ws://127.0.0.1:443"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("rejects an uppercase scheme on a loopback discovery url", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(80, "WS://127.0.0.1:80"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("rejects a trailing dot on the loopback discovery host", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(80, "ws://127.0.0.1.:80"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("rejects surrounding whitespace on a loopback discovery url", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(1, " ws://127.0.0.1:1"));
		expect(await readBrokerDiscovery(dir)).toBeNull();
	});

	it("still allows the publisher loopback url on port 80", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(80, "ws://127.0.0.1:80"));
		expect((await readBrokerDiscovery(dir))?.url).toBe("ws://127.0.0.1:80");
	});

	it("still allows a trailing slash on the owned loopback url", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(80, "ws://127.0.0.1:80/"));
		expect((await readBrokerDiscovery(dir))?.url).toBe("ws://127.0.0.1:80/");
	});

	it("still allows the highest tcp port on the owned loopback url", async () => {
		const dir = await makeTempDir();
		await writeBrokerDiscovery(dir, discoveryRecord(65_535, "ws://127.0.0.1:65535"));
		expect((await readBrokerDiscovery(dir))?.port).toBe(65_535);
	});

	it("rejects non-loopback discovery urls for generated ports", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 1, max: 65_535 }), fc.boolean(), async (port, slash) => {
				const owned = `ws://127.0.0.1:${port}${slash ? "/" : ""}`;
				const allowed = await makeTempDir();
				await writeBrokerDiscovery(allowed, discoveryRecord(port, owned));
				expect((await readBrokerDiscovery(allowed))?.url).toBe(owned);
				const blocked = await makeTempDir();
				await writeBrokerDiscovery(blocked, discoveryRecord(port, `ws://10.0.0.1:${port}`));
				expect(await readBrokerDiscovery(blocked)).toBeNull();
			}),
			{ seed: 221045417, numRuns: 64 },
		);
	});
});
