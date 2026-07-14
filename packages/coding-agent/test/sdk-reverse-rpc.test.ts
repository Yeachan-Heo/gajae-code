import { describe, expect, test } from "bun:test";
import { ReverseLeaseError, ReverseLeaseRuntime } from "../src/sdk/host";

describe("directed reverse RPC leases", () => {
	test("bootstraps atomically, conflicts, reclaims, and hands off", () => {
		let now = 0;
		const installed: string[] = [];
		const removed: string[] = [];
		const runtime = new ReverseLeaseRuntime({
			now: () => now,
			sendFrame: () => {},
			installDefinitions: capability => installed.push(capability),
			onDefinitionsRemoved: capability => removed.push(capability),
		});
		const first = runtime.registerProvider("a", "terminal", { commands: [] }, undefined, "key");
		expect(runtime.registerProvider("a", "terminal", { commands: [] }, undefined, "key").leaseId).toBe(first.leaseId);
		expect(() => runtime.registerProvider("a", "terminal", { ignored: true }, undefined, "key")).toThrow(
			"idempotency_conflict",
		);
		expect(() => runtime.registerProvider("a", "ui", { commands: [] }, undefined, "key")).toThrow(
			"idempotency_conflict",
		);
		expect(installed).toEqual(["terminal"]);
		expect(() => runtime.registerProvider("b", "terminal", {})).toThrow(ReverseLeaseError);
		runtime.disconnect("a");
		now = 1;
		expect(runtime.registerProvider("b", "terminal", {}, first.leaseId).leaseId).toBe(first.leaseId);
		const reclaimed = runtime.getLease("terminal")!;
		runtime.release("b", reclaimed.leaseId, "c");
		expect(runtime.getLease("terminal")).toBeUndefined();
		expect(() => runtime.request("terminal", "run", {})).toThrow("lease_unavailable");
		expect(removed).toEqual(["terminal", "terminal"]);
		expect(() => runtime.registerProvider("c", "terminal", {})).toThrow("provider_lease_conflict");
		const handedOff = runtime.registerProvider(
			"c",
			"terminal",
			{ commands: [{ name: "replacement" }] },
			reclaimed.leaseId,
		);
		expect(handedOff).toMatchObject({
			leaseId: reclaimed.leaseId,
			connectionId: "c",
			active: true,
			definitions: { commands: [{ name: "replacement" }] },
		});
		runtime.release("c", handedOff.leaseId, "d");
		now += 15_000;
		expect(() => runtime.request("terminal", "run", {})).toThrow("provider_required");
		expect(runtime.registerProvider("d", "terminal", {}).leaseId).not.toBe(handedOff.leaseId);
		expect(() => runtime.release("b", reclaimed.leaseId)).toThrow("not_lease_owner");
	});

	test("directs responses to lease owner and cancels on disconnect", async () => {
		const sent: Array<{ connectionId: string; frame: Record<string, unknown> }> = [];
		const cancelled: string[] = [];
		const runtime = new ReverseLeaseRuntime({
			sendFrame: (connectionId, frame) => {
				sent.push({ connectionId, frame });
			},
			onCancel: requestId => cancelled.push(requestId),
		});
		runtime.registerProvider("owner", "ui", {});
		const pending = runtime.request("ui", "select", { options: ["yes"] });
		const requestId = String(sent[0].frame.id);
		const leaseId = runtime.getLease("ui")!.leaseId;
		expect(sent[0].connectionId).toBe("owner");
		expect(sent[0].frame).toMatchObject({
			type: "reverse_request",
			id: requestId,
			connectionId: "owner",
			leaseId,
			payload: { method: "select", payload: { options: ["yes"] } },
		});
		expect(() => runtime.respond("other", requestId, leaseId, {})).toThrow("not_lease_owner");
		runtime.respond("owner", requestId, leaseId, { selected: "yes" });
		await expect(pending).resolves.toEqual({ selected: "yes" });
		const cancelledRequest = runtime.request("ui", "select", {});
		runtime.disconnect("owner");
		await expect(cancelledRequest).rejects.toThrow("request_cancelled");
		expect(cancelled).toHaveLength(1);
	});

	test("dispose rejects pending requests and clears reverse lease state", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const removed: string[] = [];
		const cancelled: string[] = [];
		const runtime = new ReverseLeaseRuntime({
			sendFrame: (_connectionId, frame) => {
				sent.push(frame);
			},
			onDefinitionsRemoved: capability => {
				removed.push(capability);
			},
			onCancel: requestId => {
				cancelled.push(requestId);
			},
		});
		runtime.registerProvider("owner", "permission", [{ name: "request" }], undefined, "first");
		const pending = runtime.request("permission", "request", { toolCallId: "call-1" });
		const requestId = String(sent[0].id);
		runtime.dispose();
		await expect(pending).rejects.toThrow("request_cancelled");
		expect(cancelled).toEqual([requestId]);
		expect(removed).toEqual(["permission"]);
		expect(runtime.getLease("permission")).toBeUndefined();
		expect(runtime.getInstalledDefinitions("permission")).toBeUndefined();
		expect(() => runtime.request("permission", "request", {})).toThrow("provider_required");
		expect(runtime.registerProvider("next", "permission", [], undefined, "first").connectionId).toBe("next");
		runtime.dispose();
	});

	test("dispose remains atomic when external cleanup hooks throw", async () => {
		let requestId = "";
		const reentryErrors: string[] = [];
		let runtime!: ReverseLeaseRuntime;
		runtime = new ReverseLeaseRuntime({
			sendFrame: (_connectionId, frame) => {
				requestId = String(frame.id);
			},
			onDefinitionsRemoved: () => {
				try {
					runtime.registerProvider("reentrant", "permission", []);
				} catch (error) {
					reentryErrors.push(String(error));
				}
				throw new Error("definition cleanup failed");
			},
			onCancel: () => {
				try {
					runtime.request("permission", "request", {});
				} catch (error) {
					reentryErrors.push(String(error));
				}
				throw new Error("cancel hook failed");
			},
		});
		runtime.registerProvider("owner", "permission", [{ name: "request" }], undefined, "key");
		const pending = runtime.request("permission", "request", {});
		expect(() => runtime.dispose()).not.toThrow();
		await expect(pending).rejects.toThrow("request_cancelled");
		expect(runtime.getLease("permission")).toBeUndefined();
		expect(runtime.getInstalledDefinitions("permission")).toBeUndefined();
		expect(() => runtime.respond("owner", requestId, "missing", {})).toThrow("unknown_request");
		expect(reentryErrors).toHaveLength(2);
		expect(reentryErrors.every(error => error.includes("reverse runtime is disposing"))).toBe(true);
		expect(runtime.registerProvider("next", "permission", [], undefined, "key").connectionId).toBe("next");
		runtime.dispose();
	});

	test("synchronous reverse send failures remove the pending request", async () => {
		let requestId = "";
		const runtime = new ReverseLeaseRuntime({
			sendFrame: (_connectionId, frame) => {
				requestId = String(frame.id);
				throw new Error("send failed");
			},
		});
		const lease = runtime.registerProvider("owner", "ui", {});
		await expect(runtime.request("ui", "select", {})).rejects.toThrow("send failed");
		expect(() => runtime.respond("owner", requestId, lease.leaseId, {})).toThrow("unknown_request");
		runtime.dispose();
	});

	test("accepts structured error responses without a result payload", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const runtime = new ReverseLeaseRuntime({
			sendFrame: (_connectionId, frame) => {
				sent.push(frame);
			},
		});
		runtime.registerProvider("owner", "ui", {});
		const pending = runtime.request("ui", "select", {});
		runtime.respond("owner", String(sent[0].id), String(sent[0].leaseId), undefined, {
			code: "lease_expired",
			message: "Lease expired.",
		});
		await expect(pending).rejects.toThrow("Lease expired.");
	});

	test("single winner wins a two-client bootstrap race", () => {
		const runtime = new ReverseLeaseRuntime({ sendFrame: () => {} });
		const winner = runtime.registerProvider("one", "filesystem", {});
		expect(winner.connectionId).toBe("one");
		expect(() => runtime.registerProvider("two", "filesystem", {})).toThrow("provider_lease_conflict");
	});

	test("expires installed definitions without a subsequent lease operation", async () => {
		const removed: string[] = [];
		const runtime = new ReverseLeaseRuntime({
			leaseTtlMs: 30,
			sendFrame: () => {},
			onDefinitionsRemoved: capability => removed.push(capability),
		});
		const lease = runtime.registerProvider("owner", "ui", [{ name: "select" }]);
		expect(runtime.getInstalledDefinitions("ui")).toEqual([{ name: "select" }]);
		await Bun.sleep(60);
		expect(runtime.getInstalledDefinitions("ui")).toBeUndefined();
		expect(removed).toEqual(["ui"]);
		// A post-expiry heartbeat must not revive the lease or its definitions.
		expect(() => runtime.heartbeat("owner", lease.leaseId)).toThrow("lease_expired");
		expect(runtime.getInstalledDefinitions("ui")).toBeUndefined();
		// A new provider can acquire the expired capability.
		const replacement = runtime.registerProvider("next", "ui", [{ name: "confirm" }]);
		expect(replacement.connectionId).toBe("next");
		expect(runtime.getInstalledDefinitions("ui")).toEqual([{ name: "confirm" }]);
		runtime.dispose();
	});
});
