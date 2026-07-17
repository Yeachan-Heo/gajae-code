import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { Settings } from "../src/config/settings";
import { sessionStateDir } from "../src/gjc-runtime/session-layout";
import {
	BrokerWorkflowGateEmitter,
	FileGateStore,
	type OpenGateInput,
	type WorkflowGateEmitter,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { initTheme } from "../src/modes/theme/theme";
import { SessionManager } from "../src/session/session-manager";
import { registerWorkflowGateEmitterListener } from "../src/tools/ask-answer-registry";

function attachTerminalController(emitter: WorkflowGateEmitter): void {
	emitter.registerGateTerminalController?.({
		completeGateInteractions: () => "already_terminal",
		cancelGateInteractions: () => {},
	});
}

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
		await initTheme(false);
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
			attachTerminalController(emitter!);
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
	it("keeps in-memory gates ephemeral while persistent sessions use the durable store", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-store-boundary-"));
		tempDirs.push(tempDir);

		const { session: inMemorySession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		const inMemoryGatePath = path.join(sessionStateDir(tempDir, inMemorySession.sessionId), "workflow-gates.json");
		try {
			expect(fs.existsSync(inMemoryGatePath)).toBe(false);
		} finally {
			await inMemorySession.dispose();
		}

		const persistentManager = SessionManager.create(tempDir, tempDir);
		const { session: persistentSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: persistentManager,
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			hasUI: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		const persistentGatePath = path.join(
			sessionStateDir(tempDir, persistentSession.sessionId),
			"workflow-gates.json",
		);
		try {
			expect(fs.existsSync(persistentGatePath)).toBe(true);
		} finally {
			await persistentSession.dispose();
		}
	});
	// Real persisted-session rotation performs disk load, emitter fencing, and authority reminting; keep a local budget without weakening the suite default.
	it("fences old workflow gates and remints authority after a session switch", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-session-switch-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const targetSessionManager = SessionManager.create(tempDir, tempDir);
		await targetSessionManager.ensureOnDisk();
		const targetSessionFile = targetSessionManager.getSessionFile();
		await targetSessionManager.close();
		if (!targetSessionFile) throw new Error("Expected persisted successor session");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
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
			const previousSessionId = session.sessionId;
			const previousEmitter = session.getWorkflowGateEmitter()!;
			let oldGate: { gate_id: string } | undefined;
			previousEmitter.onGateEmitted!(gate => {
				oldGate = gate;
			});
			const oldContinuation = previousEmitter.emitGate({
				stage: "ralplan",
				kind: "approval",
				schema: { type: "string", enum: ["approve"] },
			});
			// Keep the fenced continuation handled while the switch rotates authority.
			void oldContinuation.catch(() => {});
			await Promise.resolve();
			expect(oldGate).toBeDefined();

			let oldEndpointEmitter: WorkflowGateEmitter | undefined = previousEmitter;
			const stopListening = registerWorkflowGateEmitterListener(previousSessionId, emitter => {
				oldEndpointEmitter = emitter;
			});
			expect(await session.switchSession(targetSessionFile)).toBe(true);
			stopListening();

			const successorEmitter = session.getWorkflowGateEmitter()!;
			expect(session.sessionId).not.toBe(previousSessionId);
			expect(successorEmitter).not.toBe(previousEmitter);
			expect(oldEndpointEmitter).toBeUndefined();
			expect(previousEmitter.listPendingGates!()).toEqual([]);
			await expect(oldContinuation).rejects.toThrow("continuation was fenced");
			await expect(
				successorEmitter.resolveGate!({ gate_id: oldGate!.gate_id, answer: "approve", idempotency_key: "old" }),
			).rejects.toThrow("no live pending gate");

			let successorGate: { gate_id: string } | undefined;
			successorEmitter.onGateEmitted!(gate => {
				successorGate = gate;
			});
			const successorContinuation = successorEmitter.emitGate({
				stage: "ralplan",
				kind: "approval",
				schema: { type: "string", enum: ["approve"] },
			});
			await Promise.resolve();
			expect(successorGate).toBeDefined();
			expect(successorGate!.gate_id).not.toBe(oldGate!.gate_id);
			expect(
				await successorEmitter.resolveGate!({
					gate_id: successorGate!.gate_id,
					answer: "approve",
					idempotency_key: "successor",
				}),
			).toMatchObject({ status: "accepted" });
			await expect(successorContinuation).resolves.toBe("approve");
		} finally {
			await session.dispose();
		}
	}, 15_000);
	it("restores suspended predecessor gate authority when a session switch rolls back", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-switch-rollback-"));
		tempDirs.push(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, tempDir),
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
			const emitter = session.getWorkflowGateEmitter()!;
			attachTerminalController(emitter);
			let gate: { gate_id: string } | undefined;
			emitter.onGateEmitted!(emitted => {
				gate = emitted;
			});
			const continuation = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
			await Promise.resolve();
			await expect(session.switchSession(tempDir)).rejects.toThrow();
			expect(session.getWorkflowGateEmitter()).toBe(emitter);
			expect(emitter.listPendingGates!()).toMatchObject([{ gate_id: gate!.gate_id }]);
			await expect(emitter.resolveGate!({ gate_id: gate!.gate_id, answer: "approve" })).resolves.toMatchObject({
				status: "accepted",
			});
			await expect(continuation).resolves.toBe("approve");
		} finally {
			await session.dispose();
		}
	});

	it("fences accepted-unadvanced gates and settles every shutdown waiter", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-fence-"));
		tempDirs.push(tempDir);
		const emitter = new BrokerWorkflowGateEmitter(
			"emitter-fence",
			new FileGateStore(path.join(tempDir, "gates.json")),
			{
				advance: () => {
					throw new Error("advance interrupted");
				},
			},
		);
		let gate: { gate_id: string } | undefined;
		emitter.onGateEmitted!(emitted => {
			gate = emitted;
		});
		const acceptedUnadvanced = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		emitter.registerGateTerminalController({
			completeGateInteractions: () => "already_terminal",
			cancelGateInteractions: () => {},
		});
		void acceptedUnadvanced.catch(() => {});
		await expect(emitter.resolveGate({ gate_id: gate!.gate_id, answer: "approve" })).rejects.toThrow(
			"advance interrupted",
		);
		const pending = emitter.emitGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		void pending.catch(() => {});
		emitter.fence();
		await expect(acceptedUnadvanced).rejects.toThrow("continuation was fenced");
		await expect(pending).rejects.toThrow("continuation was fenced");
		expect(emitter.listPendingGates()).toEqual([]);
		expect(await emitter.recoverAcceptedGates()).toEqual([]);
		await expect(
			emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } }),
		).rejects.toThrow("unavailable");
	});
	it("recovers an accepted same-process gate through the emitter recovery hook", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-recovery-"));
		tempDirs.push(tempDir);
		let failAdvance = true;
		const store = new FileGateStore(path.join(tempDir, "recovery.json"));
		const emitter = new BrokerWorkflowGateEmitter("emitter-recovery", store, {
			advance: () => {
				if (failAdvance) throw new Error("temporary advance failure");
			},
		});
		const terminalized: string[] = [];
		emitter.registerGateTerminalController!({
			completeGateInteractions: gateId => {
				expect(store.get(gateId)).toMatchObject({ status: "accepted", advanced: false });
				terminalized.push(gateId);
				return "retired";
			},
			cancelGateInteractions: () => {},
		});
		let gate: { gate_id: string } | undefined;
		emitter.onGateEmitted!(emitted => {
			if (!gate) gate = emitted;
		});
		const pending = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		await expect(
			emitter.resolveGate({ gate_id: gate!.gate_id, answer: "approve", idempotency_key: "recovery" }),
		).rejects.toThrow("temporary advance failure");
		const queued = emitter.emitGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		void queued.catch(() => {});
		expect(terminalized).toEqual([gate!.gate_id]);
		failAdvance = false;
		expect(await emitter.recoverAcceptedGates()).toEqual([gate!.gate_id]);
		expect(terminalized).toEqual([gate!.gate_id]);
		await expect(pending).resolves.toBe("approve");
		expect(emitter.listPendingGates()).toHaveLength(1);
	});
	it("quarantines a terminalization failure before advancement and settles its presentation waiter", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-terminalization-failure-"));
		tempDirs.push(tempDir);
		const store = new FileGateStore(path.join(tempDir, "gates.json"));
		let advances = 0;
		let terminalizations = 0;
		const cancelled: string[] = [];
		const emitted: string[] = [];
		const emitter = new BrokerWorkflowGateEmitter("emitter-terminalization-failure", store, {
			advance: () => {
				advances++;
			},
		});
		emitter.onGateEmitted!(gate => emitted.push(gate.gate_id));
		let gate: { gate_id: string } | undefined;
		emitter.onGateEmitted!(emittedGate => {
			gate = emittedGate;
		});
		emitter.registerGateTerminalController!({
			completeGateInteractions: () => {
				terminalizations++;
				throw new Error("presentation terminalization interrupted");
			},
			cancelGateInteractions: gateId => {
				cancelled.push(gateId);
			},
		});
		const continuation = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		void continuation.catch(() => {});
		await expect(emitter.resolveGate({ gate_id: gate!.gate_id, answer: "approve" })).rejects.toThrow(
			"presentation terminalization interrupted",
		);
		await expect(continuation).rejects.toThrow("continuation was fenced");
		expect(terminalizations).toBe(1);
		expect(cancelled).toEqual([gate!.gate_id]);
		expect(advances).toBe(0);
		expect(emitted).toEqual([gate!.gate_id]);
		expect(emitter.listPendingGates()).toEqual([]);
		expect(store.get(gate!.gate_id)).toMatchObject({
			status: "quarantined",
			advanced: false,
			lifecycle: { reason: "continuation_owner_lost" },
		});
	});
	it("rejects the original waiter when an uncertain accepted write quarantines its continuation", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-uncertain-waiter-"));
		tempDirs.push(tempDir);
		let syncs = 0;
		const store = new FileGateStore(path.join(tempDir, "gates.json"), () => {
			syncs++;
			if (syncs === 8) throw new Error("parent fsync failed after accepted rename");
		});
		const emitter = new BrokerWorkflowGateEmitter("emitter-uncertain-waiter", store, { advance: () => {} });
		let gate: { gate_id: string } | undefined;
		emitter.onGateEmitted!(emitted => {
			gate = emitted;
		});
		const continuation = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		let settlements = 0;
		void continuation.then(
			() => {
				settlements++;
			},
			() => {
				settlements++;
			},
		);

		await expect(emitter.resolveGate!({ gate_id: gate!.gate_id, answer: "approve" })).rejects.toMatchObject({
			certainty: "uncertain",
		});
		await expect(continuation).rejects.toThrow("continuation was fenced");
		expect(settlements).toBe(1);
		expect(emitter.listPendingGates!()).toEqual([]);
		expect(store.get(gate!.gate_id)).toMatchObject({
			status: "quarantined",
			lifecycle: { reason: "continuation_owner_lost" },
		});
	});
	it("quarantines instead of advancing when no terminal controller is attached", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-no-terminal-controller-"));
		tempDirs.push(tempDir);
		const store = new FileGateStore(path.join(tempDir, "gates.json"));
		let advances = 0;
		const emitter = new BrokerWorkflowGateEmitter("emitter-no-terminal-controller", store, {
			advance: () => {
				advances++;
			},
		});
		let gate: { gate_id: string } | undefined;
		emitter.onGateEmitted!(emitted => {
			gate = emitted;
		});
		const continuation = emitter.emitGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		void continuation.catch(() => {});
		await expect(emitter.resolveGate({ gate_id: gate!.gate_id, answer: "approve" })).rejects.toThrow(
			"has no terminal controller",
		);
		await expect(continuation).rejects.toThrow("continuation was fenced");
		expect(advances).toBe(0);
		expect(store.get(gate!.gate_id)).toMatchObject({ status: "quarantined", advanced: false });
	});

	it("cancels the bounded recovery grace timer when the emitter is fenced", () => {
		vi.useFakeTimers();
		try {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-recovery-dispose-"));
			tempDirs.push(tempDir);
			const emitter = new BrokerWorkflowGateEmitter(
				"emitter-recovery-dispose",
				new FileGateStore(path.join(tempDir, "gates.json")),
			);

			emitter.setAckRecoveryParticipant!(null);
			expect(vi.getTimerCount()).toBe(1);
			emitter.fence();
			expect(vi.getTimerCount()).toBe(0);
			emitter.setAckRecoveryParticipant!(null);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it("quarantines restart records instead of replaying them to listeners", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-g011-restart-"));
		tempDirs.push(tempDir);
		const store = path.join(tempDir, "workflow-gates.json");
		const first = new BrokerWorkflowGateEmitter("durable-session", new FileGateStore(store));
		void first.emitGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		const restarted = new BrokerWorkflowGateEmitter("durable-session", new FileGateStore(store));
		const replayed: string[] = [];
		restarted.onGateEmitted!(gate => replayed.push(gate.gate_id));
		expect(restarted.listPendingGates!()).toEqual([]);
		expect(replayed).toEqual([]);
		expect(restarted.listGateDiagnostics!()).toMatchObject([
			{ tag: "quarantined", lifecycle: { reason: "orphaned_after_process_restart" } },
		]);
		expect(restarted.listWorkflowGateQueryRecords!()).toMatchObject([
			{ id: expect.stringMatching(/^diagnostic:/), tag: "quarantined" },
		]);
	});
});
