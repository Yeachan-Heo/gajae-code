import { expect, test } from "bun:test";
import { NotificationServer } from "../../natives/native/index.js";
import { AcpSdkAdapter } from "../src/sdk/acp";
import { SessionSdkHost } from "../src/sdk/host";

const waitFor = async <T>(read: () => T | undefined): Promise<T> => {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for a WebSocket frame");
};

test("SDK-RPC-provider-conflict: real ACP clients race atomically for one provider lease", async () => {
	const server = new NotificationServer(`acp-race-${Date.now()}`, "token", `/tmp/acp-race-${Date.now()}`, true);
	let onFrame: ((connectionId: string, frame: Record<string, unknown>) => void) | undefined;
	const installedDefinitions = new Map<string, unknown>();

	const host = new SessionSdkHost({
		sessionId: "s",
		stateRoot: "/tmp",
		token: "token",
		sendFrame: (connectionId, frame) => server.sendTo(connectionId, JSON.stringify(frame)),
		onFrame: handler => {
			onFrame = handler;
			return () => {
				onFrame = undefined;
			};
		},
		installProviderDefinitions: (capability, definitions) => installedDefinitions.set(capability, definitions),
	});
	server.onSdkFrame((_error, event) => {
		if (event) onFrame?.(event.connectionId, JSON.parse(event.json) as Record<string, unknown>);
	});
	server.onConnectionClose((_error, connectionId) => {
		if (connectionId) host.handleDisconnect(connectionId);
	});
	await host.start();
	const endpoint = await server.start();
	const winnerProvider = { capability: "ui", definitions: [{ name: "winner-select" }] };
	const loserProvider = { capability: "ui", definitions: [{ name: "loser-select" }] };
	const winner = new AcpSdkAdapter({ url: endpoint.url, token: "token", providers: [winnerProvider] });
	const loser = new AcpSdkAdapter({ url: endpoint.url, token: "token", providers: [loserProvider] });

	try {
		const settled = await Promise.allSettled([winner.start(), loser.start()]);
		expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const rejected = settled.find(result => result.status === "rejected");
		expect(rejected).toMatchObject({ status: "rejected", reason: { code: "provider_lease_conflict" } });
		const winningProvider = settled[0].status === "fulfilled" ? winnerProvider : loserProvider;
		expect(winner.leaseIds.get("ui") ?? loser.leaseIds.get("ui")).toEqual(expect.any(String));
		await waitFor(() => host.getProviderDefinitions("ui"));
		expect(installedDefinitions.get("ui")).toEqual(winningProvider.definitions);
		expect(host.getProviderDefinitions("ui")).toEqual(winningProvider.definitions);
	} finally {
		await winner.close();
		await loser.close();
		server.stop();
		await host.stop();
	}
});
