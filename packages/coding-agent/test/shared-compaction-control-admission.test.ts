import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { CompactionCancelledError } from "@gajae-code/agent-core/compaction";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel, modelSupportsMaintenanceCalls } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import * as skillState from "../src/skill-state/active-state";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const stores: AuthStorage[] = [];
const registries: ModelRegistry[] = [];

const user = (content: string, timestamp = 1) => ({ role: "user" as const, content, timestamp });

async function sessionFixture() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-compaction-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model || !modelSupportsMaintenanceCalls(model)) throw new Error("Expected maintenance-capable bundled model");

	const extensionsDir = path.join(root, "extensions");
	await fs.mkdir(extensionsDir, { recursive: true });
	const extensionPath = path.join(extensionsDir, "compaction.ts");
	await Bun.write(
		extensionPath,
		[
			"export default function(pi) {",
			'\tpi.on("session_before_compact", async (event) => ({',
			'\t\tcompaction: { summary: "shared-hook-summary", shortSummary: undefined,',
			"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
			"\t\t\ttokensBefore: event.preparation.tokensBefore, details: {} },",
			"\t}));",
			"}",
		].join("\n"),
	);
	const loaded = await loadExtensions([extensionPath], cwd);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, registry);

	// Each completed turn has a genuine assistant record, so preparation can choose a
	// first kept entry and the hook can summarize a nonempty older prefix.
	for (let index = 0; index < 8; index++) {
		manager.appendMessage(user(`older turn ${index} ${"historical context ".repeat(1200)}`, index * 2 + 1));
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `completed turn ${index}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: index * 2 + 2,
		} satisfies AssistantMessage);
	}
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({
			"compaction.enabled": true,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"todo.reminders": false,
		}),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	sessions.push(session);
	return { manager, session, file, destination, runner };
}

async function fixture() {
	const base = await sessionFixture();
	// The latched bar is the layer's one remaining entry (single-owner step 10a); these cases go with
	// the layer in steps 10b-10e.
	const shared = await base.manager.appendMessageSharingSession(user("root shared canonical turn", 100));
	if (shared.kind !== "committed") throw new Error(`Could not admit root shared append: ${shared.kind}`);
	return { ...base, shared };
}

async function withinBarrier<T>(pending: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${phase}`)), 1500);
	try {
		return await Promise.race([pending, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

afterEach(async () => {
	const ownedRoots = roots.splice(0);
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const store of stores.splice(0)) store.close();
	for (const root of ownedRoots) await fs.rm(root, { recursive: true, force: true });
});

describe("opted-in managed shared compaction control", () => {
	it("compacts at the shared threshold without rewriting prunable tool output or peer history", async () => {
		const { manager, session, file, destination } = await fixture();
		for (let index = 0; index < 18; index++) {
			expect(
				await manager.appendMessageSharingSession({
					role: "toolResult",
					toolCallId: `prunable-${index}`,
					toolName: "read",
					content: [{ type: "text", text: "output ".repeat(2000) }],
					isError: false,
					timestamp: 101 + index,
				}),
			).toMatchObject({ kind: "committed" });
		}
		for (const content of ["recent turn", "latest turn"])
			expect(await manager.appendMessageSharingSession(user(content))).toMatchObject({ kind: "committed" });
		const previous = manager.buildSessionContext().messages.findLast(message => message.role === "assistant");
		if (!previous) throw new Error("Missing fixture assistant");
		expect(
			await manager.appendMessageSharingSession({
				...previous,
				usage: { ...previous.usage, input: 187_000, output: 1000, totalTokens: 188_000 },
			}),
		).toMatchObject({ kind: "committed" });
		const peer = await SessionManager.open(file, destination);
		managers.push(peer);
		const peerEntry = await peer.appendMessageSharingSession(user("peer retained across maintenance"));
		expect(peerEntry.kind).toBe("committed");
		const before = await Bun.file(file).text();
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		session.settings.set("compaction.thresholdTokens", 187_000);
		const rewrite = vi.spyOn(manager, "rewriteEntries");
		expect(
			await session.runMidRunMaintenanceForTests({
				systemPrompt: session.state.systemPrompt,
				messages: [...session.messages],
				tools: [],
			}),
		).toBe("compacted");
		expect(rewrite).not.toHaveBeenCalled();
		expect((await Bun.file(file).text()).startsWith(before)).toBe(true);
		expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
		expect(
			manager
				.getBranch()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "peer retained across maintenance",
				),
		).toBe(false);
	});
	it("runIdleCompaction commits a real context-full summary and rebuilds live context", async () => {
		const { manager, session, file } = await fixture();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await session.runIdleCompaction();
		const started = events.filter(event => event.type === "auto_compaction_start");
		expect(started).toEqual([{ type: "auto_compaction_start", reason: "idle", action: "context-full" }]);
		const ended = events.filter(event => event.type === "auto_compaction_end");
		expect(ended).toHaveLength(1);
		const end = ended[0];
		if (end?.type !== "auto_compaction_end") throw new Error("Missing terminal compaction event");
		expect(end).toMatchObject({ action: "context-full", aborted: false });
		expect(end).toMatchObject({ result: { summary: expect.stringContaining("shared-hook-summary") } });
		const committed = manager.getBranch().findLast(entry => entry.type === "compaction");
		expect(committed?.type === "compaction" && committed.summary).toContain("shared-hook-summary");
		expect((await Bun.file(file).text()).includes('"type":"compaction"')).toBe(true);
		expect(
			session.agent.state.messages.some(
				message => message.role === "user" && message.content === "root shared canonical turn",
			),
		).toBe(true);
	});

	it("compact manually persists a summary without erasing a peer branch", async () => {
		const { manager, session, file, destination } = await fixture();
		const peer = await SessionManager.open(file, destination);
		managers.push(peer);
		const peerAppend = await peer.appendMessageSharingSession(user("peer branch must survive", 101));
		expect(peerAppend.kind).toBe("committed");
		const before = await Bun.file(file).text();
		const result = await session.compact();
		expect(result.summary).toContain("shared-hook-summary");
		const after = await Bun.file(file).text();
		expect(after.startsWith(before)).toBe(true);
		expect(after).toContain("peer branch must survive");
		expect(after).toContain('"type":"compaction"');
		expect(
			session.agent.state.messages.some(
				message => message.role === "user" && message.content === "root shared canonical turn",
			),
		).toBe(true);
		expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("orders a thinking control behind an already started compaction publication", async () => {
		const { manager, session } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = manager.captureCommittedSnapshot.bind(manager);
		let held = false;
		vi.spyOn(manager, "captureCommittedSnapshot").mockImplementation(async () => {
			if (!held) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return original();
		});
		const compacting = session.compact();
		void compacting.catch(() => {});
		let thinking: Promise<void> | undefined;
		try {
			await withinBarrier(entered.promise, "started compaction publication");
			thinking = session.setThinkingLevelForControl(ThinkingLevel.High, false);
			release.resolve();
			await withinBarrier(compacting, "compaction before thinking");
			await withinBarrier(thinking, "thinking after compaction");
			const branch = manager.getBranch();
			const compaction = branch.findLast(entry => entry.type === "compaction");
			const thinkingEntry = branch.findLast(entry => entry.type === "thinking_level_change");
			expect(compaction?.type).toBe("compaction");
			expect(thinkingEntry?.parentId).toBe(compaction?.id);
		} finally {
			release.resolve();
			await Promise.allSettled([compacting, ...(thinking ? [thinking] : [])]);
		}
	});

	it("cancels a manual compaction waiting for shared admission without a late append", async () => {
		const { manager, session, file } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = manager.captureCommittedSnapshot.bind(manager);
		vi.spyOn(manager, "captureCommittedSnapshot").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return original();
		});
		const pending = session.compact();
		void pending.catch(() => {});
		try {
			await withinBarrier(entered.promise, "shared compaction lease read");
			session.abortCompaction();
		} finally {
			release.resolve();
		}
		await expect(withinBarrier(pending, "cancelled shared compaction")).rejects.toThrow();
		expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
		expect((await Bun.file(file).text()).includes('"type":"compaction"')).toBe(false);
	});

	for (const change of ["model", "context"] as const) {
		it(`manual compaction retains invocation ${change} ownership while aborting`, async () => {
			const { manager, session, file } = await fixture();
			const before = await Bun.file(file).text();
			const original = session.abort.bind(session);
			vi.spyOn(session, "abort").mockImplementation(async options => {
				await original(options);
				if (options?.cause !== "compaction") return;
				if (change === "model") {
					const next = getBundledModel("anthropic", "claude-sonnet-4-6");
					if (!next) throw new Error("Missing distinct bundled model");
					session.agent.setModel(next);
				} else {
					const model = session.model;
					const scope = session.beginTemporaryProviderSessionScope("other");
					expect(await session.restoreTemporaryProviderSessionScope(scope)).toBe(true);
					expect(session.model).toBe(model);
				}
			});
			await expect(session.compact()).rejects.toBeInstanceOf(CompactionCancelledError);
			expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
			expect(await Bun.file(file).text()).toBe(before);
			expect(session.agent.state.messages.some(message => message.role === "compactionSummary")).toBe(false);
		});
	}

	for (const control of ["manual", "idle"] as const) {
		it(`${control} compaction rejects ownership changed during state snapshot`, async () => {
			const { manager, session, file } = await fixture();
			const next = getBundledModel("anthropic", "claude-sonnet-4-6");
			if (!next) throw new Error("Missing distinct bundled model");
			const before = await Bun.file(file).text();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const original = skillState.readVisibleSkillActiveState;
			vi.spyOn(skillState, "readVisibleSkillActiveState").mockImplementation(async (...args) => {
				entered.resolve();
				await release.promise;
				return original(...args);
			});
			const pending = control === "manual" ? session.compact() : session.runIdleCompaction();
			const settled = pending.then(
				() => "completed",
				() => "rejected",
			);
			try {
				await withinBarrier(entered.promise, "compaction state snapshot");
				session.agent.setModel(next);
			} finally {
				release.resolve();
			}
			const result = await withinBarrier(settled, "superseded compaction");
			expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
			expect(await Bun.file(file).text()).toBe(before);
			expect(session.model).toEqual(next);
			expect(session.agent.state.messages.some(message => message.role === "compactionSummary")).toBe(false);
			if (control === "manual") expect(result).toBe("rejected");
		});
	}

	for (const control of ["manual", "idle"] as const) {
		it(`${control} suppresses stale live effects after its committed cursor advances`, async () => {
			const { manager, session } = await fixture();
			const original = manager.appendCompactionSharingSession.bind(manager);
			const liveBefore = [...session.agent.state.messages];
			vi.spyOn(manager, "appendCompactionSharingSession").mockImplementation(async (payload, current) => {
				const outcome = await original(payload, current);
				if (outcome.kind === "committed") {
					const append = await manager.appendMessageSharingSession(user("late owner message", 303));
					expect(append.kind).toBe("committed");
				}
				return outcome;
			});
			const events: AgentSessionEvent[] = [];
			session.subscribe(event => events.push(event));
			if (control === "manual") await expect(session.compact()).rejects.toBeInstanceOf(CompactionCancelledError);
			else {
				await session.runIdleCompaction();
				expect(events.findLast(event => event.type === "auto_compaction_end")).toMatchObject({
					aborted: true,
					result: undefined,
				});
			}
			expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
			expect(session.agent.state.messages).toEqual(liveBefore);
		});
	}

	it("does not classify a committed successor hook's unknown cause as publication uncertainty", async () => {
		const { manager, session, runner } = await fixture();
		const original = runner.emit.bind(runner);
		const failure = new Error("post-commit hook failed", {
			cause: { kind: "unknown", id: "unrelated-hook-attempt", error: new Error("hook-side-effect") },
		});
		vi.spyOn(runner, "emit").mockImplementation(async event => {
			if (event.type === "session_compact") throw failure;
			return original(event);
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await session.runIdleCompaction();
		const end = events.findLast(event => event.type === "auto_compaction_end");
		expect(end).toMatchObject({
			result: undefined,
			errorMessage: expect.stringContaining("post-commit hook failed"),
		});
		if (end?.type !== "auto_compaction_end") throw new Error("Missing failure event");
		expect(end.publicationError).toBeUndefined();
		expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(session.agent.state.messages.some(message => message.role === "compactionSummary")).toBe(true);
	});

	for (const cancelled of [false, true]) {
		it(`reports uncertain automatic publication with attempted ID and no live success (cancelled=${cancelled})`, async () => {
			const { manager, session, file } = await fixture();
			const original = manager.captureCommittedSnapshot.bind(manager);
			const failure = new Error("verification failed after shared compaction append");
			let reads = 0;
			vi.spyOn(manager, "captureCommittedSnapshot").mockImplementation(async () => {
				if (++reads === 2) {
					if (cancelled) session.abortCompaction();
					throw failure;
				}
				return original();
			});
			const events: AgentSessionEvent[] = [];
			session.subscribe(event => events.push(event));
			await session.runIdleCompaction();
			const end = events.findLast(event => event.type === "auto_compaction_end");
			expect(end).toMatchObject({
				aborted: false,
				willRetry: false,
				result: undefined,
				publicationError: { cause: { kind: "unknown", error: failure } },
			});
			if (end?.type !== "auto_compaction_end") throw new Error("Missing failure event");
			const error = end.publicationError as Error;
			const outcome = error.cause as { kind: string; id: string; error: unknown };
			expect(end.errorMessage).toContain(outcome.id);
			expect(outcome.error).toBe(failure);
			expect((await Bun.file(file).text()).split('"type":"compaction"')).toHaveLength(2);
			expect(session.agent.state.messages.some(message => message.role === "compactionSummary")).toBe(false);
		});
	}

	for (const control of ["manual", "idle"] as const) {
		it(`${control} shared compaction replaces old live context without rewriting peer history`, async () => {
			const { manager, session, file, destination, shared } = await fixture();
			const peer = await SessionManager.open(file, destination);
			managers.push(peer);
			const peerFirst = await peer.appendMessageSharingSession(user("peer pre-compaction branch", 101));
			expect(peerFirst.kind).toBe("committed");
			if (peerFirst.kind !== "committed") throw new Error(`Peer admission: ${peerFirst.kind}`);
			const rootCursor = manager.getLeafId();
			expect(rootCursor).toBe(shared.id);
			const original = await Bun.file(file).text();
			session.agent.replaceMessages(manager.buildSessionContext().messages);
			const live = () => session.agent.state.messages;
			expect(
				live().some(
					message =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.startsWith("older turn 0 "),
				),
			).toBe(true);
			expect(
				live().some(message => message.role === "user" && message.content === "root shared canonical turn"),
			).toBe(true);

			if (control === "manual") {
				const result = await session.compact();
				expect(result.summary).toContain("shared-hook-summary");
			} else {
				const events: AgentSessionEvent[] = [];
				session.subscribe(event => events.push(event));
				await session.runIdleCompaction();
				const end = events.findLast(event => event.type === "auto_compaction_end");
				expect(end).toMatchObject({
					action: "context-full",
					aborted: false,
					result: { summary: expect.stringContaining("shared-hook-summary") },
				});
			}
			const compaction = manager.getBranch().findLast(entry => entry.type === "compaction");
			expect(compaction).toMatchObject({ type: "compaction", parentId: rootCursor });
			expect(
				live().some(
					message => message.role === "compactionSummary" && message.summary.includes("shared-hook-summary"),
				),
			).toBe(true);
			expect(
				live().some(
					message =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.startsWith("older turn 0 "),
				),
			).toBe(false);
			expect(
				live().some(message => message.role === "user" && message.content === "root shared canonical turn"),
			).toBe(true);
			const persisted = await Bun.file(file).text();
			expect(persisted.startsWith(original)).toBe(true);
			expect(persisted).toContain("peer pre-compaction branch");
			expect(persisted).toContain('"type":"compaction"');
			const peerSecond = await peer.appendMessageSharingSession(user("peer post-compaction branch", 102));
			expect(peerSecond.kind).toBe("committed");
			if (peerSecond.kind !== "committed") throw new Error(`Peer continuation: ${peerSecond.kind}`);
			const peerEntry = peer.getBranch().find(entry => entry.id === peerSecond.id);
			expect(peerEntry?.parentId).toBe(peerFirst.id);
			expect((await Bun.file(file).text()).startsWith(persisted)).toBe(true);
		});
	}
});

describe("transcript-size emergency floor", () => {
	const answer = () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};

	it("still compacts a legacy session above the floor", async () => {
		const { manager, session } = await sessionFixture();
		session.agent.streamFn = answer;
		// Above the 48 MiB transcript floor.
		session.setResourceSampler(() => ({
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 64 * 1024 * 1024,
		}));
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("next turn");

		const starts = events.filter(event => event.type === "auto_compaction_start");
		expect(starts).toEqual([expect.objectContaining({ reason: "overflow" })]);
		expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(
			session.agent.state.messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "text" && block.text === "ok"),
			),
		).toBe(true);
	});
});
