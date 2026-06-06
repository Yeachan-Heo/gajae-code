import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { WorkflowGateEmitter } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-session";
import type { OpenGateInput } from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";

/**
 * G011: when an unattended workflow-gate emitter is attached to the session, the
 * ask tool emits a workflow_gate (answered over RPC) instead of using the
 * interactive UI. This proves the deep-interview question path routes through the
 * gate contract end-to-end.
 */

function createContext(): AgentToolContext {
	let selectCalls = 0;
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => {
				selectCalls += 1;
				return undefined;
			},
			editor: async () => undefined,
		},
		abort: () => {},
		_selectCalls: () => selectCalls,
	} as unknown as AgentToolContext & { _selectCalls: () => number };
	return ctx;
}

class StubEmitter implements WorkflowGateEmitter {
	readonly received: OpenGateInput[] = [];
	constructor(private readonly answerFor: (input: OpenGateInput) => unknown) {}
	isUnattended(): boolean {
		return true;
	}
	emitGate(input: OpenGateInput): Promise<unknown> {
		this.received.push(input);
		return Promise.resolve(this.answerFor(input));
	}
}

function createSession(emitter: WorkflowGateEmitter | undefined): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getWorkflowGateEmitter: () => emitter,
	} as unknown as ToolSession;
}

describe("ask tool unattended gate emission (G011)", () => {
	it("emits a deep-interview question gate and decodes the answer instead of using the UI", async () => {
		const emitter = new StubEmitter(() => ({ selected: ["OAuth2"], other: false }));
		const tool = new AskTool(createSession(emitter));
		const ctx = createContext() as AgentToolContext & { _selectCalls: () => number };

		const result = await tool.execute(
			"call-1",
			{ questions: [{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "OAuth2" }] }] },
			undefined,
			undefined,
			ctx,
		);

		// The gate was emitted (deep-interview stage), not the interactive UI.
		expect(emitter.received).toHaveLength(1);
		expect(emitter.received[0].stage).toBe("deep-interview");
		expect(emitter.received[0].kind).toBe("question");
		expect(ctx._selectCalls()).toBe(0);
		// The decoded answer is surfaced as the tool result.
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(JSON.stringify(result.details)).toContain("OAuth2");
	});

	it("handles a free-text (Other) gate answer", async () => {
		const emitter = new StubEmitter(() => ({ selected: [], other: true, custom: "Passkeys" }));
		const tool = new AskTool(createSession(emitter));
		const result = await tool.execute(
			"call-2",
			{ questions: [{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }] }] },
			undefined,
			undefined,
			createContext(),
		);
		expect(JSON.stringify(result.details)).toContain("Passkeys");
	});

	it("does not emit a gate when the emitter reports attended mode (isUnattended false)", async () => {
		const received: OpenGateInput[] = [];
		const attendedEmitter: WorkflowGateEmitter = {
			isUnattended: () => false,
			emitGate: input => {
				received.push(input);
				return Promise.resolve({});
			},
		};
		const tool = new AskTool(createSession(attendedEmitter));
		await tool
			.execute(
				"call-3",
				{ questions: [{ id: "q", question: "pick", options: [{ label: "A" }] }] },
				undefined,
				undefined,
				createContext(),
			)
			.catch(() => {});
		// The attended guard prevents gate emission; the interactive path is used instead.
		expect(received).toHaveLength(0);
	});
});
