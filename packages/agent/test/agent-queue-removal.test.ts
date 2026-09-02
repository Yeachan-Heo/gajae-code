import { describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";

function custom(content: string, taskId: string) {
	return {
		role: "custom" as const,
		customType: "task-notification",
		content,
		display: false,
		details: { taskId },
		attribution: "agent" as const,
		timestamp: Date.now(),
	};
}

function user(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

describe("Agent queue predicate removal", () => {
	it("removeQueuedMessages removes matching steer and follow-up messages while preserving order", () => {
		const agent = new Agent();
		// Seed the queue directly: steer() only admits into a live run.
		agent.restoreSteering([user("keep-steer-1"), custom("drop-steer", "bg_1"), user("keep-steer-2")]);
		agent.followUp(custom("drop-follow", "bg_1"));
		agent.followUp(user("keep-follow-1"));
		agent.followUp(custom("keep-other", "bg_2"));

		const removed = agent.removeQueuedMessages(
			m =>
				m.role === "custom" &&
				m.customType === "task-notification" &&
				(m.details as { taskId?: string } | undefined)?.taskId === "bg_1",
		);

		expect(removed).toEqual({ steering: 1, followUp: 1, total: 2 });
		expect(agent.snapshotSteering().map(m => (m as ReturnType<typeof custom>).content)).toEqual([
			"keep-steer-1",
			"keep-steer-2",
		]);
		expect(agent.snapshotFollowUp().map(m => (m as ReturnType<typeof custom>).content)).toEqual([
			"keep-follow-1",
			"keep-other",
		]);
	});
});
