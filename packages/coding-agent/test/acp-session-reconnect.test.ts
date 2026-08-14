import { expect, test } from "bun:test";
import { ACP_SESSION_RECONNECT, AcpSdkAdapter } from "../src/sdk/acp";
import { HEARTBEAT_TTL_MS } from "../src/sdk/bus/daemon-paths";
import { drainReconnects, expectedBackoffs, FakeWebSocket, withFakeTransport } from "./helpers/fake-sdk-transport";

test("ACP session reconnect budget outlives the host heartbeat TTL", () => {
	const backoffs = expectedBackoffs(ACP_SESSION_RECONNECT);
	const totalBudgetMs = backoffs.reduce((total, backoff) => total + backoff, 0);
	// The host drops a session whose client has not ponged within HEARTBEAT_TTL_MS,
	// so a shorter client budget makes every host-reaped stall unrecoverable.
	expect(totalBudgetMs).toBeGreaterThan(HEARTBEAT_TTL_MS);
	// Recovery must stay prompt: no single sleep may swallow the whole TTL.
	expect(Math.max(...backoffs)).toBe(ACP_SESSION_RECONNECT.reconnectMaxBackoffMs);
	expect(ACP_SESSION_RECONNECT.reconnectMaxBackoffMs).toBeLessThan(HEARTBEAT_TTL_MS);
});

test("AcpSdkAdapter constructor path gives its SdkClient the ACP reconnect budget", async () => {
	await withFakeTransport(async clock => {
		const adapter = new AcpSdkAdapter({ url: "ws://acp.test", token: "token" });
		const starting = adapter.start();
		const observed = await drainReconnects(clock);
		await expect(starting).rejects.toMatchObject({ code: "reconnect_exhausted" });
		expect(observed).toEqual(expectedBackoffs(ACP_SESSION_RECONNECT));
		expect(FakeWebSocket.instances).toHaveLength(ACP_SESSION_RECONNECT.reconnectAttempts + 1);
		await adapter.close();
	});
});

test("AcpSdkAdapter.connect gives its SdkClient the ACP reconnect budget", async () => {
	await withFakeTransport(async clock => {
		const connecting = AcpSdkAdapter.connect({ url: "ws://acp.test", token: "token" });
		const observed = await drainReconnects(clock);
		await expect(connecting).rejects.toMatchObject({ code: "reconnect_exhausted" });
		expect(observed).toEqual(expectedBackoffs(ACP_SESSION_RECONNECT));
		expect(FakeWebSocket.instances).toHaveLength(ACP_SESSION_RECONNECT.reconnectAttempts + 1);
	});
});
