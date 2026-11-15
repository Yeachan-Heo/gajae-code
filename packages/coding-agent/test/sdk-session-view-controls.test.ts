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
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
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
				api.on("session_before_tree", () => {
					treeEvents.push("before");
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
		treeEvents = [];
		rebuild = async names => ({ systemPrompt: [`tools:${names.join(",")}`] });
		session = await createSession(SessionManager.create(dir.path(), path.join(dir.path(), "sessions")));
	});

	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		for (const created of sessions.splice(0)) await created.dispose();
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

	it("restores old, revised and continued views across actual disposal and recreation, not append chronology", async () => {
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
		await reviseSession(session, { sessionId: session.sessionId, entryId: original, action: "select" });
		expect(captureSessionView(session)).toEqual(oldContinued);
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
			// The manager deliberately resumes the last chronological entry, even
			// when the previously viewed branch was older. The DTO supplies intent.
			expect(captureSessionView(session)).toEqual(revisedContinued);
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

	it("restores the empty root and exact user/nonmessage targets without editor-parent semantics", async () => {
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
			const view = target(leaf);
			expect(await restoreSessionView(session, view)).toEqual(view);
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

	it("rejects malformed DTOs, extra authority, unknown fields and identifier bounds before mutation", async () => {
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
		expect(captureSessionView(session)).toEqual(view);
		expect(session.sessionManager.revisionSnapshot()).toEqual(revisions);
		expect(model.calls).toHaveLength(1);
	});

	it("rejects mismatched identities and missing or deleted entries rather than falling back", async () => {
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
		for (const view of [{ ...active, sessionId: "another-session" }, target("missing-entry"), deletedView])
			await expect(restoreSessionView(session, view)).rejects.toMatchObject({ code: "resource_gone" });
		expect(captureSessionView(session)).toEqual(active);
		expect(model.calls).toHaveLength(1);
	});

	it("refuses busy streaming and pending admissions without aborting or calling tree hooks", async () => {
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

	it("refuses disposed sessions and captures during a native transition", async () => {
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

	it("serializes restores against revisions while MCP context is staged and holds the native lease", async () => {
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
			expect(session.sessionManager.getLeafId()).toBe(old);
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

	it("refuses restore while a revision owns preparation before acquiring the native lease", async () => {
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
			await entered.promise;
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

	it("restores the previous leaf and context after MCP rebuild failure without exposing internal errors", async () => {
		const { old, previous } = await seedMcpBranches();
		const entries = session.sessionManager.getEntries();
		const messages = session.agent.state.messages.slice();
		rebuild = async names => {
			if (names.includes(MCP_TOOL)) throw new Error("private-token /private/provider-path");
			return { systemPrompt: ["previous context"] };
		};
		let observed: unknown;
		try {
			await restoreSessionView(session, target(old));
		} catch (error) {
			observed = error;
		}
		expect(observed).toBeInstanceOf(SdkRevisionError);
		expect(observed).toMatchObject({ code: "revision_failed", rollbackFailed: false });
		expect(String(observed)).not.toContain("private-token");
		expect(String(observed)).not.toContain("provider-path");
		expect(session.sessionManager.getLeafId()).toBe(previous);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(session.agent.state.messages).toEqual(messages);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.sessionLifecycle.transitioning).toBe(false);
	});

	it("restores unpersisted live tools, prompts and selection authority after a one-shot rebuild failure", async () => {
		const { previous } = await seedMcpBranches();
		await session.setActiveToolsByName([MCP_TOOL], { persistMCPSelection: false });
		const manager = session.sessionManager;
		const messages = session.agent.state.messages.slice();
		const tools = session.agent.state.tools.slice();
		const basePrompt = session.systemPrompt.slice();
		session.agent.setSystemPrompt(["live prompt overlay"]);
		const entries = manager.getEntries();
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted transcript");
		const transcript = await Bun.file(file).text();
		let rebuilds = 0;
		rebuild = async names => {
			if (++rebuilds === 1) throw new Error("one-shot rebuild failure");
			return { systemPrompt: [`tools:${names.join(",")}`] };
		};

		await expect(restoreSessionView(session, target(null))).rejects.toMatchObject({
			code: "revision_failed",
			rollbackFailed: false,
		});
		expect(rebuilds).toBe(1);
		expect(captureSessionView(session)).toEqual(target(previous));
		expect(session.agent.state.messages).toEqual(messages);
		expect(session.getActiveToolNames()).toEqual([MCP_TOOL]);
		expect(session.getSelectedMCPToolNames()).toEqual([MCP_TOOL]);
		expect(session.agent.state.tools[0]).toBe(tools[0]);
		expect(session.systemPrompt).toEqual(["live prompt overlay"]);
		expect(manager.buildSessionContext().selectedMCPToolNames).toEqual([]);
		expect(manager.getEntries()).toEqual(entries);
		expect(await Bun.file(file).text()).toBe(transcript);
		expect(model.calls).toHaveLength(0);
		expect(treeEvents).toEqual([]);

		// Catalog reconciliation must retain the live explicit authority, including
		// its non-persisting policy, rather than falling back to the empty transcript.
		await session.refreshMCPTools([lookupTool]);
		expect(session.getActiveToolNames()).toEqual([MCP_TOOL]);
		expect(session.getSelectedMCPToolNames()).toEqual([MCP_TOOL]);
		expect(manager.getEntries()).toEqual(entries);
		await manager.flush();
		expect(await Bun.file(file).text()).toBe(transcript);
		expect(model.calls).toHaveLength(0);
		await prompt("continue with live selection");
		expect(session.getActiveToolNames()).toEqual([MCP_TOOL]);
		expect(session.systemPrompt).toEqual(basePrompt);
		expect(manager.buildSessionContext().selectedMCPToolNames).toEqual([]);
		expect(model.calls).toHaveLength(1);
	});

	it("restores live MCP state after target tools and prompt were already published", async () => {
		const { previous } = await seedMcpBranches();
		await session.setActiveToolsByName([MCP_TOOL], { persistMCPSelection: false });
		const messages = session.agent.state.messages.slice();
		const tools = session.agent.state.tools.slice();
		const systemPrompt = session.systemPrompt.slice();
		const entries = session.sessionManager.getEntries();
		const replace = spyOn(session.agent, "replaceMessages").mockImplementationOnce(() => {
			expect(session.getActiveToolNames()).toEqual([]);
			expect(session.systemPrompt).toEqual(["tools:"]);
			throw new Error("context publication failed");
		});
		restores.push(() => replace.mockRestore());
		await expect(restoreSessionView(session, target(null))).rejects.toMatchObject({
			code: "revision_failed",
			rollbackFailed: false,
		});
		expect(captureSessionView(session)).toEqual(target(previous));
		expect(session.agent.state.messages).toEqual(messages);
		expect(session.agent.state.tools[0]).toBe(tools[0]);
		expect(session.systemPrompt).toEqual(systemPrompt);
		expect(session.getSelectedMCPToolNames()).toEqual([MCP_TOOL]);
		await session.refreshMCPTools([lookupTool]);
		expect(session.getActiveToolNames()).toEqual([MCP_TOOL]);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(model.calls).toHaveLength(0);
		expect(treeEvents).toEqual([]);
	});

	it("does not resurrect snapshotted MCP tools when the catalog changes during a failed rebuild", async () => {
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

	it("rolls back to an actual empty previous root after a post-transition context failure", async () => {
		const user = await prompt("retained");
		await restoreSessionView(session, target(null));
		const replace = spyOn(session.agent, "replaceMessages").mockImplementationOnce(() => {
			throw new Error("context publication failed");
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

	it("reports failure when the snapshotted live prompt cannot be restored", async () => {
		await seedMcpBranches();
		await session.setActiveToolsByName([MCP_TOOL], { persistMCPSelection: false });
		rebuild = async () => {
			throw new Error("target rebuild failed");
		};
		const setPrompt = spyOn(session.agent, "setSystemPrompt").mockImplementationOnce(() => {
			throw new Error("rollback prompt publication failed");
		});
		restores.push(() => setPrompt.mockRestore());
		await expect(restoreSessionView(session, target(null))).rejects.toMatchObject({
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
			// Attach a handler while the rebuild is held; assert only after releasing it.
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
				expect(session.sessionManager.getLeafId()).not.toBe(user);
				expect(session.sessionManager.getEntries().at(-1)).toMatchObject({
					type: "custom",
					customType: "later-work",
				});
			} else {
				expect(session.sessionManager.getLeafId()).toBe(user);
				expect(session.sessionManager.getEntry(user)).toMatchObject({
					message: { content: "foreign updated text" },
				});
			}
			expect(model.calls).toHaveLength(1);
		});
	}
});
