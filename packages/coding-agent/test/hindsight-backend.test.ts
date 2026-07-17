/**
 * Backend behavioural contract tests.
 *
 * These exercise hindsightBackend.start / preCompactionContext / clear without
 * a real AgentSession by passing a fake session that exposes a `subscribe`
 * method we can drive manually. The HindsightApi is spied via
 * `vi.spyOn(HindsightApi.prototype, ...)` per AGENTS.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { hindsightBackend, reloadMentalModelsForSession } from "@gajae-code/coding-agent/hindsight/backend";
import { HindsightApi } from "@gajae-code/coding-agent/hindsight/client";
import type { HindsightSessionState } from "@gajae-code/coding-agent/hindsight/state";
import type { AgentSessionEventListener } from "@gajae-code/coding-agent/session/agent-session";

interface FakeSessionDeps {
	sessionId: string | null;
	cwd?: string;
	entries?: Array<{ role: "user" | "assistant"; text: string }>;
}

function makeFakeSession(deps: FakeSessionDeps) {
	const listeners = new Set<AgentSessionEventListener>();
	const entries = deps.entries ?? [];
	let hindsightState: HindsightSessionState | undefined;
	const session = {
		sessionId: deps.sessionId,
		settings: Settings.isolated(),
		sessionManager: {
			getEntries: () =>
				entries.map((e, i) => ({
					id: `e${i}`,
					parentId: i === 0 ? null : `e${i - 1}`,
					timestamp: new Date(0).toISOString(),
					type: "message" as const,
					message:
						e.role === "user"
							? {
									role: "user" as const,
									content: e.text,
									timestamp: 0,
								}
							: {
									role: "assistant" as const,
									content: [{ type: "text" as const, text: e.text }],
									model: "x",
									provider: "x",
									api: "x",
									stopReason: "end_turn" as const,
									timestamp: 0,
								},
				})),
			getCwd: () => deps.cwd ?? "/tmp",
			getSessionFile: () => null,
			getSessionId: () => deps.sessionId ?? "",
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		getHindsightSessionState: () => hindsightState,
		setHindsightSessionState(state: HindsightSessionState | undefined) {
			const previous = hindsightState;
			hindsightState = state;
			return previous;
		},
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			for (const l of [...listeners]) l(event);
		},
	};
	return session;
}

describe("hindsightBackend.start", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does nothing when memory.backend is hindsight but apiUrl is empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const session = makeFakeSession({ sessionId: "s1" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeUndefined();
	});

	it("registers per-session state and subscribes to agent events when configured", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s2" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeDefined();
		expect(session.getHindsightSessionState()?.bankId).toBeTruthy();
	});

	it("flushes queued retains before replacing the state that owns the session", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const session = makeFakeSession({ sessionId: "s-replace" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const previous = session.getHindsightSessionState()!;
		previous.enqueueRetain("must flush before state replacement");

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(retainBatchSpy).toHaveBeenCalledWith(
			previous.bankId,
			expect.arrayContaining([expect.objectContaining({ content: "must flush before state replacement" })]),
			expect.objectContaining({ async: true }),
		);
		expect(session.getHindsightSessionState()).not.toBe(previous);
	});

	it("rekeys state when the same AgentSession gets a new session id (resume/switch)", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s-before" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeDefined();
		(session as { sessionId: string | null }).sessionId = "s-after";
		session.getHindsightSessionState()?.setSessionId("s-after");
		expect(session.getHindsightSessionState()?.sessionId).toBe("s-after");
		expect(session.getHindsightSessionState()?.bankId).toBeTruthy();
	});

	it("retains every Nth user turn on agent_end and skips intermediate turns", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 2,
		});
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const entries: Array<{ role: "user" | "assistant"; text: string }> = [];
		const session = makeFakeSession({ sessionId: "s3", entries });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		// Turn 1: not enough turns yet
		entries.push({ role: "user", text: "first user message that is long enough" });
		entries.push({ role: "assistant", text: "first assistant reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(0);

		// Turn 2: hits the threshold
		entries.push({ role: "user", text: "second user message that is long enough" });
		entries.push({ role: "assistant", text: "second reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(1);
	});

	it("retains only unretained full-session turns under the stable document id", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 1,
		});
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const entries: Array<{ role: "user" | "assistant"; text: string }> = [
			{ role: "user", text: "first user message that is long enough" },
			{ role: "assistant", text: "first assistant reply that is long enough" },
		];
		const session = makeFakeSession({ sessionId: "s-delta", entries });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		entries.push(
			{ role: "user", text: "second user message that is long enough" },
			{ role: "assistant", text: "second assistant reply that is long enough" },
		);
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);

		expect(retainSpy).toHaveBeenCalledTimes(2);
		const [, firstTranscript, firstOptions] = retainSpy.mock.calls[0];
		const [, secondTranscript, secondOptions] = retainSpy.mock.calls[1];
		expect(firstTranscript).toContain("first user message");
		expect(secondTranscript).toContain("second user message");
		expect(secondTranscript).not.toContain("first user message");
		expect(secondOptions?.documentId).toBe(firstOptions?.documentId);
		expect(firstOptions?.updateMode).toBe("append");
		expect(secondOptions?.updateMode).toBe("append");
	});

	it("skips transcript extraction and upload when the full-session delta is empty", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const session = makeFakeSession({ sessionId: "s-empty-delta" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState()!;
		state.lastRetainedTurn = 1;

		const retained = await state.retainSession([{ role: "user", content: "already retained user message" }]);
		expect(retained).toBe(false);
		expect(retainSpy).not.toHaveBeenCalled();
	});

	it("coalesces concurrent agent_end retains while one upload is in flight", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 1,
		});
		let release!: () => void;
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockImplementation(
			() =>
				new Promise(resolve => {
					release = () => resolve({} as never);
				}),
		);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const entries = [
			{ role: "user" as const, text: "user message that is long enough" },
			{ role: "assistant" as const, text: "assistant reply that is long enough" },
		];
		const session = makeFakeSession({ sessionId: "s-in-flight", entries });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		session.emit({ type: "agent_end", messages: [] });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(1);
		release();
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(1);
	});

	it("aliases parent state on subagent runs (taskDepth > 0) so tools share the parent bank", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});

		// Register a primary (top-level) state first.
		const parentSession = makeFakeSession({ sessionId: "parent" });
		await hindsightBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const parentState = parentSession.getHindsightSessionState();
		expect(parentState).toBeDefined();

		// Subagent runs with taskDepth > 0 should alias the parent.
		const subSession = makeFakeSession({ sessionId: "sub" });
		await hindsightBackend.start({
			session: subSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: parentState,
		});
		const subState = subSession.getHindsightSessionState();
		expect(subState).toBeDefined();
		expect(subState?.aliasOf).toBe(parentState);
		expect(subState?.bankId).toBe(parentState?.bankId);
		expect(subState?.client).toBe(parentState?.client);
		expect(subState?.missionsSet).toBe(parentState?.missionsSet);
		// Aliases must not subscribe to session events — the parent owns auto-recall/auto-retain.
		expect(subState?.unsubscribe).toBeUndefined();
		// hasRecalledForFirstTurn=true suppresses beforeAgentStartPrompt auto-recall on the sub.
		expect(subState?.hasRecalledForFirstTurn).toBe(true);
	});

	it("returns silently for subagent runs when no primary state has been registered", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "orphan-sub" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
		});

		expect(session.getHindsightSessionState()).toBeUndefined();
	});
});

describe("hindsightBackend.preCompactionContext", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns undefined when no apiUrl is configured", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings);
		expect(ctx).toBeUndefined();
	});

	it("returns a <memories> block when recall yields results", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s5" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "remembered fact" }],
		} as never);

		const messages: AgentMessage[] = [{ role: "user", content: "What did we decide?", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings, session as never);
		expect(ctx).toBeDefined();
		expect(ctx).toContain("<memories>");
		expect(ctx).toContain("remembered fact");
	});

	it("returns undefined when recall finds nothing", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s6" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const messages: AgentMessage[] = [{ role: "user", content: "anything", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings, session as never);
		expect(ctx).toBeUndefined();
	});
});

describe("hindsightBackend first-turn injection", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a tagged block for the current first turn before agent_start", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({
			sessionId: "s8",
			entries: [{ role: "assistant", text: "previous assistant context" }],
		});
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "Can prefers concise communication" }],
		} as never);

		const block = await hindsightBackend.beforeAgentStartPrompt?.(
			session as never,
			"What do I know about this user?",
		);
		expect(block).toContain("<memories>");
		expect(block).toContain("Can prefers concise communication");
		expect(block).not.toContain("Current time:");
		expect(session.getHindsightSessionState()?.hasRecalledForFirstTurn).toBe(true);
		expect(session.getHindsightSessionState()?.lastRecallSnippet).toBe(block);
	});

	it("keeps recall out of developer instructions", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s9" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();
		expect(state).toBeDefined();
		state!.lastRecallSnippet = "<memories>\nremembered fact\n</memories>";

		const prompt = await hindsightBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		expect(prompt).not.toContain("<memories>\nremembered fact");
		expect(state!.getRecallSnippet()).toContain("remembered fact");
	});

	it("keeps only the <mental_models> block in developer instructions", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		const session = makeFakeSession({ sessionId: "s-order" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();
		expect(state).toBeDefined();
		state!.mentalModelsSnippet = "<mental_models>\n# User Preferences\nprefers tabs\n</mental_models>";
		state!.lastRecallSnippet = "<memories>\nrecalled fact\n</memories>";

		const prompt = await hindsightBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		expect(prompt).toContain("<mental_models>\n# User Preferences");
		expect(prompt).not.toContain("<memories>\nrecalled fact");
	});

	it("reloadMentalModelsForSession refreshes the cached snippet and base prompt", async () => {
		// Defends the TTL/manual reload contract: a fresh `listMentalModels`
		// must update both `mentalModelsSnippet` and `mentalModelsLoadedAt`,
		// and call `refreshBaseSystemPrompt` so the next turn picks up the
		// new content.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		const session = makeFakeSession({ sessionId: "s-ttl" });
		// Initial start may issue its own listMentalModels (read-only by default);
		// stub it to return nothing so the initial snippet is undefined.
		const listSpy = vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		// Wait for the kicked-off load to settle.
		await session.getHindsightSessionState()?.mentalModelsLoadPromise;
		const state = session.getHindsightSessionState();
		expect(state).toBeDefined();
		expect(state!.mentalModelsSnippet).toBeUndefined();
		expect(state!.mentalModelsLoadedAt).toBeDefined();
		const initialLoadedAt = state!.mentalModelsLoadedAt!;
		const refreshSpy = session.refreshBaseSystemPrompt;
		const callsBefore = refreshSpy.mock.calls.length;

		// Now publish content and trigger a reload.
		listSpy.mockResolvedValue({
			items: [
				{
					id: "user-preferences",
					bank_id: state!.bankId,
					name: "User Preferences",
					content: "prefers concise prose",
				},
			],
		} as never);
		// Force the loadedAt timestamp to differ so the next assertion is meaningful.
		state!.mentalModelsLoadedAt = initialLoadedAt - 1000;

		const ok = await reloadMentalModelsForSession(session as never);
		expect(ok).toBe(true);
		expect(state!.mentalModelsSnippet).toBeDefined();
		expect(state!.mentalModelsSnippet).toContain("# User Preferences");
		expect(state!.mentalModelsSnippet).toContain("prefers concise prose");
		expect(state!.mentalModelsLoadedAt).toBeGreaterThan(initialLoadedAt - 1000);
		expect(refreshSpy.mock.calls.length).toBeGreaterThan(callsBefore);
	});

	it("does not refresh the base prompt when a TTL reload has unchanged content", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
			"hindsight.mentalModelRefreshIntervalMs": 0,
		});
		const session = makeFakeSession({ sessionId: "s-unchanged-ttl" });
		const listSpy = vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({
			items: [{ id: "prefs", bank_id: "bank", name: "Preferences", content: "use tabs" }],
		} as never);
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		await session.getHindsightSessionState()?.mentalModelsLoadPromise;
		session.refreshBaseSystemPrompt.mockClear();

		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(session.refreshBaseSystemPrompt).not.toHaveBeenCalled();

		listSpy.mockResolvedValue({
			items: [{ id: "prefs", bank_id: "bank", name: "Preferences", content: "use spaces" }],
		} as never);
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
	});

	it("reloadMentalModelsForSession returns false on subagent aliases", async () => {
		// Aliases delegate to the parent; reloads on an alias must no-op so
		// the parent's cache is the single source of truth.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		const parent = makeFakeSession({ sessionId: "alias-parent" });
		await hindsightBackend.start({
			session: parent as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const child = makeFakeSession({ sessionId: "alias-child" });
		await hindsightBackend.start({
			session: child as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: parent.getHindsightSessionState(),
		});
		const ok = await reloadMentalModelsForSession(child as never);
		expect(ok).toBe(false);
	});
});

describe("hindsightBackend.clear", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops every registered session state", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s7" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.getHindsightSessionState()).toBeDefined();

		await hindsightBackend.clear("/tmp", "/tmp", session as never);
		expect(session.getHindsightSessionState()).toBeUndefined();
	});

	it("does not delete server-side mental models on /memory clear (server-side state is sacred)", async () => {
		// `/memory clear` is documented to wipe only the local recall cache.
		// Mental models persist on the Hindsight server across sessions and
		// must not be silently deleted by a local clear command — operators
		// who actually want to drop server-side state use the Hindsight UI or
		// `/memory mm delete <id>` explicitly.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		const deleteSpy = vi.spyOn(HindsightApi.prototype, "deleteMentalModel").mockResolvedValue(true);
		const session = makeFakeSession({ sessionId: "s-clear-mm" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		await hindsightBackend.clear("/tmp", "/tmp", session as never);
		expect(deleteSpy).not.toHaveBeenCalled();
	});
});
