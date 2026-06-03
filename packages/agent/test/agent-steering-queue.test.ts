import { describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe("Agent steering queue introspection", () => {
	it("reports queued steering distinctly from follow-ups", () => {
		const agent = new Agent();
		expect(agent.hasQueuedSteering()).toBe(false);

		agent.followUp(userMessage("follow-up"));
		// A follow-up is queued but must NOT count as steering.
		expect(agent.hasQueuedSteering()).toBe(false);
		expect(agent.hasQueuedMessages()).toBe(true);

		agent.steer(userMessage("steer"));
		expect(agent.hasQueuedSteering()).toBe(true);
	});

	it("snapshots steering without mutating the queue", () => {
		const agent = new Agent();
		agent.steer(userMessage("a"));
		agent.steer(userMessage("b"));

		const snap = agent.snapshotSteering();
		expect(snap).toHaveLength(2);
		// Snapshot does not drain the queue.
		expect(agent.hasQueuedSteering()).toBe(true);
		expect(agent.snapshotSteering()).toHaveLength(2);
	});

	it("restores snapshotted steering ahead of newly queued messages", () => {
		const agent = new Agent();
		agent.steer(userMessage("a"));
		const snap = agent.snapshotSteering();

		// Simulate a maintenance reset that clears the queue.
		agent.clearSteeringQueue();
		expect(agent.hasQueuedSteering()).toBe(false);

		// A message queued after the reset must stay behind the restored ones.
		agent.steer(userMessage("b"));
		agent.restoreSteering(snap);

		const after = agent.snapshotSteering();
		expect(after).toHaveLength(2);
		expect(after[0]).toMatchObject({ content: "a" });
		expect(after[1]).toMatchObject({ content: "b" });
	});

	it("restoreSteering is a no-op for an empty snapshot", () => {
		const agent = new Agent();
		agent.steer(userMessage("b"));
		agent.restoreSteering([]);
		expect(agent.snapshotSteering()).toHaveLength(1);
	});
});
