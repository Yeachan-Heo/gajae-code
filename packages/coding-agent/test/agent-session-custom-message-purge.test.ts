import { describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import type { CustomMessage } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

async function createSession() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const agent = new Agent({ initialState: { model, messages: [], tools: [] } });
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return { agent, session };
}

const isTask = (taskId: string) => (m: CustomMessage) =>
	m.customType === "task-notification" && (m.details as { taskId?: string } | undefined)?.taskId === taskId;

describe("AgentSession purgeQueuedCustomMessages", () => {
	it("purges executable followUp and steer queues while preserving unrelated order", async () => {
		const { agent, session } = await createSession();
		agent.steer({
			role: "custom",
			customType: "task-notification",
			content: "drop steer",
			display: false,
			details: { taskId: "bg_1", __pendingDisplayTag: "s1" },
			attribution: "agent",
			timestamp: Date.now(),
		});
		agent.steer({
			role: "custom",
			customType: "task-notification",
			content: "keep steer",
			display: false,
			details: { taskId: "bg_2", __pendingDisplayTag: "s2" },
			attribution: "agent",
			timestamp: Date.now(),
		});
		agent.followUp({
			role: "custom",
			customType: "task-notification",
			content: "drop follow",
			display: false,
			details: { taskId: "bg_1", __pendingDisplayTag: "f1" },
			attribution: "agent",
			timestamp: Date.now(),
		});
		agent.followUp({
			role: "custom",
			customType: "task-notification",
			content: "keep follow",
			display: false,
			details: { taskId: "bg_2", __pendingDisplayTag: "f2" },
			attribution: "agent",
			timestamp: Date.now(),
		});

		const result = session.purgeQueuedCustomMessages(isTask("bg_1"));

		expect(result.agentSteering).toBe(1);
		expect(result.agentFollowUp).toBe(1);
		expect(result.totalExecutable).toBe(2);
		expect(agent.snapshotSteering().map(m => (m as CustomMessage).content)).toEqual(["keep steer"]);
		expect(agent.snapshotFollowUp().map(m => (m as CustomMessage).content)).toEqual(["keep follow"]);
	});

	it("purges pending next-turn messages and leaves non-matching messages intact", async () => {
		const { session } = await createSession();
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "task-notification",
				content: "drop next",
				display: false,
				details: { taskId: "bg_1", __pendingDisplayTag: "n1" },
				attribution: "agent",
				timestamp: Date.now(),
			},
			false,
		);
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "task-notification",
				content: "keep next",
				display: false,
				details: { taskId: "bg_2", __pendingDisplayTag: "n2" },
				attribution: "agent",
				timestamp: Date.now(),
			},
			false,
		);

		const result = session.purgeQueuedCustomMessages(isTask("bg_1"));

		expect(result.pendingNextTurn).toBe(1);
		expect(result.totalExecutable).toBe(1);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("removes tagged display mirrors for purged custom messages", async () => {
		const { agent, session } = await createSession();
		const tag = session.enqueueCustomMessageDisplay("drop notif", "followUp");
		agent.followUp({
			role: "custom",
			customType: "task-notification",
			content: "drop notif",
			display: false,
			details: { taskId: "bg_1", __pendingDisplayTag: tag },
			attribution: "agent",
			timestamp: Date.now(),
		});
		expect(session.getQueuedMessages().followUp).toContain("drop notif");

		const result = session.purgeQueuedCustomMessages(isTask("bg_1"));

		expect(result.agentFollowUp).toBe(1);
		expect(result.displayFollowUp).toBe(1);
		expect(session.getQueuedMessages().followUp).not.toContain("drop notif");
	});
});
