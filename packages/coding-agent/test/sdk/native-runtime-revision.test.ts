import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel, type ImageContent } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import { createSessionImageInput } from "../../src/sdk/image-input";
import {
	consentEmbeddedDisconnect,
	currentEmbeddedResumeOperation,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { invokeNativeRuntime, NativeRuntimeRefusal } from "../../src/sdk/native-lifecycle";
import { AuthStorage } from "../../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const PNG: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-revision-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled fixture model");
	auth.setRuntimeApiKey(model.provider, "test-only-key");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			tools: { discoveryMode: "off" },
			modelRoles: { default: `${model.provider}/${model.id}` },
		}),
	);
	const opened = await createEmbeddedAgentSession({
		cwd,
		agentDir,
		authStorage: auth,
		model,
		storage: { directory: path.join(root, "sessions") },
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMcpAutoload: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferMemoryBackendStartup: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		toolNames: ["read"],
	});
	if (opened.kind !== "opened") throw new Error(`Expected native open, got ${opened.kind}`);
	opened.result.session.agent.streamFn = createMockModel({ handler: { content: ["answer"] } }).stream;
	const cleanup = async (): Promise<void> => {
		if (opened.result.session.sessionManager.getStrictCloseState().kind === "none_started") {
			const op = currentEmbeddedResumeOperation(opened.handle);
			const preparation = await prepareEmbeddedDisconnect(opened.handle, op);
			if (!preparation.inventory) throw new Error("Missing native work inventory");
			const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory, targets: [] },
			});
			if (!consent) throw new Error("Missing native termination consent");
			await terminateEmbeddedAgentSession(opened.handle, { op, consent });
		}
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	};
	cleanups.push(cleanup);
	return opened;
}

function userEntries(session: Opened["result"]["session"]) {
	return session.sessionManager
		.getEntries()
		.filter(entry => entry.type === "message" && entry.message.role === "user");
}

async function expectPersistedImage(session: Opened["result"]["session"], text: string): Promise<void> {
	const file = session.sessionFile;
	if (!file) throw new Error("Missing native transcript");
	await session.sessionManager.flush();
	expect(Bun.JSONL.parse(await Bun.file(file).text())).toContainEqual(
		expect.objectContaining({
			type: "message",
			message: expect.objectContaining({
				role: "user",
				content: [{ type: "text", text }, PNG],
			}),
		}),
	);
}

describe("native runtime images", () => {
	it("delivers bounded PNG input to the provider and native transcript", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const mock = createMockModel({ handler: { content: ["image answer"] } });
		session.agent.streamFn = mock.stream;
		let commits = 0;
		const result = await opened.runtime.images.prompt("inspect PNG", [PNG], {
			expandPromptTemplates: false,
			onPreflightAcceptCommit: () => {
				commits++;
			},
		});
		expect(result.kind).toBe("applied");
		await session.waitForIdle();
		expect(commits).toBe(1);
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0]!.context.messages).toContainEqual(
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "inspect PNG" }, PNG] }),
		);
		await expectPersistedImage(session, "inspect PNG");
	});

	it("refuses raw image ingress before any provider or transcript effect", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const mock = createMockModel({ handler: { content: ["must not run"] } });
		session.agent.streamFn = mock.stream;
		const file = session.sessionFile;
		if (!file) throw new Error("Missing native transcript");
		const bytes = await Bun.file(file).text();
		const operation = currentEmbeddedResumeOperation(opened.handle);
		const raw = createSessionImageInput(session);

		await expect(raw.prompt("raw PNG", [PNG])).rejects.toMatchObject({ reason: "context_mismatch" });
		await expect(raw.submitUserMessage("raw queued PNG", [PNG], { deliverAs: "followUp" })).rejects.toMatchObject({
			reason: "context_mismatch",
		});
		expect(mock.calls).toHaveLength(0);
		expect(userEntries(session)).toHaveLength(0);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(currentEmbeddedResumeOperation(opened.handle)).toBe(operation);
		expect(await Bun.file(file).text()).toBe(bytes);
	});

	it("preserves tracked image queue admission, delivery and terminal receipts", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["seed answer"] };
				},
				{ content: ["queued image answer"] },
			],
		});
		session.agent.streamFn = mock.stream;
		const active = opened.runtime.prompt.prompt("seed conversation");
		try {
			await entered.promise;
			const queued = await opened.runtime.images.submitUserMessage("queued PNG", [PNG], {
				deliverAs: "followUp",
				queuePolicy: "sequential",
			});
			expect(queued.kind).toBe("applied");
			if (queued.kind !== "applied") throw new Error(`Image queue refused: ${queued.reason}`);
			const submission = queued.value;
			expect(await submission.admitted).toEqual({
				submissionId: submission.submissionId,
				delivery: "followUp",
				queuePolicy: "sequential",
			});
			expect(mock.calls).toHaveLength(1);
			release.resolve();
			expect((await active).kind).toBe("applied");
			const execution = await submission.execution;
			expect(execution).toMatchObject({
				submissionId: submission.submissionId,
				delivery: "followUp",
				disposition: "joined-current-run",
			});
			if (execution.disposition !== "joined-current-run") throw new Error("Image follow-up did not join its active run");
			expect(await submission.terminal).toEqual({
				submissionId: submission.submissionId,
				delivery: "followUp",
				disposition: "completed",
				attemptScope: execution.attemptScope,
			});
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(2);
			expect(mock.calls[1]!.context.messages).toContainEqual(
				expect.objectContaining({ role: "user", content: [{ type: "text", text: "queued PNG" }, PNG] }),
			);
			await expectPersistedImage(session, "queued PNG");
		} finally {
			release.resolve();
			await active;
			await session.waitForIdle();
		}
	});

	it("obtains a successor image controller lazily after an admitted view transition", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const mock = createMockModel({ handler: { content: ["answer"] } });
		session.agent.streamFn = mock.stream;
		expect((await opened.runtime.images.prompt("first PNG", [PNG])).kind).toBe("applied");
		await session.waitForIdle();
		const predecessor = createSessionImageInput(session);
		const generation = session.sessionLifecycle.generation;
		const edited = await opened.runtime.session.revise({
			entryId: userEntries(session)[0]!.id,
			action: "edit",
			body: "edited prompt",
		});
		expect(edited.kind).toBe("applied");
		await session.waitForIdle();
		expect(session.sessionLifecycle.generation).toBeGreaterThan(generation);
		const before = mock.calls.length;
		expect((await opened.runtime.images.prompt("successor PNG", [PNG])).kind).toBe("applied");
		await session.waitForIdle();
		expect(createSessionImageInput(session)).not.toBe(predecessor);
		expect(mock.calls).toHaveLength(before + 1);
		expect(mock.calls[before]!.context.messages).toContainEqual(
			expect.objectContaining({ role: "user", content: [{ type: "text", text: "successor PNG" }, PNG] }),
		);
		await expectPersistedImage(session, "successor PNG");
	});

	it("keeps image validation inside the admitted wrapper", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		const mock = createMockModel({ handler: { content: ["must not run"] } });
		session.agent.streamFn = mock.stream;
		await expect(opened.runtime.images.prompt("invalid PNG", [{ ...PNG, data: "not base64" }])).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(mock.calls).toHaveLength(0);
		expect(userEntries(session)).toHaveLength(0);
	});
});

describe("native runtime view transitions", () => {
	it("keeps dispatching after a revision edit advances the session generation", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();
		const generationBefore = session.sessionLifecycle.generation;

		const edited = await invokeNativeRuntime(opened.handle, "session", () =>
			opened.result.revise({ entryId: userEntries(session)[0]!.id, action: "edit", body: "edited prompt" }),
		);
		expect(edited.kind).toBe("applied");
		await session.waitForIdle();
		// The edit navigates the tree, so the view generation really did advance.
		expect(session.sessionLifecycle.generation).toBeGreaterThan(generationBefore);

		const next = await opened.runtime.prompt.prompt("after edit");
		expect(next.kind).toBe("applied");
		await session.waitForIdle();
	});

	it("adopts the cursor a durable selection committed", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();
		expect((await opened.runtime.prompt.prompt("second")).kind).toBe("applied");
		await session.waitForIdle();
		// Editing the first prompt forks a sibling branch, so selecting the retained one
		// has to move the execution leaf instead of resolving to the active tail.
		const edited = await invokeNativeRuntime(opened.handle, "session", () =>
			opened.result.revise({ entryId: userEntries(session)[0]!.id, action: "edit", body: "edited prompt" }),
		);
		expect(edited.kind).toBe("applied");
		await session.waitForIdle();

		const before = currentEmbeddedResumeOperation(opened.handle);
		const retained = userEntries(session).find(entry => entry.id !== userEntries(session)[0]!.id);
		if (!retained) throw new Error("Missing retained user prompt");
		const selected = await invokeNativeRuntime(opened.handle, "session", () =>
			opened.result.revise({ entryId: retained.id, action: "select" }),
		);
		expect(selected.kind).toBe("applied");
		expect(currentEmbeddedResumeOperation(opened.handle)).not.toBe(before);

		expect((await opened.runtime.prompt.prompt("after selection")).kind).toBe("applied");
		await session.waitForIdle();
	});

	it("refuses raw new-session ingress before switching the native transcript", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("before refused rotation")).kind).toBe("applied");
		await session.waitForIdle();
		const file = session.sessionFile;
		if (!file) throw new Error("Missing native transcript");
		const bytes = await Bun.file(file).text();
		const lifecycle = { ...session.sessionLifecycle };
		const identity = session.sessionId;
		const operation = currentEmbeddedResumeOperation(opened.handle);

		await expect(session.newSession()).rejects.toBeInstanceOf(NativeRuntimeRefusal);
		expect(session.sessionLifecycle).toEqual(lifecycle);
		expect(session.sessionId).toBe(identity);
		expect(session.sessionFile).toBe(file);
		expect(currentEmbeddedResumeOperation(opened.handle)).toBe(operation);
		expect(await Bun.file(file).text()).toBe(bytes);
		expect((await opened.runtime.prompt.prompt("after refused rotation")).kind).toBe("applied");
		await session.waitForIdle();
		expect(userEntries(session)).toHaveLength(2);
	});

	it("refuses a view transition attempted outside its own admitted dispatch", async () => {
		const opened = await fixture();
		const session = opened.result.session;
		expect((await opened.runtime.prompt.prompt("first")).kind).toBe("applied");
		await session.waitForIdle();

		// A raw tree move is not this runtime's admitted work: the entry point itself
		// refuses, so nothing is adopted and the runtime stays coherent.
		await expect(session.navigateTree(userEntries(session)[0]!.id)).rejects.toBeInstanceOf(NativeRuntimeRefusal);
		expect((await opened.runtime.prompt.prompt("after refused navigation")).kind).toBe("applied");
		await session.waitForIdle();
	});
});
