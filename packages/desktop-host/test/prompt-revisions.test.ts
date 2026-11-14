import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createAgentSession, createEmbeddedAgentSession, getSessionMessageEntryId } from "@gajae-code/coding-agent/sdk";
import { PromptRevisions } from "../src/prompt-revisions";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	const failures: unknown[] = [];
	while (cleanups.length) {
		try {
			await cleanups.pop()?.();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Prompt revision cleanup failed");
});

/** Real public embedding, native revision controls and transcript; only the provider is controlled. */
async function tree() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desktop-prompt-revisions-")));
	const agentDir = path.join(directory, "agent");
	await Bun.write(
		path.join(agentDir, "model-presets", "control.json"),
		JSON.stringify({ version: 1, disabled: true }),
	);
	await Bun.write(path.join(agentDir, "config.yml"), "startup:\n  networkPrewarm: false\n");
	const api = `prompt-revisions-${crypto.randomUUID()}`;
	let blocked: Promise<void> | undefined;
	let resume: (() => void) | undefined;
	let cancelNavigation = false;
	const model = createMockModel({
		provider: "desktop-prompt-revisions-fixture",
		handler: async () => {
			await blocked;
			return { content: ["answer"] };
		},
	});
	Object.defineProperty(model, "api", { value: api });
	registerCustomApi(api, model.stream, api);
	const owner = await createEmbeddedAgentSession({
		cwd: directory,
		agentDir,
		storage: { persist: false },
		model,
		systemPrompt: ["Test"],
		toolNames: [],
		disableExtensionDiscovery: true,
		extensions: [
			extension => {
				// Exercise sibling grouping across real SDK/extension bookkeeping, not a synthetic tree index.
				extension.on("before_agent_start", () => {
					extension.appendEntry("prompt-revisions-fixture", {});
				});
				extension.on("session_before_tree", () => (cancelNavigation ? { cancel: true } : undefined));
			},
		],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: directory, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMcpAutoload: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferModelProfileActivation: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		createSession: options => {
			options.settings?.set("compaction.enabled", false);
			options.settings?.set("retry.enabled", false);
			options.settings?.set("async.enabled", false);
			return createAgentSession(options);
		},
	});
	const session = owner.session;
	session.modelRegistry.authStorage.setRuntimeApiKey(model.provider, "fixture-only");
	cleanups.push(async () => {
		resume?.();
		try {
			await session.dispose();
			await owner.releaseResources();
		} finally {
			unregisterCustomApis(api);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	const last = (role: "user" | "assistant"): string => {
		const message = session.messages.findLast(message => message.role === role);
		const id = message && getSessionMessageEntryId(message);
		if (!id) throw new Error(`Missing persisted ${role} entry`);
		return id;
	};
	return {
		owner,
		session,
		model,
		last,
		cancelNavigation: () => {
			cancelNavigation = true;
		},
		prompt: async (text: string) => {
			await Bun.sleep(2);
			await session.prompt(text);
			await session.awaitSessionSettlement();
			return last("user");
		},
		edit: async (entryId: string, body: string) => {
			await Bun.sleep(2);
			const result = await owner.revise({ entryId, body });
			if (result.status !== "completed") throw new Error("Expected a completed edit");
			return result;
		},
		pause: () => {
			const gate = Promise.withResolvers<void>();
			blocked = gate.promise;
			resume = () => {
				blocked = undefined;
				gate.resolve();
			};
			return resume;
		},
	};
}

describe("prompt revisions", () => {
	test("groups answered edits across SDK bookkeeping and leaves out unanswered siblings", async () => {
		const t = await tree();
		const first = await t.prompt("first");
		const second = await t.prompt("second");
		const secondEdit = await t.edit(second, "second edited");
		await t.owner.revise({ entryId: first, action: "select" });
		const firstEdit = await t.edit(first, "first edited");
		const revisions = new PromptRevisions();
		expect(revisions.revision(t.session, first)).toEqual({ index: 0, count: 2, next: firstEdit.replacementEntryId });
		expect(revisions.revision(t.session, firstEdit.replacementEntryId)).toEqual({
			index: 1,
			count: 2,
			previous: first,
		});
		expect(revisions.revision(t.session, second)).toEqual({
			index: 0,
			count: 2,
			next: secondEdit.replacementEntryId,
		});
		expect(revisions.revision(t.session, secondEdit.replacementEntryId)).toEqual({
			index: 1,
			count: 2,
			previous: second,
		});

		// Observe a real admitted prompt while its first provider response is still pending.
		const resume = t.pause();
		const started = Promise.withResolvers<string>();
		const unsubscribe = t.session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const id = getSessionMessageEntryId(event.message);
			if (id) started.resolve(id);
		});
		const editing = t.owner.revise({ entryId: firstEdit.replacementEntryId, body: "first pending" });
		try {
			const pending = await Promise.race([
				started.promise,
				editing.then(() => {
					throw new Error("Edit completed before its user entry was observed");
				}),
			]);
			expect(revisions.revision(t.session, first)).toEqual({
				index: 0,
				count: 2,
				next: firstEdit.replacementEntryId,
			});
			expect(revisions.revision(t.session, pending)).toEqual({
				index: 2,
				count: 3,
				previous: firstEdit.replacementEntryId,
			});
			resume();
			const completed = await editing;
			expect(completed.status).toBe("completed");
			expect(revisions.revision(t.session, first)).toEqual({
				index: 0,
				count: 3,
				next: firstEdit.replacementEntryId,
			});
			expect(revisions.revision(t.session, firstEdit.replacementEntryId)).toEqual({
				index: 1,
				count: 3,
				previous: first,
				next: pending,
			});
		} finally {
			unsubscribe();
			resume();
			await editing;
		}
	});

	test("selects exact remembered continuations without another provider call", async () => {
		const t = await tree();
		const first = await t.prompt("first");
		const second = await t.prompt("second");
		const secondAnswer = t.last("assistant");
		const secondEdit = await t.edit(second, "second edited");
		const calls = t.model.calls.length;
		// A prompt already on the active branch stays at its current continuation.
		expect(await t.owner.revise({ entryId: first, action: "select" })).toEqual({
			sessionId: t.session.sessionId,
			selected: true,
			entryId: first,
			leafEntryId: secondEdit.assistantEntryId,
			status: "selected",
		});
		expect(t.last("user")).toBe(secondEdit.replacementEntryId);
		expect(await t.owner.revise({ entryId: second, action: "select" })).toMatchObject({
			entryId: second,
			leafEntryId: secondAnswer,
			status: "selected",
		});
		expect(t.last("user")).toBe(second);
		expect(await t.owner.revise({ entryId: first, action: "select" })).toMatchObject({
			entryId: first,
			leafEntryId: secondAnswer,
			status: "selected",
		});
		expect(await t.owner.revise({ entryId: secondEdit.replacementEntryId, action: "select" })).toMatchObject({
			entryId: secondEdit.replacementEntryId,
			leafEntryId: secondEdit.assistantEntryId,
			status: "selected",
		});
		expect(t.last("user")).toBe(secondEdit.replacementEntryId);
		expect(t.model.calls).toHaveLength(calls);
	});

	test("a single prompt or an unknown entry has no revisions and projection caches follow the owner", async () => {
		const t = await tree();
		const only = await t.prompt("only");
		const revisions = new PromptRevisions();
		expect(revisions.revision(t.session, only)).toBeUndefined();
		const other = await tree();
		const prompt = await other.prompt("other");
		expect(revisions.revision(other.session, prompt)).toBeUndefined();
		expect(revisions.revision(other.session, "missing-entry")).toBeUndefined();
		await expect(other.owner.revise({ entryId: only, action: "select" })).rejects.toMatchObject({
			code: "invalid_input",
		});
	});

	test("forwards the real admission fence and accepted run, and refuses cancelled navigation", async () => {
		const t = await tree();
		const original = await t.prompt("original");
		const events: string[] = [];
		let accepted = false;
		const result = await t.owner.revise(
			{ entryId: original, body: "edited" },
			{
				onPreflightAcceptCommit: async () => {
					events.push("commit");
				},
				onRunAccepted: handle => {
					accepted = typeof handle.scope.attemptId === "string";
					events.push("accepted");
				},
			},
		);
		expect(result.status).toBe("completed");
		expect(events).toEqual(["commit", "accepted"]);
		expect(accepted).toBe(true);
		const user = t.last("user");
		const calls = t.model.calls.length;
		t.cancelNavigation();
		await expect(t.owner.revise({ entryId: original, action: "select" })).rejects.toMatchObject({
			code: "revision_cancelled",
		});
		expect(t.last("user")).toBe(user);
		expect(t.model.calls).toHaveLength(calls);
	});
});
