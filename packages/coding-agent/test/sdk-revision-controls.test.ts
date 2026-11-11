import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockModel, type MockResponse } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	reviseSession,
	SDK_REVISION_MAX_BODY_CHARS,
	SdkRevisionError,
} from "@gajae-code/coding-agent/sdk/revision-controls";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager, type SessionMessageEntry } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function lastUser(session: AgentSession): SessionMessageEntry {
	const entry = session.sessionManager
		.getBranch()
		.findLast(entry => entry.type === "message" && entry.message.role === "user");
	if (entry?.type !== "message") throw new Error("Expected a real persisted user entry");
	return entry;
}

function userTexts(model: MockModel, index: number): string[] {
	const call = model.calls[index];
	if (!call) throw new Error("Expected provider request");
	return call.context.messages
		.filter(message => message.role === "user")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.join(""),
		);
}

function replacementSiblingRoot(session: AgentSession, original: SessionMessageEntry, replacementId: string): string {
	const branch = session.sessionManager.getBranch(replacementId);
	const parentIndex = original.parentId === null ? -1 : branch.findIndex(entry => entry.id === original.parentId);
	if (original.parentId !== null) expect(parentIndex).toBeGreaterThanOrEqual(0);
	expect(branch.at(-1)?.id).toBe(replacementId);
	// Native prompt admission may insert model/thinking configuration entries.
	// They are legitimate sibling ancestry, not another conversation turn.
	expect(branch.slice(parentIndex + 1, -1).every(entry => entry.type !== "message")).toBe(true);
	const root = branch[parentIndex + 1];
	if (!root) throw new Error("Expected replacement sibling branch");
	expect(root.parentId).toBe(original.parentId);
	return root.id;
}

describe("SDK same-session native prompt revision", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession;
	let model: MockModel;
	const restores: Array<() => void> = [];

	beforeEach(async () => {
		dir = TempDir.createSync("sdk-revision-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		auth.setRuntimeApiKey(bundled.provider, "test-key");
		registry = new ModelRegistry(auth);
		model = createMockModel({ handler: { content: ["ordinary provider answer"] } });
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("default", `${bundled.provider}/${bundled.id}`);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: bundled, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: model.stream,
			}),
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: registry,
		});
	});

	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		await session.dispose();
		auth.close();
		dir.removeSync();
	});

	async function prompt(text: string): Promise<SessionMessageEntry> {
		await session.prompt(text);
		await session.waitForIdle();
		await session.awaitSessionSettlement();
		return lastUser(session);
	}

	function input(entryId: string, body = "replacement user text"): Record<string, unknown> {
		return { sessionId: session.sessionId, entryId, body };
	}

	function seedUnanswered(text: string): SessionMessageEntry {
		session.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		return lastUser(session);
	}

	it("keeps the same session and original answered sibling while making a real provider request on the replacement branch", async () => {
		const original = await prompt("original user text");
		const manager = session.sessionManager;
		const sessionId = session.sessionId;
		const originalLeaf = manager.getLeafId();
		const originalEntries = manager.getEntries();
		const navigation = spyOn(session, "navigateTree");
		const send = spyOn(session, "prompt");
		restores.push(
			() => navigation.mockRestore(),
			() => send.mockRestore(),
		);
		const result = await reviseSession(session, input(original.id));

		expect(result).toEqual({
			sessionId,
			revised: true,
			entryId: original.id,
			replacementEntryId: expect.any(String),
			assistantEntryId: expect.any(String),
			status: "completed",
		});
		expect(session.sessionManager).toBe(manager);
		expect(session.sessionId).toBe(sessionId);
		expect(navigation).toHaveBeenCalledWith(original.id, { summarize: false });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toBe("replacement user text");
		for (const entry of originalEntries) expect(manager.getEntry(entry.id)).toEqual(entry);
		expect(manager.getEntry(originalLeaf!)).toBeDefined();
		expect(manager.getBranch().some(entry => entry.id === original.id)).toBe(false);
		expect(manager.getBranch().map(entry => entry.id)).toContain(result.replacementEntryId);
		expect(manager.getLeafId()).toBe(result.assistantEntryId);
		replacementSiblingRoot(session, original, result.replacementEntryId);
		expect(model.calls).toHaveLength(2);
		expect(userTexts(model, 1)).toEqual(["replacement user text"]);
		expect(JSON.stringify(result)).not.toContain("replacement user text");
		expect(JSON.stringify(result)).not.toContain("ordinary provider answer");
	});

	it("revises a nested user beneath its existing parent without losing either answered sibling", async () => {
		const first = await prompt("keep this earlier turn");
		const original = await prompt("replace this later turn");
		const previousLeaf = session.sessionManager.getLeafId();
		const result = await reviseSession(session, input(original.id, "later revision"));
		const branch = session.sessionManager.getBranch();
		expect(branch.map(entry => entry.id)).toContain(first.id);
		expect(branch.map(entry => entry.id)).not.toContain(original.id);
		const siblingRoot = replacementSiblingRoot(session, original, result.replacementEntryId);
		expect(session.sessionManager.getChildren(original.parentId!).map(entry => entry.id)).toEqual(
			expect.arrayContaining([original.id, siblingRoot]),
		);
		expect(session.sessionManager.getEntry(previousLeaf!)).toBeDefined();
		expect(userTexts(model, 2)).toEqual(["keep this earlier turn", "later revision"]);
	});

	it("rewinds a root user leaf through native navigation instead of including the original user", async () => {
		const original = seedUnanswered("unanswered root");
		expect(original.parentId).toBeNull();
		const result = await reviseSession(session, input(original.id, "root replacement"));
		expect(session.sessionManager.getEntry(original.id)).toEqual(original);
		replacementSiblingRoot(session, original, result.replacementEntryId);
		expect(session.sessionManager.getBranch().map(entry => entry.id)).not.toContain(original.id);
		expect(userTexts(model, 0)).toEqual(["root replacement"]);
	});

	it("rejects malformed bodies, IDs, and client-supplied runtime capabilities before native mutation", async () => {
		const original = seedUnanswered("original");
		const navigation = spyOn(session, "navigateTree");
		restores.push(() => navigation.mockRestore());
		for (const body of [
			undefined,
			null,
			1,
			{},
			[],
			"",
			" \n\t",
			"x".repeat(SDK_REVISION_MAX_BODY_CHARS + 1),
			String.fromCharCode(0xd800),
		])
			await expect(reviseSession(session, { ...input(original.id), body })).rejects.toMatchObject({
				code: "invalid_input",
			});
		for (const entryId of [undefined, null, "", "x".repeat(129), "line\nbreak", String.fromCharCode(0xdc00)])
			await expect(reviseSession(session, { ...input(original.id), entryId })).rejects.toMatchObject({
				code: "invalid_input",
			});
		await expect(
			reviseSession(session, { ...input(original.id), sdkRunCapability: "client-controlled" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(navigation).not.toHaveBeenCalled();
		expect(model.calls).toHaveLength(0);
		expect(session.sessionManager.getLeafId()).toBe(original.id);
	});

	it("accepts exactly the body limit, preserving literal slash text instead of invoking commands", async () => {
		const original = seedUnanswered("original");
		const body = `/clear ${"x".repeat(SDK_REVISION_MAX_BODY_CHARS - 7)}`;
		expect(body.length).toBe(SDK_REVISION_MAX_BODY_CHARS);
		await reviseSession(session, input(original.id, body));
		expect(userTexts(model, 0)).toEqual([body]);
	});

	it("rejects foreign, missing, assistant, and stale off-branch targets", async () => {
		const original = await prompt("original");
		const assistant = session.sessionManager.getLeafId()!;
		await expect(
			reviseSession(session, { ...input(original.id), sessionId: "another-session" }),
		).rejects.toMatchObject({ code: "resource_gone" });
		await expect(reviseSession(session, input("missing"))).rejects.toMatchObject({ code: "invalid_input" });
		await expect(reviseSession(session, input(assistant))).rejects.toMatchObject({ code: "invalid_input" });
		await reviseSession(session, input(original.id));
		const currentLeaf = session.sessionManager.getLeafId();
		await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({ code: "resource_gone" });
		expect(session.sessionManager.getLeafId()).toBe(currentLeaf);
		expect(model.calls).toHaveLength(2);
	});

	it("rejects a real in-progress native lifecycle transition", async () => {
		const original = await prompt("original");
		const navigation = session.navigateTree(original.id);
		try {
			expect(session.sessionLifecycle.transitioning).toBe(true);
			await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({ code: "busy" });
		} finally {
			await navigation;
		}
		expect(model.calls).toHaveLength(1);
	});

	it("rolls back an answered leaf after real provider preflight refusal without leaking its error", async () => {
		const original = await prompt("original");
		const leaf = session.sessionManager.getLeafId();
		const entries = session.sessionManager.getEntries();
		const getKey = spyOn(registry, "getApiKey").mockRejectedValue(new Error("private-token /private/provider-path"));
		restores.push(() => getKey.mockRestore());
		await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({
			code: "revision_failed",
			rollbackFailed: false,
		});
		expect(session.sessionManager.getLeafId()).toBe(leaf);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(model.calls).toHaveLength(1);
	});

	for (const nested of [false, true]) {
		it(`restores an unanswered ${nested ? "non-root" : "root"} user leaf exactly when no entry was appended`, async () => {
			if (nested) await prompt("earlier answered turn");
			const original = seedUnanswered("unanswered original");
			const entries = session.sessionManager.getEntries();
			const getKey = spyOn(registry, "getApiKey").mockRejectedValue(new Error("preflight refused"));
			restores.push(() => getKey.mockRestore());
			await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({
				code: "revision_failed",
				rollbackFailed: false,
			});
			expect(session.sessionManager.getLeafId()).toBe(original.id);
			expect(session.sessionManager.getEntries()).toEqual(entries);
			expect(lastUser(session).id).toBe(original.id);
		});
	}

	it("reports terminal provider failure explicitly and never erases the appended revision", async () => {
		const original = await prompt("original");
		model.push({ throw: "provider private-token /private/provider-path" });
		let observed: unknown;
		try {
			await reviseSession(session, input(original.id));
		} catch (error) {
			observed = error;
		}
		expect(observed).toBeInstanceOf(SdkRevisionError);
		expect(observed).toMatchObject({ code: "provider_failed", rollbackFailed: false });
		expect(String(observed)).not.toContain("private-token");
		expect(String(observed)).not.toContain("provider-path");
		expect(session.sessionManager.getEntry(original.id)).toEqual(original);
		expect(lastUser(session).id).not.toBe(original.id);
		expect(session.sessionManager.getBranch().map(entry => entry.id)).not.toContain(original.id);
		expect(model.calls).toHaveLength(2);
	});

	it("holds one revision slot until the real provider and prompt settle", async () => {
		const original = await prompt("original");
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<MockResponse>();
		model.push(async () => {
			started.resolve();
			return response.promise;
		});
		const revision = reviseSession(session, input(original.id));
		try {
			await started.promise;
			await expect(reviseSession(session, input(original.id, "overlap"))).rejects.toMatchObject({ code: "busy" });
		} finally {
			response.resolve({ content: ["real revision response"] });
		}
		const result = await revision;
		expect(session.sessionManager.getLeafId()).toBe(result.assistantEntryId);
		expect(model.calls).toHaveLength(2);
		await reviseSession(session, input(result.replacementEntryId, "subsequent revision"));
		expect(model.calls).toHaveLength(3);
	});

	it("uses the normal session abort path and retains an already-appended cancelled revision", async () => {
		const original = await prompt("original");
		const started = Promise.withResolvers<void>();
		let providerSignal: AbortSignal | undefined;
		let signalAborted = false;
		let revisionState = "pending";
		let abortState = "not-requested";
		model.push((_context, options) => {
			providerSignal = options?.signal;
			signalAborted = providerSignal?.aborted === true;
			providerSignal?.addEventListener(
				"abort",
				() => {
					signalAborted = true;
				},
				{ once: true },
			);
			started.resolve();
			return { delayMs: 60_000, content: ["must be cancelled"] };
		});
		const revision = reviseSession(session, input(original.id));
		const settled = revision.then(
			() => {
				revisionState = "completed";
			},
			error => {
				revisionState = error instanceof SdkRevisionError ? error.code : "unexpected-error";
			},
		);
		const diagnostic = () =>
			JSON.stringify({
				providerCalls: model.calls.length,
				signalSupplied: providerSignal !== undefined,
				signalAborted,
				revisionState,
				abortState,
				streaming: session.isStreaming,
				awaitingIdle: session.isAwaitingIdle,
				lifecycle: session.sessionLifecycle,
			});
		const bounded = async <T>(promise: Promise<T>, phase: string): Promise<T> => {
			const deadline = Promise.withResolvers<never>();
			const timer = setTimeout(() => deadline.reject(new Error(`${phase}: ${diagnostic()}`)), 1_000);
			try {
				return await Promise.race([promise, deadline.promise]);
			} finally {
				clearTimeout(timer);
			}
		};
		const first = await bounded(
			Promise.race([
				started.promise.then(() => "provider-started" as const),
				settled.then(() => "revision-settled" as const),
			]),
			"waiting-for-provider",
		);
		expect(first, diagnostic()).toBe("provider-started");
		expect(providerSignal, diagnostic()).toBeInstanceOf(AbortSignal);
		abortState = "pending";
		const abort = session.abort().then(
			() => {
				abortState = "settled";
			},
			error => {
				abortState = "rejected";
				throw error;
			},
		);
		await bounded(Promise.all([abort, settled]), "waiting-for-abort-and-revision");
		expect(signalAborted, diagnostic()).toBe(true);
		expect(revisionState, diagnostic()).toBe("revision_cancelled");
		await session.waitForIdle();
		expect(session.sessionManager.getEntry(original.id)).toEqual(original);
		expect(lastUser(session).id).not.toBe(original.id);
		expect(session.sessionManager.getBranch().map(entry => entry.id)).not.toContain(original.id);
	});

	it("rejects a streaming normal turn without aborting it or moving its branch", async () => {
		const original = await prompt("original");
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<MockResponse>();
		model.push(async () => {
			started.resolve();
			return response.promise;
		});
		const pending = session.prompt("independent active turn");
		try {
			await started.promise;
			const leaf = session.sessionManager.getLeafId();
			await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({ code: "busy" });
			expect(session.sessionManager.getLeafId()).toBe(leaf);
			expect(session.isStreaming).toBe(true);
		} finally {
			response.resolve({ content: ["independent completion"] });
			await pending;
			await session.waitForIdle();
		}
		expect(userTexts(model, 1)).toEqual(["original", "independent active turn"]);
	});

	it("rejects pending prompt admission before navigation rather than cancelling that prompt", async () => {
		const original = await prompt("original");
		const barrier = Promise.withResolvers<void>();
		session.extendStartupTurnBarrier(barrier.promise);
		const pending = session.prompt("pending independent turn");
		try {
			await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({ code: "busy" });
		} finally {
			barrier.resolve();
			await pending;
			await session.waitForIdle();
		}
		expect(userTexts(model, 1)).toEqual(["original", "pending independent turn"]);
	});

	it("rejects an independent prompt completing during revision settlement instead of returning its assistant ID", async () => {
		const original = await prompt("original");
		const settle = session.awaitSessionSettlement.bind(session);
		const settlement = spyOn(session, "awaitSessionSettlement").mockImplementationOnce(async () => {
			await session.prompt("independent settlement-gap turn");
			await session.waitForIdle();
			await settle();
		});
		restores.push(() => settlement.mockRestore());
		await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({ code: "resource_gone" });
		expect(model.calls).toHaveLength(3);
		expect(userTexts(model, 1)).toEqual(["replacement user text"]);
		expect(userTexts(model, 2)).toEqual(["replacement user text", "independent settlement-gap turn"]);
		expect(session.sessionManager.getEntry(original.id)).toEqual(original);
		const independent = lastUser(session).message;
		if (independent.role !== "user") throw new Error("Expected independent user turn");
		expect(independent.content).toEqual([{ type: "text", text: "independent settlement-gap turn" }]);
	});

	it("does not prompt or roll back a successor adopted while navigation completes", async () => {
		const original = await prompt("original");
		const manager = session.sessionManager;
		const successor = SessionManager.inMemory(dir.path());
		successor.appendMessage({ role: "user", content: "successor sentinel", timestamp: Date.now() });
		const successorEntries = successor.getEntries();
		const successorLeaf = successor.getLeafId();
		const navigate = session.navigateTree.bind(session);
		const navigation = spyOn(session, "navigateTree").mockImplementation(async (target, options) => {
			const result = await navigate(target, options);
			session.sessionManager = successor;
			return result;
		});
		restores.push(() => navigation.mockRestore());
		try {
			await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({ code: "resource_gone" });
			expect(navigation).toHaveBeenCalledTimes(1);
			expect(model.calls).toHaveLength(1);
			expect(successor.getEntries()).toEqual(successorEntries);
			expect(successor.getLeafId()).toBe(successorLeaf);
		} finally {
			session.sessionManager = manager;
			await successor.close();
		}
	});

	it("does not roll back over another native branch selection", async () => {
		const original = await prompt("original");
		const previousLeaf = session.sessionManager.getLeafId()!;
		const navigate = session.navigateTree.bind(session);
		const navigation = spyOn(session, "navigateTree").mockImplementation(async (target, options) => {
			const result = await navigate(target, options);
			await navigate(previousLeaf);
			return result;
		});
		restores.push(() => navigation.mockRestore());
		await expect(reviseSession(session, input(original.id))).rejects.toMatchObject({ code: "resource_gone" });
		expect(session.sessionManager.getLeafId()).toBe(previousLeaf);
		expect(navigation).toHaveBeenCalledTimes(1);
		expect(model.calls).toHaveLength(1);
	});
});
