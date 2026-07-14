import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { Settings } from "../src/config/settings";
import {
	BrokerWorkflowGateEmitter,
	FileGateStore,
	type OpenGateInput,
	type WorkflowGateEmitter,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { SessionManager } from "../src/session/session-manager";
import { registerWorkflowGateEmitterListener } from "../src/tools/ask-answer-registry";

/**
 * The SDK-built ToolSession must forward getWorkflowGateEmitter from AgentSession
 * so the real ask tool can emit SDK workflow gates in headless sessions.
 */
describe("SDK ToolSession forwards getWorkflowGateEmitter", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	it("makes the real ask tool emit a workflow_gate when an emitter is attached to the session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		try {
			const received: OpenGateInput[] = [];
			let publishedEmitter: WorkflowGateEmitter | undefined;
			const disposeEmitterListener = registerWorkflowGateEmitterListener(session.sessionId, emitter => {
				publishedEmitter = emitter;
			});
			const emitter: WorkflowGateEmitter = {
				isUnattended: () => true,
				emitGate: input => {
					received.push(input);
					return Promise.resolve({ selected: ["JWT"], other: false });
				},
			};
			session.setWorkflowGateEmitter(emitter);
			expect(publishedEmitter).toBe(emitter);
			disposeEmitterListener();
			expect(session.getWorkflowGateEmitter()).toBe(emitter);

			const askTool = session.getToolByName("ask");
			expect(askTool).toBeDefined();

			const ctx = {
				hasUI: false,
				abort: () => {},
			} as unknown as AgentToolContext;

			const result = await askTool!.execute(
				"call-1",
				{ questions: [{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "OAuth2" }] }] },
				undefined,
				undefined,
				ctx,
			);
			// The real SDK toolSession forwarded the emitter -> the ask tool emitted a gate.
			expect(received).toHaveLength(1);
			expect(received[0].stage).toBe("deep-interview");
			expect(JSON.stringify(result.details)).toContain("JWT");
		} finally {
			await session.dispose();
		}
	}, 15_000);
	it("late-registers ask when a headless session receives a workflow gate emitter", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-headless-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		try {
			expect(session.getWorkflowGateEmitter()).toBeDefined();
			await Bun.sleep(0);
			expect(session.getToolByName("ask")).toBeDefined();

			const received: OpenGateInput[] = [];
			const emitter: WorkflowGateEmitter = {
				isUnattended: () => true,
				emitGate: input => {
					received.push(input);
					return Promise.resolve({ selected: ["JWT"], other: false });
				},
			};
			session.setWorkflowGateEmitter(emitter);

			expect(session.getWorkflowGateEmitter()).toBe(emitter);
			const askTool = session.getToolByName("ask");
			expect(askTool).toBeDefined();
			expect(session.getActiveToolNames()).toContain("ask");

			const ctx = {
				hasUI: false,
				abort: () => {},
			} as unknown as AgentToolContext;

			const result = await askTool!.execute(
				"call-headless",
				{ questions: [{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "OAuth2" }] }] },
				undefined,
				undefined,
				ctx,
			);

			expect(received).toHaveLength(1);
			expect(received[0].options).toEqual([
				{ value: "JWT", label: "JWT", description: undefined },
				{ value: "OAuth2", label: "OAuth2", description: undefined },
			]);
			expect(JSON.stringify(result.details)).toContain("JWT");
		} finally {
			await session.dispose();
		}
	}, 15_000);
	it("provides a durable SDK-native emitter without extension injection", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-production-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		try {
			const emitter = session.getWorkflowGateEmitter();
			expect(emitter).toBeDefined();
			await Bun.sleep(0);
			expect(session.getToolByName("ask")).toBeDefined();
			let gate: { gate_id: string } | undefined;
			const dispose = emitter!.onGateEmitted!(emitted => {
				gate = emitted;
			});
			const ask = session.getToolByName("ask")!;
			const result = ask.execute(
				"production-gate",
				{ questions: [{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "OAuth2" }] }] },
				undefined,
				undefined,
				{ hasUI: false, abort: () => {} } as unknown as AgentToolContext,
			);
			for (let i = 0; i < 20 && !gate; i += 1) await Bun.sleep(1);
			expect(gate).toBeDefined();
			const response = {
				gate_id: gate!.gate_id,
				answer: { selected: ["JWT"], other: false },
				idempotency_key: "sdk-answer",
			};
			expect(await emitter!.resolveGate!(response)).toMatchObject({ status: "accepted" });
			expect(await emitter!.resolveGate!(response)).toMatchObject({ status: "accepted" });
			expect(JSON.stringify((await result).details)).toContain("JWT");
			dispose();
		} finally {
			await session.dispose();
		}
	});

	it("replays durable pending gates to a host attached after restart", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-restart-"));
		tempDirs.push(tempDir);
		const store = path.join(tempDir, "workflow-gates.json");
		const first = new BrokerWorkflowGateEmitter("durable-session", new FileGateStore(store));
		void first.emitGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		const restarted = new BrokerWorkflowGateEmitter("durable-session", new FileGateStore(store));
		const replayed: string[] = [];
		restarted.onGateEmitted!(gate => replayed.push(gate.gate_id));
		expect(restarted.listPendingGates!()).toHaveLength(1);
		expect(replayed).toEqual(restarted.listPendingGates!().map(gate => gate.gate_id));
	});
});
