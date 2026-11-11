import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import type { ImageContent } from "@gajae-code/ai/core";
import { createMockModel, type MockModel, type MockResponse } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import {
	reviseSession,
	SDK_REVISION_MAX_BODY_CHARS,
	SdkRevisionError,
} from "@gajae-code/coding-agent/sdk/revision-controls";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager, type SessionMessageEntry } from "@gajae-code/coding-agent/session/session-manager";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { TempDir } from "@gajae-code/utils";
import { MAX_IMAGE_INPUT_BYTES, MAX_STAGED_PROMPT_IMAGES } from "../src/utils/image-limits";

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
	let cancelNavigation: boolean;
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
		const manager = SessionManager.inMemory(dir.path());
		cancelNavigation = false;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.on("session_before_tree", () => (cancelNavigation ? { cancel: true } : undefined));
			},
			dir.path(),
			new EventBus(),
			runtime,
			"revision-cancellation-test",
		);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: bundled, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: model.stream,
			}),
			sessionManager: manager,
			extensionRunner: new ExtensionRunner([extension], runtime, dir.path(), manager, registry),
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
		if (result.status !== "completed") throw new Error("Expected a completed edit");

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

	for (const body of ["image replacement", "", undefined]) {
		it(`delivers real validated image bytes through native prompt and transcript (${body === undefined ? "omitted body" : body || "empty body"})`, async () => {
			const original = await prompt("original");
			session.settings.set("images.autoResize", false);
			const image: ImageContent = {
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			};
			const result = await reviseSession(session, {
				sessionId: session.sessionId,
				entryId: original.id,
				images: [image],
				...(body === undefined ? {} : { body }),
			});
			expect(result.status).toBe("completed");
			const delivered = model.calls[1]?.context.messages.findLast(message => message.role === "user");
			expect(delivered?.content).toEqual([{ type: "text", text: body ?? "" }, image]);
			const persisted = lastUser(session).message;
			if (persisted.role !== "user") throw new Error("Expected persisted user image message");
			expect(persisted.content).toEqual([{ type: "text", text: body ?? "" }, image]);
			expect(session.sessionManager.getEntry(original.id)).toEqual(original);
		});
	}

	it("rejects unsafe image bounds, canonical encoding, unknown fields and undecodable images without navigating", async () => {
		const original = await prompt("original");
		const leaf = session.sessionManager.getLeafId();
		const entries = session.sessionManager.getEntries();
		const navigation = spyOn(session, "navigateTree");
		restores.push(() => navigation.mockRestore());
		const image: ImageContent = { type: "image", data: "cG5n", mimeType: "image/png" };
		for (const images of [
			[],
			null,
			[image],
			[{ ...image, type: "file" }],
			[{ ...image, mimeType: "image/svg+xml" }],
			[{ ...image, mimeType: "image/jpeg" }],
			[{ ...image, data: "AB==" }],
			[{ ...image, data: "cG5n\n" }],
			[{ ...image, data: "AAAA".repeat(Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) + 1) }],
			[{ ...image, path: "/private/image.png" }],
			Array.from({ length: MAX_STAGED_PROMPT_IMAGES + 1 }, () => image),
		]) {
			await expect(reviseSession(session, { ...input(original.id), images })).rejects.toMatchObject({
				code: "invalid_input",
			});
		}
		expect(navigation).not.toHaveBeenCalled();
		expect(session.sessionManager.getLeafId()).toBe(leaf);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(model.calls).toHaveLength(1);
	});

	it("selects both retained answered siblings and remembers each former continuation without provider work", async () => {
		const original = await prompt("original");
		await prompt("original continuation");
		const manager = session.sessionManager;
		const originalLeaf = manager.getLeafId();
		const revised = await reviseSession(session, input(original.id));
		if (revised.status !== "completed") throw new Error("Expected a completed edit");
		await prompt("replacement continuation");
		const replacementLeaf = manager.getLeafId();
		if (!originalLeaf || !replacementLeaf) throw new Error("Expected answered branch leaves");
		const entries = manager.getEntries();
		const callCount = model.calls.length;
		const navigation = spyOn(session, "navigateTree");
		restores.push(() => navigation.mockRestore());
		for (const [entryId, leafEntryId] of [
			[original.id, originalLeaf],
			[revised.replacementEntryId, replacementLeaf],
			[original.id, originalLeaf],
			[original.id, originalLeaf],
			[revised.replacementEntryId, replacementLeaf],
		]) {
			const result = await reviseSession(session, { sessionId: session.sessionId, entryId, action: "select" });
			expect(result).toEqual({
				sessionId: session.sessionId,
				entryId,
				leafEntryId,
				selected: true,
				status: "selected",
			});
			expect(navigation).toHaveBeenLastCalledWith(leafEntryId, { includeTarget: true, summarize: false });
			expect(manager.getLeafId()).toBe(leafEntryId);
			expect(session.sessionManager).toBe(manager);
			expect(manager.getEntries()).toEqual(entries);
			expect(model.calls).toHaveLength(callCount);
		}
	});

	it("uses the newest continuation for an answered revision not previously remembered", async () => {
		const original = await prompt("original");
		const originalAnswer = session.sessionManager.getLeafId()!;
		await prompt("older continuation");
		await session.navigateTree(originalAnswer, { includeTarget: true, summarize: false });
		await prompt("newer continuation");
		const newestLeaf = session.sessionManager.getLeafId()!;
		// Leave the revision through native navigation before SDK bookkeeping has seen it.
		await session.navigateTree(original.id, { summarize: false });
		await session.prompt("separate root");
		await session.waitForIdle();
		await session.awaitSessionSettlement();
		const calls = model.calls.length;
		const result = await reviseSession(session, {
			sessionId: session.sessionId,
			entryId: original.id,
			action: "select",
		});
		expect(result).toEqual({
			sessionId: session.sessionId,
			entryId: original.id,
			leafEntryId: newestLeaf,
			selected: true,
			status: "selected",
		});
		expect(session.sessionManager.getLeafId()).toBe(newestLeaf);
		expect(userTexts(model, calls - 1)).toEqual(["separate root"]);
		expect(session.sessionManager.getBranch().some(entry => entry.id === original.id)).toBe(true);
		expect(model.calls).toHaveLength(calls);
	});

	it("rejects unanswered, foreign and malformed selections without branch mutation", async () => {
		const original = await prompt("original");
		const unanswered = seedUnanswered("no answer");
		const leaf = session.sessionManager.getLeafId();
		const navigation = spyOn(session, "navigateTree");
		restores.push(() => navigation.mockRestore());
		const select = { sessionId: session.sessionId, entryId: original.id, action: "select" };
		for (const request of [
			{ ...select, entryId: unanswered.id },
			{ ...select, entryId: "missing" },
			{ ...select, body: "" },
			{ ...select, images: [] },
			{ ...select, action: "unknown" },
		]) {
			await expect(reviseSession(session, request)).rejects.toMatchObject({ code: "invalid_input" });
		}
		await expect(reviseSession(session, { ...select, sessionId: "foreign" })).rejects.toMatchObject({
			code: "resource_gone",
		});
		expect(navigation).not.toHaveBeenCalled();
		expect(session.sessionManager.getLeafId()).toBe(leaf);
	});

	it("honors real extension cancellation for selection and edit without appending or selecting", async () => {
		const original = await prompt("original");
		await reviseSession(session, input(original.id));
		const leaf = session.sessionManager.getLeafId();
		const entries = session.sessionManager.getEntries();
		cancelNavigation = true;
		await expect(
			reviseSession(session, { sessionId: session.sessionId, entryId: original.id, action: "select" }),
		).rejects.toMatchObject({ code: "revision_cancelled" });
		await expect(reviseSession(session, input(lastUser(session).id))).rejects.toMatchObject({
			code: "revision_cancelled",
		});
		expect(session.sessionManager.getLeafId()).toBe(leaf);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(model.calls).toHaveLength(2);
	});

	it("checks the actual selected leaf and does not overwrite competing navigation", async () => {
		const original = await prompt("original");
		await reviseSession(session, input(original.id));
		const replacementLeaf = session.sessionManager.getLeafId()!;
		const navigate = session.navigateTree.bind(session);
		const navigation = spyOn(session, "navigateTree").mockImplementation(async (target, options) => {
			const result = await navigate(target, options);
			await navigate(replacementLeaf, { includeTarget: true, summarize: false });
			return result;
		});
		restores.push(() => navigation.mockRestore());
		await expect(
			reviseSession(session, {
				sessionId: session.sessionId,
				entryId: original.id,
				action: "select",
			}),
		).rejects.toMatchObject({ code: "resource_gone" });
		expect(session.sessionManager.getLeafId()).toBe(replacementLeaf);
		expect(navigation).toHaveBeenCalledTimes(1);
		expect(model.calls).toHaveLength(2);
	});

	it("fails closed when a successor manager is adopted during selection navigation", async () => {
		const original = await prompt("original");
		await reviseSession(session, input(original.id));
		const manager = session.sessionManager;
		const successor = SessionManager.inMemory(dir.path());
		successor.appendMessage({ role: "user", content: "successor", timestamp: Date.now() });
		const entries = successor.getEntries();
		const navigate = session.navigateTree.bind(session);
		const navigation = spyOn(session, "navigateTree").mockImplementation(async (target, options) => {
			const result = await navigate(target, options);
			session.sessionManager = successor;
			return result;
		});
		restores.push(() => navigation.mockRestore());
		try {
			await expect(
				reviseSession(session, { sessionId: session.sessionId, entryId: original.id, action: "select" }),
			).rejects.toMatchObject({ code: "resource_gone" });
			expect(navigation).toHaveBeenCalledTimes(1);
			expect(successor.getEntries()).toEqual(entries);
			expect(model.calls).toHaveLength(2);
		} finally {
			session.sessionManager = manager;
			await successor.close();
		}
	});

	it("revises a nested user beneath its existing parent without losing either answered sibling", async () => {
		const first = await prompt("keep this earlier turn");
		const original = await prompt("replace this later turn");
		const previousLeaf = session.sessionManager.getLeafId();
		const result = await reviseSession(session, input(original.id, "later revision"));
		if (result.status !== "completed") throw new Error("Expected a completed edit");
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
		if (result.status !== "completed") throw new Error("Expected a completed edit");
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
			await expect(
				reviseSession(session, { sessionId: session.sessionId, entryId: original.id, action: "select" }),
			).rejects.toMatchObject({ code: "busy" });
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
		if (result.status !== "completed") throw new Error("Expected a completed edit");
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
