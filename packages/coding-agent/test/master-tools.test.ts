import { describe, expect, it } from "bun:test";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import { createDeterministicMemoryContract } from "../src/master/memory-contract";
import systemPrompt from "../src/master/prompts/system.md" with { type: "text" };
import {
	assertMasterOrchestrationToolCatalog,
	createMasterOrchestrationTools,
	MASTER_ORCHESTRATION_TOOL_NAMES,
	type MasterOrchestrationToolDependencies,
} from "../src/master/tools";

interface Call {
	readonly operation: string;
	readonly input: unknown;
}

const customToolContext: CustomToolContext = {
	sessionManager: {
		getCwd: () => "/tmp",
		getSessionId: () => "master-tools-test",
	} as CustomToolContext["sessionManager"],
	modelRegistry: {} as CustomToolContext["modelRegistry"],
	model: undefined,
	isIdle: () => true,
	hasQueuedMessages: () => false,
	abort: () => {},
};

function makeDependencies(calls: Call[]): MasterOrchestrationToolDependencies {
	return {
		masterName: "alpha",
		queue: {
			list: async input => {
				calls.push({ operation: "queue.list", input });
				return { ok: true, operation: "queue.list" };
			},
			enqueue: async input => {
				calls.push({ operation: "queue.enqueue", input });
				return { ok: true, operation: "queue.enqueue" };
			},
			assign: async input => {
				calls.push({ operation: "queue.assign", input });
				return { ok: true, operation: "queue.assign" };
			},
		},
		workers: {
			create: async input => {
				calls.push({ operation: "worker.create", input });
				return { ok: true, operation: "worker.create" };
			},
			observe: async input => {
				calls.push({ operation: "worker.observe", input });
				return { ok: true, operation: "worker.observe" };
			},
			followUp: async input => {
				calls.push({ operation: "worker.followUp", input });
				return { ok: true, operation: "worker.followUp" };
			},
		},
		decisions: {
			record: async input => {
				calls.push({ operation: "decision.record", input });
				return { ok: true, operation: "decision.record" };
			},
			escalate: async input => {
				calls.push({ operation: "decision.escalate", input });
				return { ok: true, operation: "decision.escalate" };
			},
		},
		claims: {
			request: async input => {
				calls.push({ operation: "claim.request", input });
				return { ok: true, operation: "claim.request" };
			},
		},
		memory: createDeterministicMemoryContract(),
	};
}

function toolMap(dependencies: MasterOrchestrationToolDependencies) {
	return new Map(createMasterOrchestrationTools(dependencies).map(tool => [tool.name, tool] as const));
}

describe("master orchestration tools", () => {
	it("exposes exactly the approved sorted catalog", () => {
		const tools = createMasterOrchestrationTools(makeDependencies([]));
		expect(tools.map(tool => tool.name).sort()).toEqual([...MASTER_ORCHESTRATION_TOOL_NAMES].sort());
		expect(tools).toHaveLength(11);
		expect(tools.some(tool => tool.name === "master_claim_approve")).toBe(false);
	}, 30_000);

	it("rejects duplicate, missing, and extra catalog entries", () => {
		expect(() =>
			assertMasterOrchestrationToolCatalog([...MASTER_ORCHESTRATION_TOOL_NAMES, "master_queue_list"]),
		).toThrow(/duplicates/);
		expect(() => assertMasterOrchestrationToolCatalog(MASTER_ORCHESTRATION_TOOL_NAMES.slice(1))).toThrow(/missing/);
		expect(() =>
			assertMasterOrchestrationToolCatalog([...MASTER_ORCHESTRATION_TOOL_NAMES.slice(0, -1), "master_unlisted"]),
		).toThrow(/missing=.*master_memory_write/);
	}, 30_000);

	it("dispatches validated calls only through injected adapters", async () => {
		const calls: Call[] = [];
		const tools = toolMap(makeDependencies(calls));
		await tools
			.get("master_queue_enqueue")!
			.execute(
				"enqueue",
				{ idempotencyKey: "q-1", priority: "autonomous", summary: "build" },
				undefined,
				customToolContext,
			);
		await tools
			.get("master_worker_follow_up")!
			.execute(
				"follow",
				{ workerSessionId: "worker-1", prompt: "continue", idempotencyKey: "p-1" },
				undefined,
				customToolContext,
			);
		await tools.get("master_record_decision")!.execute(
			"decision",
			{
				trigger: { kind: "daemon_recovery", recoveryId: "recovery-1" },
				outcome: "follow_up",
				reason: "continue the owned task",
				doctrine: { revision: "rev-1", sha256: "a".repeat(64) },
				memory: { availability: "unavailable", activityIds: [] },
			},
			undefined,
			customToolContext,
		);
		await tools
			.get("master_claim_request")!
			.execute("claim", { authorizationId: "authorization-1" }, undefined, customToolContext);
		await tools.get("master_memory_read")!.execute("memory", { query: "policy" }, undefined, customToolContext);
		expect(calls.map(call => call.operation)).toEqual([
			"queue.enqueue",
			"worker.followUp",
			"decision.record",
			"claim.request",
		]);
	}, 30_000);

	it("rejects malformed input and missing dependencies", async () => {
		const tools = toolMap(makeDependencies([]));
		await expect(
			tools.get("master_queue_assign")!.execute("bad", { leaseId: "" }, undefined, customToolContext),
		).rejects.toThrow();
		await expect(
			tools.get("master_queue_list")!.execute("bad", { limit: 51 }, undefined, customToolContext),
		).rejects.toThrow();
		await expect(
			tools
				.get("master_memory_write")!
				.execute("bad", { content: "x", idempotencyKey: "m-1", extra: true }, undefined, customToolContext),
		).rejects.toThrow();
		const incomplete = {
			...makeDependencies([]),
			memory: undefined,
		} as unknown as MasterOrchestrationToolDependencies;
		expect(() => createMasterOrchestrationTools(incomplete)).toThrow(/Memory/);
	}, 30_000);

	it("keeps approval outside the model surface and states the policy in the prompt", () => {
		expect(systemPrompt).toContain("master_claim_request");
		expect(systemPrompt).toContain("no `master_claim_approve` tool");
		expect(systemPrompt).toContain("master_record_decision");
		expect(systemPrompt).toContain("master_memory_read");
		expect(systemPrompt).toContain("maxConcurrentWorkers");
		expect(systemPrompt).toMatch(/Never edit source code/i);
		expect(systemPrompt).not.toMatch(/\{\{[^}]+\}\}/);
	}, 30_000);
});
