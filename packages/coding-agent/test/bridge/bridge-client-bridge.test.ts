import { describe, expect, it } from "bun:test";
import {
	type BridgePermissionRequestPayload,
	createBridgeClientBridge,
} from "../../src/modes/bridge/bridge-client-bridge";
import { UiRequestBroker } from "../../src/modes/shared/agent-wire/ui-request-broker";
import type { ClientBridgePermissionOutcome } from "../../src/session/client-bridge";

describe("BridgeClientBridge", () => {
	it("routes requestPermission through the UI request broker", async () => {
		const emitted: Array<{ id: string; request: BridgePermissionRequestPayload }> = [];
		const broker = new UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>({
			emitRequest: (id, request) => emitted.push({ id, request }),
		});
		const controller = broker.claimController();
		if (controller.status !== "claimed") throw new Error("controller was not claimed");
		const bridge = createBridgeClientBridge(broker);

		const promise = bridge.requestPermission?.({ toolCallId: "tool-1", toolName: "bash", title: "Run bash" }, [
			{ optionId: "allow", name: "Allow once", kind: "allow_once" },
		]);
		expect(promise).toBeDefined();
		expect(emitted).toEqual([
			{
				id: "tool-1",
				request: {
					kind: "permission",
					toolCall: { toolCallId: "tool-1", toolName: "bash", title: "Run bash" },
					options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
				},
			},
		]);
		expect(
			broker.respond("tool-1", controller.ownerToken, {
				outcome: "selected",
				optionId: "allow",
				kind: "allow_once",
			}),
		).toEqual({
			status: "accepted",
		});
		expect(await promise).toEqual({ outcome: "selected", optionId: "allow", kind: "allow_once" });
	});

	it("converts broker cancellation to ClientBridge cancellation", async () => {
		const broker = new UiRequestBroker<BridgePermissionRequestPayload, ClientBridgePermissionOutcome>({
			emitRequest: () => {},
		});
		const bridge = createBridgeClientBridge(broker);
		const promise = bridge.requestPermission?.({ toolCallId: "tool-2", toolName: "edit", title: "Edit file" }, [
			{ optionId: "reject", name: "Reject", kind: "reject_once" },
		]);
		broker.cancel("tool-2", "timeout");
		expect(await promise).toEqual({ outcome: "cancelled" });
	});
});
