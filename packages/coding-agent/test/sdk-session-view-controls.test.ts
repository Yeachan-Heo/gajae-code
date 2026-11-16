import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockModel, type MockResponse } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import {
	captureSessionView,
	restoreSessionView,
	reviseSession,
	SdkRevisionError,
	type SdkSessionView,
} from "../src/sdk/revision-controls";
import {
	AgentSession,
	ExecutionSelectionError,
	type ExecutionSelectionPublication,
} from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { resumeDigest } from "../src/session/native-resume";
import { OWNER_ENROLL_CUSTOM_TYPE, RESUME_CURSOR_CUSTOM_TYPE } from "../src/session/resume-cursor";
import { type PendingResumeOp, SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";
import { EventBus } from "../src/utils/event-bus";

const MCP_TOOL = "mcp__view_lookup";
const lookupTool = {
	name: MCP_TOOL,
	label: "Lookup",
	description: "Test context selection",
	parameters: z.object({}),
	mcpServerName: "view",
	mcpToolName: "lookup",
	async execute() {
		throw new Error("Session view restoration must not execute tools");
	},
} satisfies AgentTool & { mcpServerName: string; mcpToolName: string };

describe("SDK exact session view", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let model: MockModel;
	let session: AgentSession;
	let cancelTree: boolean;
	let beforeTree: (() => void | Promise<void>) | undefined;
	let treeEvents: string[];
	let rebuild: (names: string[]) => Promise<{ systemPrompt: string[] }>;
	const restores: Array<() => void> = [];
	const sessions: AgentSession[] = [];

	async function createSession(manager: SessionManager, discovery = false): Promise<AgentSession> {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled test model");
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.on("session_before_tree", async () => {
					treeEvents.push("before");
					await beforeTree?.();
					return cancelTree ? { cancel: true } : undefined;
				});
				api.on("session_tree", () => {
					treeEvents.push("after");
				});
			},
			dir.path(),
			new EventBus(),
			runtime,
			"session-view-hooks",
		);
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("default", `${bundled.provider}/${bundled.id}`);
		const created = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: bundled,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
				streamFn: model.stream,
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			extensionRunner: new ExtensionRunner([extension], runtime, dir.path(), manager, registry),
			mcpDiscoveryEnabled: discovery,
			toolRegistry: discovery ? new Map([[MCP_TOOL, lookupTool]]) : new Map(),
			rebuildSystemPrompt: names => rebuild(names),
		});
		sessions.push(created);
		return created;
	}

	beforeEach(async () => {
		dir = TempDir.createSync("sdk-session-view-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		auth.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(auth);
		model = createMockModel({ handler: { content: ["ordinary answer"] } });
		cancelTree = false;
		beforeTree = undefined;
		treeEvents = [];
		rebuild = async names => ({ systemPrompt: [`tools:${names.join(",")}`] });
		session = await createSession(SessionManager.create(dir.path(), path.join(dir.path(), "sessions")));
	});

	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		for (const created of sessions.splice(0)) await created.dispose();
		await registry.dispose();
		auth.close();
		dir.removeSync();
	});

	async function prompt(text: string): Promise<string> {
		await session.prompt(text);
		await session.waitForIdle();
		await session.awaitSessionSettlement();
		const entry = session.sessionManager
			.getBranch()
			.findLast(item => item.type === "message" && item.message.role === "user");
		if (!entry) throw new Error("Expected persisted user message");
		return entry.id;
	}

	async function recreate(): Promise<void> {
		const manager = session.sessionManager;
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected on-disk transcript");
		await session.dispose();
		session = await createSession(await SessionManager.open(file, path.dirname(file)));
	}

	function target(leafEntryId: string | null): SdkSessionView {
		return { sessionId: session.sessionId, leafEntryId };
	}

	async function seedMcpBranches(): Promise<{ old: string; previous: string }> {
		await session.dispose();
		const manager = SessionManager.create(dir.path(), path.join(dir.path(), "mcp-sessions"));
		manager.appendMCPToolSelection([MCP_TOOL]);
		const old = manager.appendMessage({ role: "user", content: "old context", timestamp: 1 });
		manager.resetLeaf();
		manager.appendMCPToolSelection([]);
		const previous = manager.appendMessage({ role: "user", content: "previous context", timestamp: 2 });
		session = await createSession(manager, true);
		return { old, previous };
	}

	it("restores old, revised and continued views across disposal and recreation without transcript writes", async () => {
		const original = await prompt("original");
		const oldAnswer = captureSessionView(session);
		await prompt("old continuation");
		const oldContinued = captureSessionView(session);
		const revision = await reviseSession(session, {
			sessionId: session.sessionId,
			entryId: original,
			body: "revised",
		});
		if (revision.status !== "completed") throw new Error("Expected completed revision");
		const revisedAnswer = captureSessionView(session);
		await prompt("revised continuation");
		const revisedContinued = captureSessionView(session);
		const selected = await reviseSession(session, {
			sessionId: session.sessionId,
			entryId: original,
			action: "select",
		});
		if (selected.status !== "selected") throw new Error("Expected selected branch");
		const executionView = captureSessionView(session);
		expect(executionView.leafEntryId).toBe(selected.leafEntryId);
		expect(session.sessionManager.getBranch().some(entry => entry.id === oldContinued.leafEntryId)).toBe(true);
		const manager = session.sessionManager;
		const entries = manager.getEntries();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted transcript");
		await manager.flush();
		const transcript = await Bun.file(file).text();
		const calls = model.calls.length;
		cancelTree = true;
		treeEvents.length = 0;
		for (const view of [oldContinued, oldAnswer, revisedAnswer, revisedContinued, oldContinued]) {
			await recreate();
			expect(captureSessionView(session)).toEqual(executionView);
			expect(await restoreSessionView(session, view)).toEqual(view);
			expect(captureSessionView(session)).toEqual(view);
			expect(session.agent.state.messages).toEqual(session.buildDisplaySessionContext().messages);
			expect(session.sessionManager.getEntries()).toEqual(entries);
			expect(session.sessionManager.getSessionFile()).toBe(file);
			expect(await Bun.file(file).text()).toBe(transcript);
		}
		expect(model.calls).toHaveLength(calls);
		expect(treeEvents).toEqual([]);
	});

	it("durably selects a non-tail answered branch with exact chunk accounting and reopens its checkpoint", async () => {
		const original = await prompt("retained answer");
		const answer = session.sessionManager.getLeafId()!;
		await session.sessionManager.flush();
		const file = session.sessionManager.getSessionFile()!;
		const seed = await Bun.file(file).text();
		await session.dispose();
		// A real pre-existing multi-branch transcript, not 258 new executions
		// whose ordinary writer correctly pins each selected branch in turn.
		const siblings = Array.from({ length: 258 }, (_, index) => ({
			type: "custom",
			id: `chunk-sibling-${index}`,
			parentId: answer,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "sibling",
			data: { index },
		}));
		await Bun.write(
			file,
			`${seed}${siblings.map(entry => JSON.stringify(entry)).join("\n")}\n${JSON.stringify({
				type: "custom",
				id: "separate-root",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "separate-root",
				data: {},
			})}\n`,
		);
		session = await createSession(await SessionManager.open(file, path.dirname(file)));
		const manager = session.sessionManager;
		const before = manager.getEntries();
		const revision = manager.revisionSnapshot();
		const navigate = session.navigateTree.bind(session);
		const navigation = spyOn(session, "navigateTree");
		const publications: ExecutionSelectionPublication[] = [];
		navigation.mockImplementation(async (id, options) => {
			const result = await navigate(id, options);
			if (result.executionSelection) publications.push(result.executionSelection);
			return result;
		});
		restores.push(() => navigation.mockRestore());
		const result = await reviseSession(session, {
			sessionId: session.sessionId,
			entryId: original,
			action: "select",
		});
		const publication = publications[0];
		if (result.status !== "selected" || !publication || publication.pending.CB === null)
			throw new Error("Expected non-null durable answered selection");
		expect(publication.pending.plan.cursorIds).toHaveLength(2);
		expect(publication.result.receipt.commitment.operationComplete).toBe(true);
		expect(publication.result.receipt.commitment.continueEligible).toBe(true);
		expect(result.leafEntryId).toBe(publication.pending.CB);
		expect(
			manager
				.getEntries()
				.slice(before.length)
				.map(entry => entry.id),
		).toEqual(publication.pending.manifest.map(entry => entry.id));
		expect(manager.revisionSnapshot().entry - revision.entry).toBe(publication.pending.manifest.length);
		for (const entry of before) expect(manager.getEntry(entry.id)).toEqual(entry);
		const selected = captureSessionView(session);
		await recreate();
		expect(captureSessionView(session)).toEqual(selected);
		expect(session.agent.state.messages.at(-1)?.role).toBe("assistant");
		expect(model.calls).toHaveLength(1);
	});

	it("commits exactly its owned cursor metadata before a default prompt edit and retains the original answer", async () => {
		const original = await prompt("original answer");
		const manager = session.sessionManager;
		const targetEntry = manager.getEntry(original);
		if (targetEntry?.type !== "message") throw new Error("Expected original prompt");
		const entries = manager.getEntries();
		const revisions = manager.revisionSnapshot();
		const publish = session.selectExecutionBranchDurably.bind(session);
		const publications: ExecutionSelectionPublication[] = [];
		const selection = spyOn(session, "selectExecutionBranchDurably").mockImplementation(
			async (leaf, op, beforeCommit) => {
				const publication = await publish(leaf, op, beforeCommit);
				if (!publication) throw new Error("Expected durable edit selection");
				publications.push(publication);
				const additions = manager.getEntries().slice(entries.length);
				expect(
					additions.map((entry, order) => ({
						id: entry.id,
						parentId: entry.parentId,
						payloadDigest: resumeDigest(JSON.stringify(entry)),
						order,
						kind: entry.type === "custom" && entry.customType === OWNER_ENROLL_CUSTOM_TYPE ? "enroll" : "cursor",
					})),
				).toEqual([...publication.pending.manifest]);
				for (const entry of additions) {
					if (entry.type !== "custom") throw new Error("Expected selection metadata, not a prompt turn");
					expect(entry.customType).toBe(
						entry.id === publication.pending.plan.enroll ? OWNER_ENROLL_CUSTOM_TYPE : RESUME_CURSOR_CUSTOM_TYPE,
					);
				}
				expect(manager.revisionSnapshot()).toEqual({
					...revisions,
					entry: revisions.entry + additions.length,
					leaf: revisions.leaf + 2,
				});
				expect(manager.getLeafId()).toBe(publication.pending.CB);
				expect(model.calls).toHaveLength(1);
				return publication;
			},
		);
		restores.push(() => selection.mockRestore());
		const result = await reviseSession(session, {
			sessionId: session.sessionId,
			entryId: original,
			body: "replacement",
		});
		if (result.status !== "completed") throw new Error("Expected completed persistent edit");
		const publication = publications[0];
		if (!publication) throw new Error("Expected the owning preflight to publish a selection");
		expect(selection).toHaveBeenCalledTimes(1);
		expect(publication.pending.plan.target).toBe(targetEntry.parentId);
		expect(publication.result.receipt.op).toBe(publication.pending.op);
		expect(publication.result.receipt.commitment.operationComplete).toBe(true);
		expect(publication.result.receipt.commitment.continueEligible).toBe(true);
		for (const entry of entries) expect(manager.getEntry(entry.id)).toEqual(entry);
		const branch = manager.getBranch();
		expect(branch.some(entry => entry.id === original)).toBe(false);
		const cursorIndex = branch.findIndex(entry => entry.id === publication.pending.CB);
		expect(cursorIndex).toBeGreaterThanOrEqual(0);
		expect(cursorIndex).toBeLessThan(branch.findIndex(entry => entry.id === result.replacementEntryId));
		expect(manager.getLeafId()).toBe(result.assistantEntryId);
		expect(model.calls).toHaveLength(2);
	});

	for (const mismatch of ["digest", "parent", "order", "kind", "cursor-plan", "continuation-base"] as const) {
		it(`refuses a ${mismatch} mismatch in a real edit selection receipt without erasing the committed operation`, async () => {
			const original = await prompt("original");
			const manager = session.sessionManager;
			const entries = manager.getEntries();
			const publish = session.selectExecutionBranchDurably.bind(session);
			const publications: ExecutionSelectionPublication[] = [];
			const selection = spyOn(session, "selectExecutionBranchDurably").mockImplementation(
				async (leaf, op, beforeCommit) => {
					const publication = await publish(leaf, op, beforeCommit);
					if (!publication || publication.pending.manifest.length === 0)
						throw new Error("Expected real cursor publication");
					publications.push(publication);
					const pending = publication.pending;
					return {
						...publication,
						pending: {
							...pending,
							...(mismatch === "continuation-base" ? { CB: leaf } : {}),
							...(mismatch === "cursor-plan" ? { plan: { ...pending.plan, cursorIds: [] } } : {}),
							manifest: pending.manifest.map((item, index) =>
								index !== 0
									? item
									: {
											...item,
											...(mismatch === "digest" ? { payloadDigest: "0".repeat(64) } : {}),
											...(mismatch === "parent" ? { parentId: original } : {}),
											...(mismatch === "order" ? { order: item.order + 1 } : {}),
											...(mismatch === "kind" ? { kind: "dependent" as const } : {}),
										},
							),
						},
					};
				},
			);
			restores.push(() => selection.mockRestore());
			await expect(
				reviseSession(session, { sessionId: session.sessionId, entryId: original, body: "must not run" }),
			).rejects.toMatchObject({ code: "resource_gone", rollbackFailed: false });
			const publication = publications[0];
			if (!publication) throw new Error("Expected committed operation to remain available");
			expect(manager.getLeafId()).toBe(publication.pending.CB);
			expect(
				manager
					.getEntries()
					.slice(entries.length)
					.map(entry => entry.id),
			).toEqual(publication.pending.manifest.map(item => item.id));
			for (const entry of entries) expect(manager.getEntry(entry.id)).toEqual(entry);
			expect(model.calls).toHaveLength(1);
		});
	}

	it("durably selects the null execution root with a stable operation identity across reopen", async () => {
		await prompt("retained branch");
		const manager = session.sessionManager;
		const operation = "sdk-view-explicit-null";
		const publication = await session.selectExecutionBranchDurably(null, operation);
		if (!publication) throw new Error("Expected a real manager publication");
		expect(publication.pending.op).toBe(operation);
		expect(publication.pending.plan.target).toBeNull();
		expect(publication.pending.plan.cursorIds.length).toBeGreaterThan(0);
		expect(publication.result.receipt.commitment.operationComplete).toBe(true);
		expect(publication.result.receipt.commitment.continueEligible).toBe(true);
		const file = manager.getSessionFile()!;
		const bytes = await Bun.file(file).text();
		const retry = await session.selectExecutionBranchDurably(null, operation);
		expect(retry?.pending).toBe(publication.pending);
		expect(await Bun.file(file).text()).toBe(bytes);
		await recreate();
		expect(session.sessionManager.getLeafId()).toBe(publication.pending.CB);
		expect(session.agent.state.messages).toEqual([]);
		expect(model.calls).toHaveLength(1);
	});

	it("rejects stale revision state from an awaited tree admission hook before any selection publication", async () => {
		const original = await prompt("original");
		await restoreSessionView(session, target(null));
		await prompt("separate root");
		const manager = session.sessionManager;
		const select = spyOn(manager, "selectExecutionBranch");
		restores.push(() => select.mockRestore());
		let foreignLeaf: string | null = null;
		beforeTree = async () => {
			await Promise.resolve();
			foreignLeaf = manager.appendCustomEntry("foreign-tree-admission", { retained: true });
		};
		await expect(
			reviseSession(session, { sessionId: session.sessionId, entryId: original, action: "select" }),
		).rejects.toMatchObject({ code: "resource_gone" });
		expect(select).not.toHaveBeenCalled();
		expect(manager.getLeafId()).toBe(foreignLeaf);
		expect(manager.getEntries().at(-1)).toMatchObject({ customType: "foreign-tree-admission" });
		expect(model.calls).toHaveLength(2);
	});

	for (const mutation of ["append", "entry-update", "leaf-roundtrip"] as const) {
		it(`rejects ${mutation} from awaited edit tree admission before any presentation or execution effect`, async () => {
			const original = await prompt("original");
			const manager = session.sessionManager;
			const lifecycle = session.sessionLifecycle;
			const messages = session.agent.state.messages.slice();
			const publish = spyOn(session, "selectExecutionBranchDurably");
			restores.push(() => publish.mockRestore());
			let foreignLeaf: string | null = null;
			beforeTree = async () => {
				await Promise.resolve();
				if (mutation === "append") manager.appendCustomEntry("foreign-edit-tree-admission", { retained: true });
				if (mutation === "entry-update") {
					const entry = manager.getEntry(original);
					if (entry?.type !== "message" || entry.message.role !== "user")
						throw new Error("Expected original user");
					manager.applyEntryMessageUpdates([
						{ ...entry, message: { ...entry.message, content: "foreign update" } },
					]);
				}
				if (mutation === "leaf-roundtrip") {
					const leaf = manager.getLeafId()!;
					manager.resetLeaf();
					manager.branch(leaf);
				}
				foreignLeaf = manager.getLeafId();
			};
			await expect(
				reviseSession(session, { sessionId: session.sessionId, entryId: original, body: "must not run" }),
			).rejects.toMatchObject({ code: "resource_gone" });
			expect(publish).not.toHaveBeenCalled();
			expect(session.sessionLifecycle).toEqual(lifecycle);
			expect(session.agent.state.messages).toEqual(messages);
			expect(manager.getLeafId()).toBe(foreignLeaf);
			expect(treeEvents).toEqual(["before"]);
			expect(model.calls).toHaveLength(1);
		});
	}

	for (const action of ["navigate", "edit"] as const) {
		it(`preserves the prior runtime, presentation view and immutable pending operation on actual ${action} cursor durability refusal`, async () => {
			await session.dispose();
			const storage = new FileSessionStorage();
			session = await createSession(
				SessionManager.create(dir.path(), path.join(dir.path(), "refusal-sessions"), storage),
			);
			const original = await prompt("earlier answer");
			const targetEntry = session.sessionManager.getEntry(original);
			if (targetEntry?.type !== "message") throw new Error("Expected original prompt");
			const selectedAnswer = session.sessionManager.getLeafId()!;
			await prompt("keep current view");
			const manager = session.sessionManager;
			const view = captureSessionView(session);
			const messages = session.agent.state.messages.slice();
			const entries = manager.getEntries();
			const revision = manager.revisionSnapshot();
			const lifecycle = session.sessionLifecycle;
			const staged: Array<{ pending: PendingResumeOp; snapshot: string }> = [];
			const select = manager.selectExecutionBranch.bind(manager);
			const selection = spyOn(manager, "selectExecutionBranch").mockImplementation(async (targetId, options) => {
				const pending = await select(targetId, options);
				staged.push({ pending, snapshot: JSON.stringify(pending) });
				return pending;
			});
			const repair = spyOn(storage, "repairDurabilitySync").mockImplementation(() => {
				throw new Error("injected cursor fsync refusal");
			});
			restores.push(
				() => selection.mockRestore(),
				() => repair.mockRestore(),
			);
			let refusal: unknown;
			try {
				if (action === "navigate")
					await session.navigateTree(selectedAnswer, { includeTarget: true, summarize: false });
				else
					await reviseSession(session, { sessionId: session.sessionId, entryId: original, body: "must not run" });
			} catch (error) {
				refusal = error;
			}
			const attempt = staged[0];
			if (!attempt) throw new Error("Expected retained cursor attempt");
			try {
				if (action === "navigate") {
					expect(refusal).toBeInstanceOf(ExecutionSelectionError);
					if (!(refusal instanceof ExecutionSelectionError)) throw new Error("Expected typed selection refusal");
					expect(refusal.code, JSON.stringify(refusal.receipt)).toBe("uncertain_cursor");
					expect(refusal.pending).toBe(attempt.pending);
				} else {
					expect(refusal).toBeInstanceOf(SdkRevisionError);
					if (!(refusal instanceof SdkRevisionError)) throw new Error("Expected typed SDK revision refusal");
					expect(refusal.code).toBe("revision_failed");
					expect(refusal.rollbackFailed).toBe(false);
				}
				expect(Object.isFrozen(attempt.pending)).toBe(true);
				expect(Object.isFrozen(attempt.pending.plan)).toBe(true);
				expect(Object.isFrozen(attempt.pending.manifest)).toBe(true);
				expect(JSON.stringify(attempt.pending)).toBe(attempt.snapshot);
				const selectedTarget = action === "navigate" ? selectedAnswer : targetEntry.parentId;
				expect(attempt.pending.plan.target).toBe(selectedTarget);
				expect(attempt.pending.CB).toBe(attempt.pending.plan.cursorIds.at(-1) ?? selectedTarget);
				expect(manager.getLeafId()).toBe(view.leafEntryId);
				expect(session.sessionLifecycle).toEqual({
					...lifecycle,
					generation: lifecycle.generation + (action === "navigate" ? 0 : 2),
				});
				expect(session.agent.state.messages).toEqual(messages);
				for (const entry of entries) expect(manager.getEntry(entry.id)).toEqual(entry);
				// The refused attempt remains retained; presentation rollback cannot erase or rebase it.
				expect(
					manager
						.getEntries()
						.slice(entries.length)
						.map((entry, order) => ({
							id: entry.id,
							parentId: entry.parentId,
							payloadDigest: resumeDigest(JSON.stringify(entry)),
							order,
							kind:
								entry.type === "custom" && entry.customType === OWNER_ENROLL_CUSTOM_TYPE ? "enroll" : "cursor",
						})),
				).toEqual([...attempt.pending.manifest]);
				expect(manager.revisionSnapshot()).toEqual({
					...revision,
					entry: revision.entry + attempt.pending.manifest.length,
					leaf: revision.leaf + (action === "navigate" ? 2 : 4),
				});
				const file = manager.getSessionFile();
				if (!file) throw new Error("Expected transcript with retained attempt");
				const bytes = await Bun.file(file).text();
				expect(await manager.selectExecutionBranch(selectedTarget, { op: attempt.pending.op })).toBe(
					attempt.pending,
				);
				expect(JSON.stringify(attempt.pending)).toBe(attempt.snapshot);
				expect(manager.getLeafId()).toBe(view.leafEntryId);
				expect(await Bun.file(file).text()).toBe(bytes);
				expect(model.calls).toHaveLength(2);
			} finally {
				// Recover the retained attempt with actual storage evidence before normal teardown.
				repair.mockRestore();
				const repaired = await manager.reconcileResumeOperation(attempt.pending, "repairDurability", {
					contextFamily: "live",
					context: "runtime",
					closeOutcome: "none_started",
					invocation: "RECON",
					action: "RETAIN_LIVE",
					completionResult: "n/a",
					authorization: { tokenValid: false, terminationIntent: "none", intentValid: false },
					readiness: { prior: "ready", current: "ready" },
				});
				expect(repaired.receipt.op).toBe(attempt.pending.op);
				expect(repaired.receipt.durability.state).toBe("proven");
				expect(repaired.receipt.commitment.operationComplete).toBe(true);
				expect(repaired.receipt.commitment.continueEligible).toBe(true);
				expect(JSON.stringify(attempt.pending)).toBe(attempt.snapshot);
				expect(manager.getLeafId()).toBe(view.leafEntryId);
				await manager.flush();
			}
		});
	}

	it("leaves persistent transcript bytes unchanged after failed edit admission and exact rollback", async () => {
		const original = await prompt("original");
		const manager = session.sessionManager;
		await manager.flush();
		const file = manager.getSessionFile()!;
		const bytes = await Bun.file(file).text();
		const view = captureSessionView(session);
		const messages = session.agent.state.messages.slice();
		const getKey = spyOn(registry, "getApiKey").mockRejectedValue(new Error("preflight refused"));
		restores.push(() => getKey.mockRestore());
		await expect(
			reviseSession(session, { sessionId: session.sessionId, entryId: original, body: "revision" }),
		).rejects.toMatchObject({ code: "revision_failed", rollbackFailed: false });
		expect(captureSessionView(session)).toEqual(view);
		expect(session.agent.state.messages).toEqual(messages);
		expect(await Bun.file(file).text()).toBe(bytes);
		expect(model.calls).toHaveLength(1);
	});

	it("does not publish a cursor before asynchronous host admission accepts an edit", async () => {
		const original = await prompt("original");
		const manager = session.sessionManager;
		await manager.flush();
		const file = manager.getSessionFile()!;
		const bytes = await Bun.file(file).text();
		const view = captureSessionView(session);
		const messages = session.agent.state.messages.slice();
		const entries = manager.getEntries();
		const selection = spyOn(session, "selectExecutionBranchDurably");
		restores.push(() => selection.mockRestore());
		await expect(
			reviseSession(
				session,
				{ sessionId: session.sessionId, entryId: original, body: "replacement" },
				{
					onPreflightAcceptCommit: async () => {
						await Promise.resolve();
						expect(await Bun.file(file).text()).toBe(bytes);
						throw new SdkRevisionError("revision_cancelled");
					},
				},
			),
		).rejects.toMatchObject({ code: "revision_cancelled", rollbackFailed: false });
		expect(selection).not.toHaveBeenCalled();
		expect(captureSessionView(session)).toEqual(view);
		expect(session.agent.state.messages).toEqual(messages);
		expect(manager.getEntries()).toEqual(entries);
		expect(await Bun.file(file).text()).toBe(bytes);
		expect(model.calls).toHaveLength(1);
	});

	for (const mutation of ["append", "entry-update", "leaf-roundtrip"] as const) {
		it(`does not suppress ${mutation} interference when an answered selection owns cursor additions`, async () => {
			const original = await prompt("original");
			const answer = session.sessionManager.getLeafId()!;
			await prompt("later turn");
			// Exact presentation leaves no SDK remembered continuation for the old prompt.
			await restoreSessionView(session, target(answer));
			await prompt("other continuation");
			await restoreSessionView(session, target(null));
			await prompt("separate root");
			const manager = session.sessionManager;
			const navigate = session.navigateTree.bind(session);
			let foreignLeaf: string | null = null;
			const navigation = spyOn(session, "navigateTree").mockImplementation(async (id, options) => {
				const result = await navigate(id, options);
				if (mutation === "append") manager.appendCustomEntry("foreign-selection-work", { retained: true });
				if (mutation === "entry-update") {
					const entry = manager.getEntry(original);
					if (entry?.type !== "message" || entry.message.role !== "user")
						throw new Error("Expected original user");
					manager.applyEntryMessageUpdates([
						{ ...entry, message: { ...entry.message, content: "foreign update" } },
					]);
				}
				if (mutation === "leaf-roundtrip") {
					const selected = manager.getLeafId()!;
					manager.branch(answer);
					manager.branch(selected);
				}
				foreignLeaf = manager.getLeafId();
				return result;
			});
			restores.push(() => navigation.mockRestore());
			await expect(
				reviseSession(session, { sessionId: session.sessionId, entryId: original, action: "select" }),
			).rejects.toMatchObject({ code: "resource_gone" });
			expect(manager.getLeafId()).toBe(foreignLeaf);
			if (mutation === "append")
				expect(manager.getEntries().at(-1)).toMatchObject({ customType: "foreign-selection-work" });
			if (mutation === "entry-update")
				expect(manager.getEntry(original)).toMatchObject({ message: { content: "foreign update" } });
			expect(model.calls).toHaveLength(4);
		});
	}

	it("restores the empty root and exact user/nonmessage targets rather than their editor parents", async () => {
		const user = await prompt("retained text");
		const manager = session.sessionManager;
		const marker = manager.appendCustomEntry("view-marker", { marker: true });
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		const entries = manager.getEntries();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted transcript");
		await manager.flush();
		const bytes = await Bun.file(file).text();
		cancelTree = true;
		for (const leaf of [null, user, marker, null]) {
			expect(await restoreSessionView(session, target(leaf))).toEqual(target(leaf));
			expect(manager.getLeafId()).toBe(leaf);
			expect(session.agent.state.messages).toEqual(session.buildDisplaySessionContext().messages);
			if (leaf === null) expect(session.agent.state.messages).toEqual([]);
			if (leaf === user) expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		}
		const rootView = captureSessionView(session);
		await recreate();
		expect(session.agent.state.messages.length).toBeGreaterThan(0);
		await restoreSessionView(session, rootView);
		expect(session.agent.state.messages).toEqual([]);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(await Bun.file(file).text()).toBe(bytes);
		expect(model.calls).toHaveLength(1);
		expect(treeEvents).toEqual([]);
	});

	it("makes a same-leaf restore a true no-op, including a user leaf and null root", async () => {
		const user = session.sessionManager.appendMessage({ role: "user", content: "unanswered", timestamp: 1 });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		for (const leaf of [user, null]) {
			await restoreSessionView(session, target(leaf));
			const lifecycle = session.sessionLifecycle;
			const revisions = session.sessionManager.revisionSnapshot();
			const contextRevision = session.agent.contextRevision;
			expect(await restoreSessionView(session, target(leaf))).toEqual(target(leaf));
			expect(session.sessionLifecycle).toEqual(lifecycle);
			expect(session.sessionManager.revisionSnapshot()).toEqual(revisions);
			expect(session.agent.contextRevision).toBe(contextRevision);
		}
		expect(treeEvents).toEqual([]);
		expect(model.calls).toHaveLength(0);
	});

	it("rejects malformed DTOs, unknown authority, accessors and identifier bounds before mutation", async () => {
		await prompt("unchanged");
		const view = captureSessionView(session);
		const revisions = session.sessionManager.revisionSnapshot();
		const invalid: unknown[] = [
			null,
			undefined,
			[],
			"view",
			{},
			{ sessionId: view.sessionId },
			{ leafEntryId: null },
		];
		for (const sessionId of [
			null,
			"",
			" ",
			"../transcript",
			"x".repeat(129),
			"line\nbreak",
			String.fromCharCode(0xd800),
		])
			invalid.push({ ...view, sessionId });
		for (const leafEntryId of [undefined, 42, "", " ", "x".repeat(129), "line\nbreak", String.fromCharCode(0xdc00)])
			invalid.push({ ...view, leafEntryId });
		invalid.push(
			{ ...view, file: "/untrusted/transcript" },
			{ ...view, summarize: true },
			{ ...view, [Symbol("authority")]: true },
			Object.create(view),
			{
				get sessionId() {
					throw new Error("Must not invoke DTO accessors");
				},
				leafEntryId: null,
			},
		);
		for (const candidate of invalid)
			await expect(restoreSessionView(session, candidate as SdkSessionView)).rejects.toMatchObject({
				code: "invalid_input",
			});
		for (const candidate of [{ ...view, sessionId: "foreign" }, target("missing-entry")])
			await expect(restoreSessionView(session, candidate)).rejects.toMatchObject({ code: "resource_gone" });
		expect(captureSessionView(session)).toEqual(view);
		expect(session.sessionManager.revisionSnapshot()).toEqual(revisions);
		expect(model.calls).toHaveLength(1);
	});

	it("rejects a deleted leaf after recreation rather than selecting a fallback", async () => {
		await prompt("retained");
		const manager = session.sessionManager;
		const marker = manager.appendCustomEntry("deleted-view", {});
		const deletedView = target(marker);
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted transcript");
		await session.dispose();
		const entries = Bun.JSONL.parse(await Bun.file(file).text());
		await Bun.write(
			file,
			`${entries
				.filter(entry => !entry || typeof entry !== "object" || !("id" in entry) || entry.id !== marker)
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		session = await createSession(await SessionManager.open(file, path.dirname(file)));
		const active = captureSessionView(session);
		await expect(restoreSessionView(session, deletedView)).rejects.toMatchObject({ code: "resource_gone" });
		expect(captureSessionView(session)).toEqual(active);
		expect(model.calls).toHaveLength(1);
	});

	it("refuses streaming and pending admission without aborting or running tree hooks", async () => {
		const user = await prompt("original");
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<MockResponse>();
		model.push(async () => {
			started.resolve();
			return response.promise;
		});
		const pending = session.prompt("independent");
		try {
			await started.promise;
			const leaf = session.sessionManager.getLeafId();
			expect(() => captureSessionView(session)).toThrow(SdkRevisionError);
			await expect(restoreSessionView(session, target(user))).rejects.toMatchObject({ code: "busy" });
			await expect(session.restoreTreeLeaf(user)).rejects.toMatchObject({ code: "busy" });
			expect(session.isStreaming).toBe(true);
			expect(session.sessionManager.getLeafId()).toBe(leaf);
		} finally {
			response.resolve({ content: ["independent completion"] });
			await pending;
			await session.waitForIdle();
		}
		const barrier = Promise.withResolvers<void>();
		session.extendStartupTurnBarrier(barrier.promise);
		const admission = session.prompt("pending admission");
		try {
			await expect(restoreSessionView(session, target(user))).rejects.toMatchObject({ code: "busy" });
		} finally {
			barrier.resolve();
			await admission;
			await session.waitForIdle();
		}
		expect(treeEvents).toEqual([]);
	});

	it("refuses disposed sessions and captures during native transitions", async () => {
		const user = await prompt("original");
		const view = captureSessionView(session);
		const pending = session.navigateTree(user);
		try {
			expect(session.sessionLifecycle.transitioning).toBe(true);
			expect(() => captureSessionView(session)).toThrow(SdkRevisionError);
			await expect(restoreSessionView(session, view)).rejects.toMatchObject({ code: "busy" });
			await expect(session.restoreTreeLeaf(view.leafEntryId)).rejects.toMatchObject({ code: "busy" });
		} finally {
			await pending;
		}
		await session.dispose();
		expect(() => captureSessionView(session)).toThrow(SdkRevisionError);
		await expect(restoreSessionView(session, view)).rejects.toMatchObject({ code: "resource_gone" });
		await expect(session.restoreTreeLeaf(view.leafEntryId)).rejects.toMatchObject({ code: "resource_gone" });
	});

	it("serializes restores against revisions and prompts while rebuilding MCP context", async () => {
		const { old, previous } = await seedMcpBranches();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		rebuild = async names => {
			entered.resolve();
			await release.promise;
			return { systemPrompt: [`tools:${names.join(",")}`] };
		};
		const pending = restoreSessionView(session, target(old));
		try {
			await entered.promise;
			expect(() => captureSessionView(session)).toThrow(SdkRevisionError);
			await expect(restoreSessionView(session, target(previous))).rejects.toMatchObject({ code: "busy" });
			await expect(
				reviseSession(session, { sessionId: session.sessionId, entryId: old, body: "competing" }),
			).rejects.toMatchObject({ code: "busy" });
			await expect(session.navigateTree(previous)).rejects.toMatchObject({ code: "busy" });
			await expect(session.prompt("competing prompt")).rejects.toMatchObject({ code: "busy" });
		} finally {
			release.resolve();
			await pending;
		}
		expect(session.getActiveToolNames()).toEqual([MCP_TOOL]);
		expect(session.agent.state.messages).toEqual(session.buildDisplaySessionContext().messages);
		expect(model.calls).toHaveLength(0);
		expect(treeEvents).toEqual([]);
	});

	it("refuses restore while a revision owns preparation before acquiring the native transition", async () => {
		const original = await prompt("original");
		await prompt("continuation");
		const view = captureSessionView(session);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const navigate = session.navigateTree.bind(session);
		const navigation = spyOn(session, "navigateTree").mockImplementation(async (id, options) => {
			entered.resolve();
			await release.promise;
			return navigate(id, options);
		});
		restores.push(() => navigation.mockRestore());
		const pending = reviseSession(session, { sessionId: session.sessionId, entryId: original, action: "select" });
		try {
			await Promise.race([
				entered.promise,
				pending.then(() => {
					throw new Error("Revision settled before navigation admission");
				}),
			]);
			expect(session.sessionLifecycle.transitioning).toBe(false);
			expect(() => captureSessionView(session)).toThrow(SdkRevisionError);
			await expect(restoreSessionView(session, view)).rejects.toMatchObject({ code: "busy" });
		} finally {
			release.resolve();
			await pending;
		}
		expect(captureSessionView(session)).toEqual(view);
		expect(model.calls).toHaveLength(2);
	});

	it("rolls back a failed edit to the exact user leaf without invoking rollback tree hooks or appending", async () => {
		const manager = session.sessionManager;
		const user = manager.appendMessage({ role: "user", content: "unanswered", timestamp: 1 });
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected transcript");
		const transcript = await Bun.file(file).text();
		const entries = manager.getEntries();
		const messages = session.agent.state.messages.slice();
		await expect(
			reviseSession(
				session,
				{ sessionId: session.sessionId, entryId: user, body: "replacement" },
				{
					onPreflightAcceptCommit: () => {
						cancelTree = true;
						throw new Error("private preflight failure");
					},
				},
			),
		).rejects.toMatchObject({ code: "revision_failed", rollbackFailed: false });
		expect(manager.getLeafId()).toBe(user);
		expect(session.agent.state.messages).toEqual(messages);
		expect(manager.getEntries()).toEqual(entries);
		await manager.flush();
		expect(await Bun.file(file).text()).toBe(transcript);
		expect(treeEvents).toEqual(["before", "after"]);
		expect(model.calls).toHaveLength(0);
	});

	for (const interference of ["entry-update", "selection-roundtrip"] as const) {
		it(`does not roll back a failed edit over ${interference} from its preflight callback`, async () => {
			const manager = session.sessionManager;
			const user = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			session.agent.replaceMessages(manager.buildSessionContext().messages);
			await expect(
				reviseSession(
					session,
					{ sessionId: session.sessionId, entryId: user, body: "replacement" },
					{
						onPreflightAcceptCommit: () => {
							if (interference === "selection-roundtrip") {
								manager.branch(user);
								manager.resetLeaf();
							} else {
								const entry = manager.getEntry(user);
								if (entry?.type !== "message" || entry.message.role !== "user")
									throw new Error("Expected user entry");
								manager.applyEntryMessageUpdates([
									{ ...entry, message: { ...entry.message, content: "foreign edit" } },
								]);
							}
							throw new Error("preflight failed after foreign mutation");
						},
					},
				),
			).rejects.toMatchObject({ code: "revision_failed", rollbackFailed: false });
			expect(manager.getLeafId()).toBeNull();
			expect(session.agent.state.messages).toEqual([]);
			if (interference === "entry-update")
				expect(manager.getEntry(user)).toMatchObject({ message: { content: "foreign edit" } });
			expect(model.calls).toHaveLength(0);
		});
	}

	for (const failureAt of ["rebuild", "messages"] as const) {
		it(`restores live tools, prompts and selection authority after ${failureAt} publication failure`, async () => {
			const { previous } = await seedMcpBranches();
			await session.setActiveToolsByName([MCP_TOOL], { persistMCPSelection: false });
			const manager = session.sessionManager;
			const messages = session.agent.state.messages.slice();
			const tools = session.agent.state.tools.slice();
			session.agent.setSystemPrompt(["live prompt overlay"]);
			const entries = manager.getEntries();
			await manager.ensureOnDisk();
			await manager.flush();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected persisted transcript");
			const transcript = await Bun.file(file).text();
			if (failureAt === "rebuild") {
				rebuild = async () => {
					throw new Error("private-token /private/provider-path");
				};
			} else {
				const replace = spyOn(session.agent, "replaceMessages").mockImplementationOnce(() => {
					expect(session.getActiveToolNames()).toEqual([]);
					throw new Error("context publication failed");
				});
				restores.push(() => replace.mockRestore());
			}
			let observed: unknown;
			try {
				await restoreSessionView(session, target(null));
			} catch (error) {
				observed = error;
			}
			expect(observed).toBeInstanceOf(SdkRevisionError);
			expect(observed).toMatchObject({ code: "revision_failed", rollbackFailed: false });
			expect(String(observed)).not.toContain("private-token");
			expect(String(observed)).not.toContain("provider-path");
			expect(captureSessionView(session)).toEqual(target(previous));
			expect(session.agent.state.messages).toEqual(messages);
			expect(session.agent.state.tools[0]).toBe(tools[0]);
			expect(session.getActiveToolNames()).toEqual([MCP_TOOL]);
			expect(session.getSelectedMCPToolNames()).toEqual([MCP_TOOL]);
			expect(session.systemPrompt).toEqual(["live prompt overlay"]);
			expect(manager.buildSessionContext().selectedMCPToolNames).toEqual([]);
			await session.refreshMCPTools([lookupTool]);
			expect(session.getActiveToolNames()).toEqual([MCP_TOOL]);
			expect(manager.getEntries()).toEqual(entries);
			await manager.flush();
			expect(await Bun.file(file).text()).toBe(transcript);
			expect(model.calls).toHaveLength(0);
			expect(treeEvents).toEqual([]);
		});
	}

	it("does not resurrect snapshotted MCP tools after a catalog change during a failed rebuild", async () => {
		await seedMcpBranches();
		await session.setActiveToolsByName([MCP_TOOL], { persistMCPSelection: false });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let rebuilds = 0;
		rebuild = async names => {
			if (++rebuilds === 1) {
				entered.resolve();
				await release.promise;
				throw new Error("superseded rebuild failed");
			}
			return { systemPrompt: [`tools:${names.join(",")}`] };
		};
		const pending = restoreSessionView(session, target(null));
		void pending.catch(() => {});
		try {
			await entered.promise;
			await session.refreshMCPTools([], { persistMCPSelection: false });
			const entries = session.sessionManager.getEntries();
			const messages = session.agent.state.messages.slice();
			const systemPrompt = session.systemPrompt.slice();
			release.resolve();
			await expect(pending).rejects.toMatchObject({ code: "resource_gone", rollbackFailed: false });
			expect(session.sessionManager.getLeafId()).toBeNull();
			expect(session.sessionManager.getEntries()).toEqual(entries);
			expect(session.agent.state.messages).toEqual(messages);
			expect(session.getActiveToolNames()).toEqual([]);
			expect(session.getSelectedMCPToolNames()).toEqual([]);
			expect(session.systemPrompt).toEqual(systemPrompt);
			expect(model.calls).toHaveLength(0);
			expect(treeEvents).toEqual([]);
		} finally {
			release.resolve();
			await pending.catch(() => {});
		}
	});

	it("rolls back to an actual empty previous root after a post-transition failure", async () => {
		const user = await prompt("retained");
		await restoreSessionView(session, target(null));
		const replace = spyOn(session.agent, "replaceMessages").mockImplementationOnce(() => {
			throw new Error("publication failed");
		});
		restores.push(() => replace.mockRestore());
		await expect(restoreSessionView(session, target(user))).rejects.toMatchObject({
			code: "revision_failed",
			rollbackFailed: false,
		});
		expect(captureSessionView(session)).toEqual(target(null));
		expect(session.agent.state.messages).toEqual([]);
	});

	it("reports rollback failure explicitly", async () => {
		const { old } = await seedMcpBranches();
		rebuild = async () => {
			throw new Error("context restoration unavailable");
		};
		const branch = session.sessionManager.branch.bind(session.sessionManager);
		let count = 0;
		const selection = spyOn(session.sessionManager, "branch").mockImplementation(id => {
			if (++count === 2) throw new Error("rollback selection failed");
			branch(id);
		});
		restores.push(() => selection.mockRestore());
		await expect(restoreSessionView(session, target(old))).rejects.toMatchObject({
			code: "revision_failed",
			rollbackFailed: true,
		});
		expect(session.sessionLifecycle.transitioning).toBe(false);
		expect(model.calls).toHaveLength(0);
	});

	for (const interference of [
		"append",
		"selection-roundtrip",
		"tool-selection",
		"agent-history",
		"successor",
		"identity",
		"dispose",
	] as const) {
		it(`rejects ${interference} during awaited MCP restoration without overwriting foreign state`, async () => {
			const { old, previous } = await seedMcpBranches();
			if (interference === "tool-selection") await session.setActiveToolsByName([], { persistMCPSelection: false });
			const manager = session.sessionManager;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const initialPrompt = session.systemPrompt;
			rebuild = async () => {
				entered.resolve();
				await release.promise;
				return { systemPrompt: ["must not publish stale prompt"] };
			};
			const pending = restoreSessionView(session, target(old));
			void pending.catch(() => {});
			await entered.promise;
			let successor: SessionManager | undefined;
			let disposal: Promise<void> | undefined;
			try {
				if (interference === "append") manager.appendCustomEntry("foreign-work", { retained: true });
				if (interference === "tool-selection")
					await session.setActiveToolsByName([], { persistMCPSelection: false });
				if (interference === "selection-roundtrip") {
					manager.branch(previous);
					manager.branch(old);
				}
				if (interference === "agent-history")
					session.agent.appendMessage({ role: "user", content: "foreign agent work", timestamp: 3 });
				if (interference === "successor") {
					successor = SessionManager.inMemory(dir.path());
					successor.appendMessage({ role: "user", content: "successor sentinel", timestamp: 3 });
					session.sessionManager = successor;
				}
				if (interference === "identity") await manager.newSession();
				if (interference === "dispose") disposal = session.dispose();
				const active = session.sessionManager;
				const entries = active.getEntries();
				const leaf = active.getLeafId();
				const messages = session.agent.state.messages.slice();
				release.resolve();
				await expect(pending).rejects.toMatchObject({ code: "resource_gone", rollbackFailed: false });
				if (interference === "dispose") {
					await disposal;
					expect(session.sessionLifecycle.disposed).toBe(true);
				} else {
					expect(active.getLeafId()).toBe(leaf);
					expect(active.getEntries()).toEqual(entries);
				}
				expect(session.agent.state.messages).toEqual(messages);
				expect(session.systemPrompt).toEqual(initialPrompt);
				expect(session.getActiveToolNames()).toEqual([]);
				expect(model.calls).toHaveLength(0);
			} finally {
				release.resolve();
				await pending.catch(() => {});
				if (successor) {
					session.sessionManager = manager;
					await successor.close();
				}
				await disposal;
			}
		});
	}

	for (const mutation of ["append", "entry-update"] as const) {
		it(`revalidates ${mutation} after native completion without rolling back later work`, async () => {
			const user = await prompt("original");
			const native = session.restoreTreeLeaf.bind(session);
			const restore = spyOn(session, "restoreTreeLeaf").mockImplementation(async leaf => {
				await native(leaf);
				if (mutation === "append") {
					session.sessionManager.appendCustomEntry("later-work", { retained: true });
				} else {
					const entry = session.sessionManager.getEntry(user);
					if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("Expected user entry");
					session.sessionManager.applyEntryMessageUpdates([
						{ ...entry, message: { ...entry.message, content: "foreign updated text" } },
					]);
				}
			});
			restores.push(() => restore.mockRestore());
			await expect(restoreSessionView(session, target(user))).rejects.toMatchObject({ code: "resource_gone" });
			if (mutation === "append") {
				expect(session.sessionManager.getEntries().at(-1)).toMatchObject({
					type: "custom",
					customType: "later-work",
				});
			} else {
				expect(session.sessionManager.getEntry(user)).toMatchObject({
					message: { content: "foreign updated text" },
				});
			}
			expect(model.calls).toHaveLength(1);
		});
	}
});
