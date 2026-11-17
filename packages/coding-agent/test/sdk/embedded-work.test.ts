import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	acquireEmbeddedStopAdmission,
	cancelEmbeddedOwnedWork,
	type EmbeddedWorkSource,
	getEmbeddedOwnedWork,
	getEmbeddedQueuedWork,
} from "../../src/sdk/embedded-work";
import { ExtensionInteractionService } from "../../src/sdk/extension-interaction";
import { createAgentSession } from "../../src/sdk/session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const temp = TempDir.createSync("@embedded-work-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	const previousManager = AsyncJobManager.instance();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	auth.setRuntimeApiKey(model.provider, "synthetic-local-key");
	let gate = Promise.withResolvers<void>();
	let entered = Promise.withResolvers<void>();
	const result = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.path(),
		authStorage: auth,
		model,
		modelRegistry: new ModelRegistry(auth, path.join(temp.path(), "models.yml")),
		settings: Settings.isolated({ "bash.autoBackground.enabled": false, "compaction.enabled": false }),
		agentId: `embedded-test-${crypto.randomUUID()}`,
		agentRegistry: new AgentRegistry(),
		sessionManager: SessionManager.inMemory(temp.path()),
		disableExtensionDiscovery: true,
		extensions: [],
		toolNames: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		customTools: [
			{
				name: "local_hold",
				label: "Local hold",
				description: "Synthetic local runner",
				parameters: z.object({}),
				async execute(
					_id: string,
					_params: unknown,
					_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
					_context: CustomToolContext,
					signal?: AbortSignal,
				): Promise<AgentToolResult<unknown>> {
					const current = gate;
					const aborted = Promise.withResolvers<void>();
					const abort = () => aborted.resolve();
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
					entered.resolve();
					try {
						await Promise.race([current.promise, aborted.promise]);
					} finally {
						signal?.removeEventListener("abort", abort);
					}
					return { content: [{ type: "text", text: "local done" }] };
				},
			},
		],
	});
	const service = new ExtensionInteractionService(result.session.sessionId);
	const connection = service.connect();
	const source: EmbeddedWorkSource = {
		result,
		interaction: { service, connectionId: connection.connectionId, ownership: "owned" },
	};
	cleanups.push(async () => {
		gate.resolve();
		service.dispose();
		try {
			await result.session.dispose();
		} finally {
			AsyncJobManager.setInstance(previousManager);
			auth.close();
			await temp.remove();
		}
	});
	return {
		result,
		source,
		service,
		async start() {
			gate = Promise.withResolvers<void>();
			entered = Promise.withResolvers<void>();
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", name: "local_hold", arguments: {} }] },
					{ content: ["local answer"] },
					{ content: ["queued answer"] },
				],
			});
			result.session.agent.streamFn = mock.stream;
			const prompt = result.session.prompt("synthetic local task");
			await Promise.race([
				entered.promise,
				prompt.then(() => {
					throw new Error("Synthetic prompt ended before local_hold was admitted");
				}),
			]);
			return { prompt, release: () => gate.resolve() };
		},
	};
}

describe("embedded exact owned work", () => {
	test("default inventory and absent/forged consent never close, abort or remove queued work", async () => {
		const f = await fixture();
		const run = await f.start();
		const submission = await f.result.session.submitUserMessage("same draft", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const abort = spyOn(f.result.session, "abortPromptAndWait");
		const dispose = spyOn(f.result.session, "dispose");
		const clear = spyOn(f.result.session, "clearQueue");
		try {
			const inventory = getEmbeddedOwnedWork(f.source);
			expect(inventory.inputs.map(input => input.id)).toEqual([submission.submissionId]);
			expect((await cancelEmbeddedOwnedWork(f.source)).reason).toBe("consent_required");
			expect(
				(
					await cancelEmbeddedOwnedWork(f.source, {
						inventory: structuredClone(inventory),
						targets: [{ kind: "queued_input", id: submission.submissionId }],
					})
				).reason,
			).toBe("invalid_inventory");
			expect(getEmbeddedQueuedWork(f.source).inputs).toHaveLength(1);
			expect(abort).not.toHaveBeenCalled();
			expect(clear).not.toHaveBeenCalled();
			expect(dispose).not.toHaveBeenCalled();
		} finally {
			abort.mockRestore();
			dispose.mockRestore();
			clear.mockRestore();
			run.release();
			await run.prompt;
		}
	});

	test("exact draft cancellation happens before consented exact run abort and keeps the other draft", async () => {
		const f = await fixture();
		const run = await f.start();
		const first = await f.result.session.submitUserMessage("identical", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const second = await f.result.session.submitUserMessage("identical", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const inventory = getEmbeddedOwnedWork(f.source);
		const originalAbort = f.result.session.abortPromptAndWait.bind(f.result.session);
		const abort = spyOn(f.result.session, "abortPromptAndWait").mockImplementation(async (id, options) => {
			expect(getEmbeddedQueuedWork(f.source).inputs.map(input => input.id)).toEqual([second.submissionId]);
			return originalAbort(id, options);
		});
		try {
			const cancelled = await cancelEmbeddedOwnedWork(f.source, {
				inventory,
				targets: [
					{ kind: "active_run", id: inventory.activeRunId! },
					{ kind: "queued_input", id: first.submissionId },
				],
				timeoutMs: 100,
			});
			expect(cancelled.results[0]).toMatchObject({ target: { id: first.submissionId }, status: "removed" });
			expect(await first.terminal).toMatchObject({ disposition: "removed", reason: "cancelled" });
			expect(abort).toHaveBeenCalledTimes(1);
		} finally {
			abort.mockRestore();
			run.release();
			await run.prompt;
		}
	});

	test("a stale active-run target rejects the whole consent before deleting any draft", async () => {
		const f = await fixture();
		const firstRun = await f.start();
		const firstInventory = getEmbeddedOwnedWork(f.source);
		firstRun.release();
		await firstRun.prompt;
		const successor = await f.start();
		const draft = await f.result.session.submitUserMessage("successor draft", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const inventory = getEmbeddedOwnedWork(f.source);
		const abort = spyOn(f.result.session, "abortPromptAndWait");
		try {
			const refused = await cancelEmbeddedOwnedWork(f.source, {
				inventory: firstInventory,
				targets: [{ kind: "active_run", id: firstInventory.activeRunId! }],
			});
			expect(refused.status).toBe("rejected");
			const forged = await cancelEmbeddedOwnedWork(f.source, {
				inventory,
				targets: [
					{ kind: "queued_input", id: draft.submissionId },
					{ kind: "active_run", id: firstInventory.activeRunId! },
				],
			});
			expect(forged.status).toBe("rejected");
			expect(getEmbeddedQueuedWork(f.source).inputs.map(input => input.id)).toEqual([draft.submissionId]);
			expect(abort).not.toHaveBeenCalled();
		} finally {
			abort.mockRestore();
			successor.release();
			await successor.prompt;
		}
	});

	test("racing tracked delivery returns already-executing or unknown, never aborts the successor", async () => {
		const f = await fixture();
		const run = await f.start();
		const draft = await f.result.session.submitUserMessage("delivered before consent executes", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const inventory = getEmbeddedOwnedWork(f.source);
		run.release();
		await draft.execution;
		const abort = spyOn(f.result.session, "abortPromptAndWait");
		try {
			const cancelled = await cancelEmbeddedOwnedWork(f.source, {
				inventory,
				targets: [{ kind: "queued_input", id: draft.submissionId }],
			});
			expect(["already_executing", "unknown"]).toContain(cancelled.results[0]?.status);
			expect(abort).not.toHaveBeenCalled();
		} finally {
			abort.mockRestore();
			await run.prompt;
		}
	});

	test("nested external barriers are reversible and allow admitted queued work to finish", async () => {
		const f = await fixture();
		const run = await f.start();
		const draft = await f.result.session.submitUserMessage("already admitted", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const before = getEmbeddedQueuedWork(f.source).inputs;
		const first = acquireEmbeddedStopAdmission(f.source);
		const second = acquireEmbeddedStopAdmission(f.source);
		try {
			expect(getEmbeddedQueuedWork(f.source).inputs).toEqual(before);
			await expect(f.result.session.followUp("new external")).rejects.toMatchObject({ code: "busy" });
			first.release();
			first.release();
			await expect(f.result.session.followUp("still fenced")).rejects.toMatchObject({ code: "busy" });
			run.release();
			await run.prompt;
			expect((await draft.terminal).disposition).toBe("completed");
			second.release();
			await f.result.session.followUp("unfenced");
			expect(f.result.session.sessionLifecycle.disposed).toBe(false);
		} finally {
			first.release();
			second.release();
			run.release();
			await run.prompt;
		}
	});

	test("owner UI cancellation uses its owning address; stale and borrowed consent has zero mixed effects", async () => {
		const f = await fixture();
		const run = await f.start();
		const draft = await f.result.session.submitUserMessage("keep on stale UI", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const pending = f.service.request({ kind: "input", title: "local request" });
		const inventory = getEmbeddedOwnedWork(f.source);
		if (inventory.pendingRequests.status !== "available") throw new Error("Expected actual service inventory");
		const id = inventory.pendingRequests.value[0]!;
		const borrowed: EmbeddedWorkSource = {
			result: f.result,
			interaction: { ...f.source.interaction!, ownership: "borrowed" },
		};
		const borrowedInventory = getEmbeddedOwnedWork(borrowed);
		expect(
			(await cancelEmbeddedOwnedWork(borrowed, { inventory: borrowedInventory, targets: [{ kind: "request", id }] }))
				.status,
		).toBe("rejected");
		f.service.connect();
		const refused = await cancelEmbeddedOwnedWork(f.source, {
			inventory,
			targets: [
				{ kind: "queued_input", id: draft.submissionId },
				{ kind: "request", id },
			],
		});
		expect(refused.status).toBe("rejected");
		expect(getEmbeddedQueuedWork(f.source).inputs.map(input => input.id)).toEqual([draft.submissionId]);
		expect(f.service.snapshot().pending.map(request => request.requestId)).toEqual([id]);
		const connection = f.service.connect();
		const current: EmbeddedWorkSource = {
			result: f.result,
			interaction: { service: f.service, connectionId: connection.connectionId, ownership: "owned" },
		};
		const currentInventory = getEmbeddedOwnedWork(current);
		expect(
			(await cancelEmbeddedOwnedWork(current, { inventory: currentInventory, targets: [{ kind: "request", id }] }))
				.results[0]?.status,
		).toBe("cancelled");
		expect(await pending).toEqual({ status: "cancelled", reason: "user" });
		run.release();
		await run.prompt;
	});

	test("hidden reminders are separate blockers, never user draft IDs or implicitly cleared", async () => {
		const f = await fixture();
		const run = await f.start();
		try {
			await f.result.session.sendCustomMessage(
				{ customType: "hidden-local", content: "retain me", display: false },
				{ deliverAs: "nextTurn", triggerTurn: false },
			);
			const inventory = getEmbeddedOwnedWork(f.source);
			expect(inventory.inputs).toEqual([]);
			expect(inventory.blockers).toContainEqual(expect.objectContaining({ kind: "hidden_context" }));
			expect(
				(await cancelEmbeddedOwnedWork(f.source, { inventory, targets: [] })).remaining.blockers,
			).toContainEqual(expect.objectContaining({ kind: "hidden_context" }));
			expect(f.result.session.pendingMessageCounts.nextTurn).toBe(1);
		} finally {
			run.release();
			await run.prompt;
		}
	});

	test("idle next-turn context is already appended, not falsely reported as queued work", async () => {
		const f = await fixture();
		await f.result.session.sendCustomMessage(
			{ customType: "hidden-idle", content: "retained context", display: false },
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
		const inventory = getEmbeddedOwnedWork(f.source);
		expect(inventory.inputs).toEqual([]);
		expect(inventory.blockers.some(blocker => blocker.kind === "hidden_context")).toBe(false);
		expect(f.result.session.pendingMessageCounts.nextTurn).toBe(0);
		expect(f.result.session.agent.state.messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "hidden-idle", content: "retained context" }),
		);
		await cancelEmbeddedOwnedWork(f.source, { inventory, targets: [] });
		expect(f.result.session.agent.state.messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "hidden-idle", content: "retained context" }),
		);
	});

	test("supplied stale abortRunId is rejected before terminal queue bookkeeping", async () => {
		const f = await fixture();
		const run = await f.start();
		const draft = await f.result.session.submitUserMessage("must survive stale abort", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const current = f.result.session.activeLogicalRunId!;
		const proof = await f.result.session.abortPromptAndWait(current, {
			graceMs: 0,
			abortRunId: "stale-run",
			terminal: { scope: "owned" },
		});
		expect(proof).toMatchObject({ status: "unfenced", reason: "unknown_run" });
		expect(f.result.session.activeLogicalRunId).toBe(current);
		expect(getEmbeddedQueuedWork(f.source).inputs.map(input => input.id)).toEqual([draft.submissionId]);
		run.release();
		await run.prompt;
	});
});
