import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@gajae-code/coding-agent/registry/agent-registry";
import {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
} from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

type SteerDetails = {
	observationId?: string;
	from?: string;
	to?: string;
	body?: string;
	state?: string;
};

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: ["system prompt"],
			messages: [],
			tools: [],
		},
	});
}

function createSession(
	options: { agentId?: string; agentRegistry?: AgentRegistry; sessionManager?: SessionManager } = {},
): AgentSession {
	return new AgentSession({
		agent: createAgent(),
		sessionManager: options.sessionManager ?? SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		agentId: options.agentId,
		agentRegistry: options.agentRegistry,
	} satisfies AgentSessionConfig);
}

describe("AgentSession subagent steer observation", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("emits a UI-only child steer message and relays it to the main session", async () => {
		const registry = new AgentRegistry();
		const mainSessionManager = SessionManager.inMemory();
		const mainSession = createSession({
			agentId: MAIN_AGENT_ID,
			agentRegistry: registry,
			sessionManager: mainSessionManager,
		});
		const childSession = createSession({ agentId: "5-ClusterB", agentRegistry: registry });
		sessions.push(mainSession, childSession);
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: mainSession });
		registry.register({ id: "5-ClusterB", displayName: "ClusterB", kind: "sub", session: childSession });

		const childEvents: AgentSessionEvent[] = [];
		const mainEvents: AgentSessionEvent[] = [];
		childSession.subscribe(event => childEvents.push(event));
		mainSession.subscribe(event => mainEvents.push(event));
		const mainAppendMessageSpy = vi.spyOn(mainSession.agent, "appendMessage");
		const mainAppendCustomSpy = vi.spyOn(mainSessionManager, "appendCustomMessageEntry");
		const mainMessageCount = mainSession.messages.length;

		childSession.emitSubagentSteerObservation({
			from: "0-Main",
			to: "5-ClusterB",
			body: "Please check this.",
			timestamp: 123,
		});

		await new Promise(resolve => setTimeout(resolve, 20));

		const childEvent = childEvents.find(event => event.type === "subagent_steer_message");
		expect(childEvent?.message.customType).toBe("subagent:steer");
		expect(childEvent?.message.details).toMatchObject({
			from: "0-Main",
			to: "5-ClusterB",
			body: "Please check this.",
			state: "queued",
		});
		const observationId = (childEvent?.message.details as SteerDetails | undefined)?.observationId;
		expect(typeof observationId).toBe("string");
		expect(observationId).not.toBe("");

		const relayEvent = mainEvents.find(event => event.type === "subagent_steer_message");
		expect(relayEvent?.message.customType).toBe("subagent:steer:relay");
		expect(relayEvent?.message.details).toMatchObject({
			observationId,
			from: "0-Main",
			to: "5-ClusterB",
			body: "Please check this.",
			state: "queued",
		});
		expect(mainSession.messages).toHaveLength(mainMessageCount);
		expect(mainAppendMessageSpy).not.toHaveBeenCalled();
		expect(mainAppendCustomSpy).not.toHaveBeenCalled();
	});

	it("generates distinct observation ids for separate steer observations", async () => {
		const session = createSession();
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		session.emitSubagentSteerObservation({ from: "0-Main", to: "5-ClusterB", body: "first" });
		session.emitSubagentSteerObservation({ from: "0-Main", to: "5-ClusterB", body: "second" });
		await new Promise(resolve => setTimeout(resolve, 20));

		const ids = events
			.filter(event => event.type === "subagent_steer_message")
			.map(event => (event.message.details as SteerDetails | undefined)?.observationId);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBeString();
		expect(ids[1]).toBeString();
		expect(ids[0]).not.toBe(ids[1]);
	});
});
