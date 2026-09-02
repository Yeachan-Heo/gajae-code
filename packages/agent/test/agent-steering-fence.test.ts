import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { z } from "@gajae-code/ai";
import { createMockModel, type MockModel } from "@gajae-code/ai/providers/mock";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

interface Harness {
	agent: Agent;
	mock: MockModel;
	entered: Promise<void>;
	release: () => void;
	entered2: Promise<void>;
	release2: () => void;
}

/**
 * A run that parks inside a tool call, which is where the loop actually polls
 * steering. A no-tool run never reaches that poll, so it cannot exercise the
 * fence at all.
 */
function harness(): Harness {
	const enteredGate = Promise.withResolvers<void>();
	const releaseGate = Promise.withResolvers<void>();
	const enteredGate2 = Promise.withResolvers<void>();
	const releaseGate2 = Promise.withResolvers<void>();
	let entries = 0;
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Parks until released",
		parameters: z.object({}),
		execute: async () => {
			entries += 1;
			if (entries === 1) {
				enteredGate.resolve();
				await releaseGate.promise;
			} else {
				enteredGate2.resolve();
				await releaseGate2.promise;
			}
			return { content: [{ type: "text", text: "done" }] };
		},
	};
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "wait", arguments: {} }] },
			{ content: ["after tool"] },
			{ content: [{ type: "toolCall", name: "wait", arguments: {} }] },
		],
		handler: { content: ["reply"] },
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools: [waitTool], messages: [] },
		streamFn: mock.stream,
	});
	return {
		agent,
		mock,
		entered: enteredGate.promise,
		release: () => releaseGate.resolve(),
		entered2: enteredGate2.promise,
		release2: () => releaseGate2.resolve(),
	};
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
	// fenced the poll must yield nothing AND dequeue nothing, so the message is
	// neither consumed by the run being wound down nor lost: the terminal disowns
	// it to the owner (the session holds it for the wake turn).
	it("neither consumes nor loses steering queued during a tool call while fenced", async () => {
		const h = harness();
		h.agent.setSteeringAdmissionFence(() => true);
		const disowned: string[] = [];
		h.agent.subscribe(event => {
			if (event.type === "agent_end")
				for (const message of event.disownedSteering ?? []) disowned.push(String(message.content));
		});
		const run = h.agent.prompt("run tool");
		await h.entered;
		expect(h.agent.steer(userMessage("handle this instead")).admitted).toBe(true);
		h.release();
		await run;

		// Not consumed by the winding-down run, and handed to the owner intact.
		expect(disowned).toEqual(["handle this instead"]);
		// The Agent never keeps an ended run's steering: ownership is the owner's.
		expect(h.agent.hasQueuedSteering()).toBe(false);
	});

	// Rollback releases the fence, which must make steering admissible again
	// rather than fencing every later turn.
	it("admits steering again once the fence is released", async () => {
		const h = harness();
		let fenced = true;
		h.agent.setSteeringAdmissionFence(() => fenced);
		const run = h.agent.prompt("run tool");
		await h.entered;
		const preserved = userMessage("handle this instead");
		expect(h.agent.steer(preserved).admitted).toBe(true);
		h.release();
		await run;
		expect(h.agent.hasQueuedSteering()).toBe(false);

		fenced = false;
		// The owner re-admits the preserved message into a fresh live run; with the
		// fence released the loop consumes it instead of yielding nothing.
		const next = h.agent.prompt("next");
		await h.entered2;
		expect(h.agent.steer(preserved).admitted).toBe(true);
		h.release2();
		await next;
		expect(h.agent.hasQueuedSteering()).toBe(false);
		expect(h.mock.calls.some(call => JSON.stringify(call.context.messages).includes("handle this instead"))).toBe(
			true,
		);
	});
});
