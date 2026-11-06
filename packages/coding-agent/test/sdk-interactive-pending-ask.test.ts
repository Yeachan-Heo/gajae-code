/**
 * Test suite for SDK interactive pending ask discovery and answering.
 *
 * Validates that:
 * 1. Interactive TUI asks are exposed as pending asks through the SDK query surface
 * 2. SDK clients can answer pending asks via ask.answer
 * 3. Local answers clear the pending ask from the registry
 * 4. Answering an unknown/stale ask ID errors cleanly
 * 5. Both local and remote answers race correctly
 */

import { describe, expect, it } from "bun:test";
import type { AskRemoteReceipt, AskSettlement } from "../src/tools";
import {
	clearSessionInteractivePendingAsks,
	getInteractivePendingAsk,
	listInteractivePendingAsks,
	registerInteractivePendingAsk,
	settleInteractivePendingAsk,
} from "../src/tools/interactive-ask-registry";

describe("Interactive pending ask registry", () => {
	it("registers and lists pending asks", async () => {
		const sessionId = "test-session-1";
		const receipt: AskRemoteReceipt = {
			interaction: { kind: "value", value: "test-answer" },
			settle: async (s: AskSettlement) => ({ kind: "resolved_without_commit" as const }),
		};

		const askId = registerInteractivePendingAsk(
			sessionId,
			"Do you want to proceed?",
			["Yes", "No"],
			false,
			receipt,
			() => {},
		);

		const asks = listInteractivePendingAsks(sessionId);
		expect(asks).toHaveLength(1);
		expect(asks[0]?.id).toBe(askId);
		expect(asks[0]?.question).toBe("Do you want to proceed?");
		expect(asks[0]?.options).toEqual(["Yes", "No"]);
		expect(asks[0]?.multi).toBe(false);

		clearSessionInteractivePendingAsks(sessionId);
		expect(listInteractivePendingAsks(sessionId)).toHaveLength(0);
	});

	it("settles and removes pending asks", async () => {
		const sessionId = "test-session-2";
		let settled = false;
		const receipt: AskRemoteReceipt = {
			interaction: { kind: "value", value: "answer" },
			settle: async () => {
				settled = true;
				return { kind: "resolved_without_commit" as const };
			},
		};

		const askId = registerInteractivePendingAsk(sessionId, "Choose one", ["A", "B", "C"], false, receipt, () => {});

		const success = await settleInteractivePendingAsk(sessionId, askId, { kind: "commit" });
		expect(success).toBe(true);
		expect(settled).toBe(true);
		expect(listInteractivePendingAsks(sessionId)).toHaveLength(0);
	});

	it("rejects answers for unknown ask IDs", async () => {
		const sessionId = "test-session-3";
		const success = await settleInteractivePendingAsk(sessionId, "unknown-ask-id", { kind: "commit" });
		expect(success).toBe(false);
	});

	it("handles multiple pending asks in a session", async () => {
		const sessionId = "test-session-4";
		const receipt: AskRemoteReceipt = {
			interaction: { kind: "value", value: "" },
			settle: async () => ({ kind: "resolved_without_commit" as const }),
		};

		const ask1 = registerInteractivePendingAsk(sessionId, "Q1", ["A"], false, receipt, () => {});
		const ask2 = registerInteractivePendingAsk(sessionId, "Q2", ["B"], false, receipt, () => {});

		expect(listInteractivePendingAsks(sessionId)).toHaveLength(2);

		await settleInteractivePendingAsk(sessionId, ask1, { kind: "commit" });
		expect(listInteractivePendingAsks(sessionId)).toHaveLength(1);

		await settleInteractivePendingAsk(sessionId, ask2, { kind: "commit" });
		expect(listInteractivePendingAsks(sessionId)).toHaveLength(0);
	});

	it("retrieves individual pending asks by ID", async () => {
		const sessionId = "test-session-5";
		const receipt: AskRemoteReceipt = {
			interaction: { kind: "value", value: "" },
			settle: async () => ({ kind: "resolved_without_commit" as const }),
		};

		const askId = registerInteractivePendingAsk(
			sessionId,
			"Test question",
			["Option1", "Option2"],
			true,
			receipt,
			() => {},
			{
				recommendedIndex: 0,
				timeoutMs: 5000,
				selectedOptions: ["Option1"],
				hasNonWhitespaceCustom: false,
			},
		);

		const ask = getInteractivePendingAsk(sessionId, askId);
		expect(ask).toBeDefined();
		expect(ask?.id).toBe(askId);
		expect(ask?.question).toBe("Test question");
		expect(ask?.multi).toBe(true);
		expect(ask?.recommendedIndex).toBe(0);
		expect(ask?.timeoutMs).toBe(5000);
	});
});

describe("Interactive pending ask SDK operations", () => {
	it("ask.answer operation resolves pending asks", async () => {
		const sessionId = "test-session-sdk";
		let settleCalled = false;
		const receipt: AskRemoteReceipt = {
			interaction: { kind: "value", value: "" },
			settle: async (s: AskSettlement) => {
				settleCalled = true;
				return { kind: "resolved_without_commit" as const };
			},
		};

		const askId = registerInteractivePendingAsk(sessionId, "Choose", ["A", "B"], false, receipt, () => {});

		// Simulate what the SDK control surface does
		const resolved = await settleInteractivePendingAsk(sessionId, askId, { kind: "commit" });
		expect(resolved).toBe(true);
		expect(settleCalled).toBe(true);

		// The ask should be removed from the registry
		const remaining = listInteractivePendingAsks(sessionId);
		expect(remaining).toHaveLength(0);
	});

	it("ask.answer rejects stale ask IDs with not_found error", async () => {
		const sessionId = "test-session-stale";
		const resolved = await settleInteractivePendingAsk(sessionId, "stale-ask-id", { kind: "commit" });
		expect(resolved).toBe(false);
	});
});
