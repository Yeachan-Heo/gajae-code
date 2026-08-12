import { describe, expect, test } from "bun:test";
import { createKindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import {
	createPromptDeadlineLease,
	isAttributableProgressEventType,
	promptDeadlineAt,
	recordAttributableProgress,
} from "../src/sdk/prompt-deadline-lease";
import { PromptDeadlineManager } from "../src/sdk/prompt-deadline-manager";

describe("prompt-deadline-lease", () => {
	test("deadline is min of lease window and hard cap", () => {
		const lease = createPromptDeadlineLease({ now: 0, leaseMs: 1_800_000, maxMs: 21_600_000 });
		expect(promptDeadlineAt(lease)).toBe(1_800_000);
		recordAttributableProgress(lease, 1_000_000);
		expect(promptDeadlineAt(lease)).toBe(2_800_000);
		// Hard cap still binds
		recordAttributableProgress(lease, 20_000_000);
		expect(promptDeadlineAt(lease)).toBe(21_600_000);
	});

	test("monotonic: stale progress does not move backwards", () => {
		const lease = createPromptDeadlineLease({ now: 1_000, leaseMs: 1_800_000, maxMs: 21_600_000 });
		recordAttributableProgress(lease, 5_000);
		expect(lease.lastProgressAt).toBe(5_000);
		recordAttributableProgress(lease, 3_000);
		expect(lease.lastProgressAt).toBe(5_000);
	});

	test("only tool execution boundaries are attributable", () => {
		expect(isAttributableProgressEventType("tool_execution_start")).toBe(true);
		expect(isAttributableProgressEventType("tool_execution_end")).toBe(true);
		expect(isAttributableProgressEventType("tool_execution_update")).toBe(false);
		expect(isAttributableProgressEventType("message_update")).toBe(false);
		expect(isAttributableProgressEventType("agent_start")).toBe(false);
		expect(isAttributableProgressEventType("heartbeat")).toBe(false);
	});
});

describe("PromptDeadlineManager", () => {
	test("renewal extends deadline up to hard cap; non-attributable does not", async () => {
		let now = 0;
		const reconciliation = createKindAwareReconciliation({ now: () => now });
		const manager = new PromptDeadlineManager({
			reconciliation,
			getLeaseMs: () => 1_800_000,
			getMaxMs: () => 21_600_000,
			now: () => now,
		});
		const correlation = { commandId: "c1", turnId: "t1" };
		manager.onAccepted(correlation);
		expect(manager.deadlineAt(correlation)).toBe(1_800_000);

		now = 1_000_000;
		manager.onAttributableEvent(correlation, "tool_execution_start", now);
		expect(manager.deadlineAt(correlation)).toBe(2_800_000);

		// Streaming chatter must not renew
		manager.onAttributableEvent(correlation, "message_update", now + 500);
		expect(manager.deadlineAt(correlation)).toBe(2_800_000);

		// Unrelated correlation must not renew
		const other = { commandId: "c2", turnId: "t2" };
		expect(manager.has(other)).toBe(false);
	});

	test("hard cap: repeated progress never exceeds acceptedAt+maxMs", async () => {
		let now = 0;
		const reconciliation = createKindAwareReconciliation({ now: () => now });
		const manager = new PromptDeadlineManager({
			reconciliation,
			getLeaseMs: () => 1_800_000,
			getMaxMs: () => 3_600_000,
			now: () => now,
		});
		const correlation = { commandId: "c1", turnId: "t1" };
		manager.onAccepted(correlation);
		for (let i = 0; i < 10; i++) {
			now += 1_700_000;
			manager.onAttributableEvent(correlation, "tool_execution_end", now);
		}
		expect(manager.deadlineAt(correlation)).toBe(3_600_000);
	});

	test("clear removes lease so unrelated activity cannot revive it", async () => {
		const now = 0;
		const reconciliation = createKindAwareReconciliation({ now: () => now });
		const manager = new PromptDeadlineManager({
			reconciliation,
			getLeaseMs: () => 1_800_000,
			getMaxMs: () => 21_600_000,
			now: () => now,
		});
		const correlation = { commandId: "c1", turnId: "t1" };
		manager.onAccepted(correlation);
		manager.clear(correlation);
		expect(manager.has(correlation)).toBe(false);
		manager.onAttributableEvent(correlation, "tool_execution_start", 100);
		expect(manager.has(correlation)).toBe(false);
	});
});
