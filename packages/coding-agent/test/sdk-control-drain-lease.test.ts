import { expect, test } from "bun:test";
import {
	isNativeControlDrainAvailable,
	runIdentityControlSuccessPath,
	type TerminalSendOutcome,
} from "../src/sdk/bus/control-drain-lease";

test("identity control terminal path waits for successor before sending and stopping predecessor", async () => {
	const order: string[] = [];
	const outcome = await runIdentityControlSuccessPath({
		fence: () => {
			order.push("fence");
		},
		ensurePredecessorSendCapable: () => {
			order.push("send-capable");
		},
		startSuccessor: async () => {
			order.push("start");
		},
		sendTerminal: async () => {
			order.push("terminal");
			return "written";
		},
		stopPredecessor: async () => {
			order.push("stop");
		},
	});

	expect(outcome).toBe("written");
	expect(order).toEqual(["fence", "send-capable", "start", "terminal", "stop"]);
});

test("identity control terminal path releases predecessor after a failed terminal write", async () => {
	const order: string[] = [];
	const outcome = await runIdentityControlSuccessPath({
		fence: () => {
			order.push("fence");
		},
		startSuccessor: async () => {
			order.push("start");
		},
		sendTerminal: async (): Promise<TerminalSendOutcome> => {
			order.push("terminal");
			return "write_failed";
		},
		stopPredecessor: async () => {
			order.push("stop");
		},
	});

	expect(outcome).toBe("write_failed");
	expect(order).toEqual(["fence", "start", "terminal", "stop"]);
});

test("identity control terminal path fails closed when detach is required without a native lease", async () => {
	const order: string[] = [];
	if (isNativeControlDrainAvailable()) return;
	await expect(
		runIdentityControlSuccessPath({
			fence: () => {
				order.push("fence");
			},
			startSuccessor: async () => {
				order.push("start");
			},
			sendTerminal: async () => "written",
			stopPredecessor: async () => {
				order.push("stop");
			},
			requireNativeControlDrain: true,
		}),
	).rejects.toThrow("native control-drain lease");
	expect(order).toEqual([]);
});
