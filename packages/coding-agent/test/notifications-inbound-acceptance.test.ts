import { describe, expect, test } from "bun:test";
import { notificationInboundAdmission } from "../src/sdk/bus/index";
import { inboundReactionAction } from "../src/sdk/bus/telegram-daemon";

describe("notification inbound acceptance and reaction correction", () => {
	test("fenced predecessor and notification-origin policy suspension are explicit drops", () => {
		expect(
			notificationInboundAdmission({
				inboundFenced: true,
				policySuspended: false,
				notificationOrigin: true,
				controlCommand: false,
			}),
		).toEqual({ outcome: "drop", reason: "inbound_fenced" });
		expect(
			notificationInboundAdmission({
				inboundFenced: false,
				policySuspended: true,
				notificationOrigin: true,
				controlCommand: true,
			}),
		).toEqual({ outcome: "defer", reason: "policy_suspended" });
		expect(
			notificationInboundAdmission({
				inboundFenced: false,
				policySuspended: true,
				notificationOrigin: true,
				controlCommand: false,
			}),
		).toEqual({ outcome: "drop", reason: "policy_suspended" });
	});

	test("non-notification clients are not swallowed by provisional notification policy", () => {
		expect(
			notificationInboundAdmission({
				inboundFenced: false,
				policySuspended: true,
				notificationOrigin: false,
				controlCommand: false,
			}),
		).toEqual({ outcome: "accept" });
	});

	test("daemon queues only after acceptance and retracts on rejection or drop", () => {
		expect(inboundReactionAction("accepted", true)).toBe("queued");
		expect(inboundReactionAction("consumed", true)).toBe("consumed");
		expect(inboundReactionAction("rejected", true)).toBe("retract");
		expect(inboundReactionAction("dropped", true)).toBe("retract");
		expect(inboundReactionAction("dropped", false)).toBe("none");
	});
});
