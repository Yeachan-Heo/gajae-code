import { expect, test } from "bun:test";
import { NotificationServer } from "../../natives/native/index.js";
import { SessionSdkHost } from "../src/sdk/host";

const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
};

test("reverse transport keeps typed lease frames isolated across reconnect and handoff", async () => {
	const server = new NotificationServer(`reverse-${Date.now()}`, "token", `/tmp/reverse-${Date.now()}`, true);
	const installedDefinitions = new Map<string, unknown>();
	let onFrame: ((connectionId: string, frame: Record<string, unknown>) => void) | undefined;
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
		onProviderDefinitionsRemoved: capability => installedDefinitions.delete(capability),
	});
	server.onSdkFrame((_error, event) => {
		if (!event) return;
		onFrame?.(event.connectionId, JSON.parse(event.json) as Record<string, unknown>);
	});
	server.onConnectionClose((_error, connectionId) => {
		if (connectionId) host.handleDisconnect(connectionId);
	});
	await host.start();
	const endpoint = await server.start();
	const messagesA: Record<string, unknown>[] = [];
	const messagesB: Record<string, unknown>[] = [];
	const connect = async (messages: Record<string, unknown>[]) => {
		const ws = new WebSocket(`${endpoint.url}/?token=token`);
		ws.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("WS error")), { once: true });
		});
		return ws;
	};
	const a = await connect(messagesA);
	const b = await connect(messagesB);
	let reclaimedA: WebSocket | undefined;
	try {
		const aHello = await waitFor(() => messagesA.find(frame => frame.type === "hello"), "A hello");
		const bHello = await waitFor(() => messagesB.find(frame => frame.type === "hello"), "B hello");
		const aConnectionId = String(aHello.connectionId);
		const bConnectionId = String(bHello.connectionId);
		a.send(
			JSON.stringify({
				type: "register_provider",
				id: "register-a",
				connectionId: aConnectionId,
				capability: "ui",
				definitions: [{ name: "select" }],
			}),
		);
		const registeredA = await waitFor(
			() => messagesA.find(frame => frame.type === "register_provider_result"),
			"A provider registration",
		);
		const leaseId = String(registeredA.leaseId);
		expect(leaseId).toEqual(expect.any(String));
		expect(messagesB.some(frame => frame.type === "register_provider_result")).toBe(false);

		a.send(JSON.stringify({ type: "provider_heartbeat", connectionId: aConnectionId, leaseId }));
		await waitFor(
			() =>
				messagesA.find(frame => frame.type === "lease_state" && frame.leaseId === leaseId && frame.active === true),
			"A heartbeat acknowledgement",
		);
		expect(messagesB.some(frame => frame.type === "lease_state")).toBe(false);

		const pending = host.reverse.request("ui", "select", { options: ["yes"] });
		const reverse = await waitFor(
			() => messagesA.find(frame => frame.type === "reverse_request"),
			"directed reverse request",
		);
		expect(reverse).toMatchObject({
			connectionId: aConnectionId,
			leaseId,
			payload: { method: "select", payload: { options: ["yes"] } },
		});
		expect(messagesB.some(frame => frame.type === "reverse_request")).toBe(false);
		a.send(
			JSON.stringify({
				type: "reverse_response",
				id: reverse.id,
				connectionId: aConnectionId,
				leaseId,
				ok: true,
				result: { selected: "yes" },
			}),
		);
		await expect(pending).resolves.toEqual({ selected: "yes" });

		const closed = new Promise<void>(resolve => a.addEventListener("close", () => resolve(), { once: true }));
		a.close();
		await closed;
		await Bun.sleep(25);
		const messagesReclaimedA: Record<string, unknown>[] = [];
		reclaimedA = await connect(messagesReclaimedA);
		const reclaimedHello = await waitFor(
			() => messagesReclaimedA.find(frame => frame.type === "hello"),
			"reconnected A hello",
		);
		const reclaimedConnectionId = String(reclaimedHello.connectionId);
		reclaimedA.send(
			JSON.stringify({
				type: "register_provider",
				id: "reclaim-a",
				connectionId: reclaimedConnectionId,
				capability: "ui",
				definitions: [{ name: "select" }],
				expectedLeaseId: leaseId,
			}),
		);
		const reclaimed = await waitFor(
			() => messagesReclaimedA.find(frame => frame.type === "register_provider_result"),
			"reclaimed provider registration",
		);
		expect(reclaimed.leaseId).toBe(leaseId);
		expect(messagesB.some(frame => frame.type === "register_provider_result")).toBe(false);

		reclaimedA.send(
			JSON.stringify({
				type: "lease_release",
				connectionId: reclaimedConnectionId,
				leaseId,
				handoffTo: bConnectionId,
			}),
		);
		await waitFor(
			() =>
				messagesReclaimedA.find(
					frame => frame.type === "lease_state" && frame.connectionId === bConnectionId && frame.active === false,
				),
			"inactive handoff acknowledgement",
		);
		expect(() => host.reverse.request("ui", "select", { options: ["no"] })).toThrow("lease_unavailable");
		b.send(
			JSON.stringify({
				type: "register_provider",
				id: "register-b-without-lease",
				connectionId: bConnectionId,
				capability: "ui",
				definitions: [{ name: "select-replacement" }],
			}),
		);
		const rejectedB = await waitFor(
			() => messagesB.find(frame => frame.type === "reverse_response" && frame.id === "register-b-without-lease"),
			"B handoff registration rejection",
		);
		expect(rejectedB).toMatchObject({ ok: false, error: { code: "provider_lease_conflict" } });
		b.send(
			JSON.stringify({
				type: "register_provider",
				id: "register-b",
				connectionId: bConnectionId,
				capability: "ui",
				definitions: [{ name: "select-replacement" }],
				expectedLeaseId: leaseId,
			}),
		);
		const registeredB = await waitFor(
			() => messagesB.find(frame => frame.type === "register_provider_result"),
			"B provider registration after handoff",
		);
		expect(registeredB).toMatchObject({ leaseId, registeredNames: ["select-replacement"] });
		expect(installedDefinitions.get("ui")).toEqual([{ name: "select-replacement" }]);
		expect(host.getProviderDefinitions("ui")).toEqual([{ name: "select-replacement" }]);
		const pendingB = host.reverse.request("ui", "select-replacement", { options: ["maybe"] });
		const reverseB = await waitFor(
			() => messagesB.find(frame => frame.type === "reverse_request" && frame.connectionId === bConnectionId),
			"replacement directed reverse request",
		);
		expect(reverseB).toMatchObject({
			leaseId,
			payload: { method: "select-replacement", payload: { options: ["maybe"] } },
		});
		b.send(
			JSON.stringify({
				type: "reverse_response",
				id: reverseB.id,
				connectionId: bConnectionId,
				leaseId,
				ok: true,
				result: { selected: "maybe" },
			}),
		);
		await expect(pendingB).resolves.toEqual({ selected: "maybe" });
		b.send(JSON.stringify({ type: "lease_release", connectionId: bConnectionId, leaseId }));
		await waitFor(
			() =>
				messagesB.find(frame => frame.type === "lease_state" && frame.leaseId === leaseId && frame.active === true),
			"B release acknowledgement",
		);
		expect(installedDefinitions.has("ui")).toBe(false);
		expect(host.getProviderDefinitions("ui")).toBeUndefined();
	} finally {
		a.close();
		reclaimedA?.close();
		b.close();
		server.stop();
		await host.stop();
	}
});
