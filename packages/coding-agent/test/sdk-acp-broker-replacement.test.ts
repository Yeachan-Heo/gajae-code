import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { readSdkBrokerDiscovery } from "../src/sdk/client";

describe("ACP broker replacement reconnection", () => {
	it("re-discovers broker endpoint after broker replacement instead of reconnecting to dead broker", async () => {
		const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-acp-broker-replace-"));

		// Start first broker
		const broker1 = new Broker({ agentDir: dir });
		const discovery1 = await broker1.start();
		const url1 = discovery1.url;
		const token1 = discovery1.token;

		// Record the initial discovery
		const initial = await readSdkBrokerDiscovery(dir);
		expect(initial?.url).toBe(url1);
		expect(initial?.token).toBe(token1);

		// Stop first broker
		await broker1.stop();

		// Start second broker (should get a different port and token)
		const broker2 = new Broker({ agentDir: dir });
		const discovery2 = await broker2.start();
		const url2 = discovery2.url;
		const token2 = discovery2.token;

		// Verify that broker endpoint changed
		expect(url2).not.toBe(url1);
		expect(token2).not.toBe(token1);

		// Record the new discovery
		const updated = await readSdkBrokerDiscovery(dir);
		expect(updated?.url).toBe(url2);
		expect(updated?.token).toBe(token2);

		await broker2.stop();
	});
});
