import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

interface Harness {
	agent: Agent;
	mock: ReturnType<typeof createMockModel>;
	entered: Promise<void>;
	release: () => void;
}

/**
 * A run that parks inside a tool call, which is where the loop actually polls
 * steering. A no-tool run never reaches that poll, so it cannot exercise the
 * fence at all.
 */
function harness(): Harness {
	const enteredGate = Promise.withResolvers<void>();
	const releaseGate = Promise.withResolvers<void>();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Parks until released",
		parameters: z.object({}),
		execute: async () => {
			enteredGate.resolve();
			await releaseGate.promise;
			return { content: [{ type: "text", text: "done" }] };
		},
	};
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "wait", arguments: {} }] },
			{ content: ["after tool"] },
			{ content: ["steered"] },
		],
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools: [waitTool], messages: [] },
		streamFn: mock.stream,
	});
	return { agent, mock, entered: enteredGate.promise, release: () => releaseGate.resolve() };
}

describe("Agent steering admission fence", () => {
	// Baseline first: prove the poll really does admit steering here, so the
	// fenced case below cannot pass merely because nothing was ever polled.
	it("admits steering queued during a tool call when no fence is installed", async () => {
		const h = harness();
		const run = h.agent.prompt("run tool");
		await h.entered;
		h.agent.steer(userMessage("handle this instead"));
		h.release();
		await run;

		expect(h.agent.hasQueuedSteering()).toBe(false);
	});

	// A fold arms the fence synchronously before awaiting the receipt capture,
	// because the loop polls steering upstream of its pause checkpoint. While
	// fenced the poll must yield nothing AND dequeue nothing.
	it("neither consumes nor loses steering queued during a tool call while fenced", async () => {
		const h = harness();
		h.agent.setSteeringAdmissionFence(() => true);
		const run = h.agent.prompt("run tool");
		await h.entered;
		h.agent.steer(userMessage("handle this instead"));
		h.release();
		await run;

		// Preserved intact rather than consumed by the run being wound down.
		expect(h.agent.hasQueuedSteering()).toBe(true);
		expect(h.agent.snapshotSteering()).toMatchObject([{ content: "handle this instead" }]);
	});

	// Rollback releases the fence, which must make the preserved steer admissible
	// again rather than stranding it forever.
	it("admits the preserved steering once the fence is released", async () => {
		const h = harness();
		let fenced = true;
		h.agent.setSteeringAdmissionFence(() => fenced);
		const run = h.agent.prompt("run tool");
		await h.entered;
		h.agent.steer(userMessage("handle this instead"));
		h.release();
		await run;
		expect(h.agent.hasQueuedSteering()).toBe(true);

		fenced = false;
		await h.agent.prompt("next");
		expect(h.agent.hasQueuedSteering()).toBe(false);
	});
});
