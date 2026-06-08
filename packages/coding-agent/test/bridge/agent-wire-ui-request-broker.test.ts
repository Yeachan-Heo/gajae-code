import { describe, expect, it } from "bun:test";
import { UiRequestBroker } from "../../src/modes/shared/agent-wire/ui-request-broker";

type TestRequest = { kind: "select"; title: string };
type TestResponse = { status: "value"; value: string };

const wait = (ms: number) => Bun.sleep(ms);

describe("agent-wire UI request broker", () => {
	it("claims exactly one authoritative controller", () => {
		const broker = new UiRequestBroker<TestRequest, TestResponse>({ emitRequest: () => {} });
		const claimed = broker.claimController();
		expect(claimed.status).toBe("claimed");
		expect(broker.claimController()).toEqual({ status: "busy" });
		if (claimed.status === "claimed") {
			expect(broker.releaseController("wrong-token")).toBe(false);
			expect(broker.releaseController(claimed.ownerToken)).toBe(true);
			expect(broker.claimController().status).toBe("claimed");
		}
	});

	it("emits a correlated request and accepts exactly one controller response", async () => {
		const emitted: Array<{ id: string; request: TestRequest }> = [];
		const broker = new UiRequestBroker<TestRequest, TestResponse>({
			emitRequest: (id, request) => emitted.push({ id, request }),
		});
		const controller = broker.claimController();
		expect(controller.status).toBe("claimed");
		if (controller.status !== "claimed") throw new Error("controller was not claimed");

		const promise = broker.request({ kind: "select", title: "Pick" }, { correlationId: "corr-1" });
		expect(emitted).toEqual([{ id: "corr-1", request: { kind: "select", title: "Pick" } }]);
		expect(broker.respond("corr-1", controller.ownerToken, { status: "value", value: "A" })).toEqual({
			status: "accepted",
		});
		expect(await promise).toEqual({ status: "value", value: "A" });
		expect(broker.respond("corr-1", controller.ownerToken, { status: "value", value: "B" })).toEqual({
			status: "rejected",
			code: "already_resolved",
		});
	});

	it("rejects unauthorized and unknown responses", () => {
		const broker = new UiRequestBroker<TestRequest, TestResponse>({ emitRequest: () => {} });
		const controller = broker.claimController();
		if (controller.status !== "claimed") throw new Error("controller was not claimed");
		void broker.request({ kind: "select", title: "Pick" }, { correlationId: "corr-2" });
		expect(broker.respond("corr-2", "wrong-token", { status: "value", value: "A" })).toEqual({
			status: "rejected",
			code: "not_controller",
		});
		expect(broker.respond("missing", controller.ownerToken, { status: "value", value: "A" })).toEqual({
			status: "rejected",
			code: "unknown_request",
		});
	});

	it("cancels pending requests on timeout, abort, and controller disconnect", async () => {
		const broker = new UiRequestBroker<TestRequest, TestResponse>({ emitRequest: () => {} });
		const controller = broker.claimController();
		if (controller.status !== "claimed") throw new Error("controller was not claimed");

		const timeout = broker.request({ kind: "select", title: "Timeout" }, { correlationId: "timeout", timeoutMs: 1 });
		await wait(5);
		expect(await timeout).toEqual({ status: "cancelled", reason: "timeout" });

		const abortController = new AbortController();
		const aborted = broker.request(
			{ kind: "select", title: "Abort" },
			{ correlationId: "abort", signal: abortController.signal },
		);
		abortController.abort();
		expect(await aborted).toEqual({ status: "cancelled", reason: "abort" });

		const disconnected = broker.request({ kind: "select", title: "Disconnect" }, { correlationId: "disconnect" });
		expect(broker.disconnectController(controller.ownerToken)).toBe(true);
		expect(await disconnected).toEqual({ status: "cancelled", reason: "disconnect" });
		expect(broker.ownerToken).toBeUndefined();
	});
});
