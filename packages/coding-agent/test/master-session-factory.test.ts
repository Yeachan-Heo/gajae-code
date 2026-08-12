import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai/core";
import { ModelRegistry } from "../src/config/model-registry";
import type { MasterCoordinatorGateway } from "../src/master/coordinator-gateway";
import type { MasterDomainStore } from "../src/master/domain-store";
import { createDeterministicMemoryContract } from "../src/master/memory-contract";
import { MasterSessionFactory } from "../src/master/session-factory";
import { MASTER_ORCHESTRATION_TOOL_NAMES } from "../src/master/tools";
import { coordinatorTurnObservation, MasterWorkerObserver } from "../src/master/worker-observer";
import type { CreateAgentSessionResult } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";

function fakeDomainStore(masterName: string, masterRootDir: string): MasterDomainStore {
	return {
		masterName,
		masterRootDir,
		readQueue: async () => ({ masterName, tasks: [] }),
		enqueue: async () => ({ taskId: "task-1", enqueueSeq: 1, state: "queued", idempotent: false }),
		assignWorker: async () => ({
			leaseId: "lease-1",
			taskId: "task-1",
			workerSessionId: "worker-1",
			attempt: 1,
			state: "leased",
			idempotent: false,
		}),
	} as unknown as MasterDomainStore;
}

function fakeCoordinatorGateway(): MasterCoordinatorGateway {
	return {} as MasterCoordinatorGateway;
}

describe("MasterSessionFactory", () => {
	it("creates a closed, isolated master session profile", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "gjc-master-session-"));
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model for master session test.");
		const domainStore = fakeDomainStore("alpha", root);
		const adapters = {
			queue: {
				list: async () => ({ ok: true }),
				enqueue: async () => ({ ok: true }),
				assign: async () => ({ ok: true }),
			},
			workers: {
				create: async () => ({ ok: true }),
				observe: async () => ({ ok: true }),
				followUp: async () => ({ ok: true }),
			},
			decisions: {
				record: async () => ({ ok: true }),
				escalate: async () => ({ ok: true }),
			},
			claims: { request: async () => ({ ok: true }) },
		};
		const doctrineContent = "Delegate implementation work and preserve durable evidence.";
		const doctrine = {
			revision: "rev-1",
			content: doctrineContent,
			sha256: createHash("sha256").update(doctrineContent, "utf8").digest("hex"),
		};
		let first: CreateAgentSessionResult | undefined;
		let second: CreateAgentSessionResult | undefined;
		try {
			first = await MasterSessionFactory.create({
				masterName: "alpha",
				cwd: root,
				model,
				authStorage,
				modelRegistry,
				domainStore,
				coordinatorGateway: fakeCoordinatorGateway(),
				memory: createDeterministicMemoryContract(),
				doctrine,
				adapters,
			});
			second = await MasterSessionFactory.create({
				masterName: "alpha",
				cwd: root,
				model,
				authStorage,
				modelRegistry,
				domainStore,
				coordinatorGateway: fakeCoordinatorGateway(),
				memory: createDeterministicMemoryContract(),
				doctrine,
				adapters,
			});
			if (!first || !second) throw new Error("Expected both master sessions to be created.");
			expect(first.session.getAgentId()).toBe("master:alpha");
			expect(second.session.getAgentId()).toBe("master:alpha");
			expect(first.eventBus).not.toBe(second.eventBus);
			expect(first.session.getActiveToolNames().slice().sort()).toEqual([...MASTER_ORCHESTRATION_TOOL_NAMES].sort());
			expect(second.session.getActiveToolNames().slice().sort()).toEqual(
				[...MASTER_ORCHESTRATION_TOOL_NAMES].sort(),
			);
			expect(first.session.agent.state.systemPrompt.join("\n")).toContain(doctrineContent);
			expect(first.session.sessionManager.getSessionDir()).toContain(path.join("masters", "alpha", "session"));
			expect(first.session.sessionManager.isManagedDestination()).toBe(false);
			expect(first.session.sessionManager.getSessionFile()).not.toContain("terminal");
		} finally {
			await first?.session.dispose();
			await second?.session.dispose();
			await authStorage.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("Coordinator-backed worker observation", () => {
	it("records the real turn outcome instead of the caller's guessed action", async () => {
		const observations: Array<Record<string, unknown>> = [];
		const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
		const observer = new MasterWorkerObserver({
			masterName: "alpha",
			domainStore: {
				observe: async (input: { event: unknown }) => {
					observations.push(input.event as Record<string, unknown>);
					return { observationId: "obs-1", disposition: "master" } as never;
				},
			} as never,
			coordinatorGateway: {
				sendPrompt: async (input: Record<string, unknown>) => {
					calls.push({ name: "send_prompt", input });
					return { ok: true, turn_id: "turn-7" };
				},
				awaitTurn: async (input: Record<string, unknown>) => {
					calls.push({ name: "await_turn", input });
					return { status: "completed", turn_id: "turn-7", output: "worker finished the task" };
				},
			} as never,
		});
		// Prove the turn through prompt delivery, which is the only way a real turn id exists.
		await observer.sendPromptForTest("worker-9", "do the work", "idem-1");

		await observer.observeFromCoordinator({ workerSessionId: "worker-9", action: "action_needed" });

		expect(calls.map(call => call.name)).toEqual(["send_prompt", "await_turn"]);
		expect(calls[1]!.input).toMatchObject({ turn_id: "turn-7", session_id: "worker-9" });
		expect(observations).toEqual([
			{
				action: "worker_terminal",
				source: "coordinator_await_turn",
				status: "completed",
				turnId: "turn-7",
				output: "worker finished the task",
				terminal: true,
			},
		]);
	}, 30_000);

	it("keeps action_needed when the real turn stopped for input", () => {
		expect(coordinatorTurnObservation({ status: "waiting", stop_reason: "action_needed" })).toMatchObject({
			action: "action_needed",
			terminal: false,
			stopReason: "action_needed",
		});
		expect(coordinatorTurnObservation({ status: "failed" })).toMatchObject({
			action: "worker_terminal",
			terminal: true,
		});
	}, 30_000);
});
