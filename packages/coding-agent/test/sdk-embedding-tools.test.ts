import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AttemptRunHandle } from "@gajae-code/agent-core/attempt-scope";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockModel } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { YAML } from "bun";
import * as z from "zod/v4";
import type { ExtensionError } from "../src/extensibility/extensions/types";
import {
	createEmbeddedAgentSession,
	type EmbeddedAgentSessionOptions,
	type EmbeddedAgentSessionResult,
	getEmbeddedAvailableModels,
	getEmbeddedPromptRevision,
	validateEmbeddedConfigPatch,
} from "../src/sdk/embedding";
import { createSdkPreferenceControls } from "../src/sdk/preference-controls";
import type { ExecutionSelectionPublication } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { resumeDigest } from "../src/session/native-resume";
import { OWNER_ENROLL_CUSTOM_TYPE } from "../src/session/resume-cursor";
import { SessionManager } from "../src/session/session-manager";
import { BUILTIN_TOOLS } from "../src/tools";

describe("SDK embedding tool docs", () => {
	it("only documents built-in tool names", async () => {
		const docs = await Bun.file(path.resolve(import.meta.dir, "../../../docs/sdk-embedding.md")).text();
		const arrays = [...docs.matchAll(/toolNames:\s*\[([^\]]*)]/g)];
		const names = arrays.flatMap(match => match[1]?.match(/"([^"]+)"/g) ?? []);
		expect(names.map(name => name.slice(1, -1)).every(name => name in BUILTIN_TOOLS)).toBe(true);
	});
});

describe("SDK embedding factory controls", () => {
	const owners: Array<{ dir: TempDir; auth: AuthStorage; result?: EmbeddedAgentSessionResult }> = [];
	const restores: Array<() => void> = [];

	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		for (const owner of owners.splice(0).reverse()) {
			await owner.result?.releaseResources();
			owner.auth.close();
			owner.dir.removeSync();
		}
	});

	async function open(overrides: Partial<EmbeddedAgentSessionOptions> = {}): Promise<{
		result: EmbeddedAgentSessionResult;
		model: MockModel;
		cwd: string;
		agentDir: string;
		auth: AuthStorage;
	}> {
		const dir = TempDir.createSync("sdk-embedding-factory-");
		const cwd = path.join(dir.path(), "workspace");
		const agentDir = path.join(dir.path(), "agent");
		await fs.mkdir(cwd, { recursive: true });
		const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const owner: { dir: TempDir; auth: AuthStorage; result?: EmbeddedAgentSessionResult } = { dir, auth };
		owners.push(owner);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled test model");
		auth.setRuntimeApiKey(bundled.provider, "test-only-key");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				recipe: { enabled: false },
				compaction: { enabled: false },
				retry: { enabled: false },
				tools: { discoveryMode: "off" },
				modelRoles: { default: `${bundled.provider}/${bundled.id}` },
			}),
		);
		const result = await createEmbeddedAgentSession({
			cwd,
			agentDir,
			authStorage: auth,
			model: bundled,
			storage: { directory: path.join(dir.path(), "sessions") },
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
			...overrides,
		});
		owner.result = result;
		const model = createMockModel({ handler: { content: ["embedded answer"] } });
		// Exercise the real factory and prompt engine; only the provider transport is local.
		result.session.agent.streamFn = model.stream;
		return { result, model, cwd, agentDir, auth };
	}

	async function prompt(result: EmbeddedAgentSessionResult, text: string): Promise<string> {
		await result.session.prompt(text);
		await result.session.waitForIdle();
		await result.session.awaitSessionSettlement();
		const user = result.session.sessionManager
			.getBranch()
			.findLast(entry => entry.type === "message" && entry.message.role === "user");
		if (!user) throw new Error("Expected real user entry");
		return user.id;
	}

	it("materializes actual tools and initializes its extension runner only once", async () => {
		let starts = 0;
		const errors: Error[] = [];
		const { result, model } = await open({
			toolNames: ["read", "embedded_lookup"],
			extensions: [
				api => {
					api.on("session_start", () => {
						starts++;
					});
					api.registerTool({
						name: "embedded_lookup",
						label: "Embedded lookup",
						description: "Local embedding test tool",
						parameters: z.object({}),
						async execute() {
							return { content: [{ type: "text", text: "local lookup" }] };
						},
					});
				},
			],
		});
		expect(result.session.getActiveToolNames()).toContain("read");
		expect(result.session.getActiveToolNames()).toContain("embedded_lookup");
		const tool = result.session.getToolByName("embedded_lookup");
		if (!tool) throw new Error("Expected materialized extension tool");
		expect((await tool.execute("local-call", {})).content).toEqual([{ type: "text", text: "local lookup" }]);
		const uiOptions = {
			reportSendError: (_action: string, error: Error) => {
				errors.push(error);
			},
			reportRuntimeError: (error: ExtensionError) => {
				errors.push(new Error(error.error));
			},
		};
		const runner = result.session.extensionRunner;
		if (!runner) throw new Error("Expected real extension runner");
		const firstContext = { ...runner.getUIContext() };
		const first = result.initializeUI({ ...uiOptions, uiContext: firstContext });
		expect(result.initializeUI(uiOptions)).toBe(first);
		await first;
		const secondContext = { ...runner.getUIContext() };
		await result.initializeUI({ ...uiOptions, uiContext: secondContext });
		expect(runner.getUIContext()).toBe(secondContext);
		expect(starts).toBe(1);
		expect(errors).toEqual([]);
		expect(model.calls).toHaveLength(0);
	});

	it("revises through real prompt acceptance callbacks and durably selects answered sibling branches with exact owned writes", async () => {
		const { result, model } = await open();
		const original = await prompt(result, "original");
		const manager = result.session.sessionManager;
		const originalLeaf = manager.getLeafId();
		const accepted: AttemptRunHandle[] = [];
		let commits = 0;
		const revised = await result.revise(
			{ entryId: original, body: "revised" },
			{
				onPreflightAcceptCommit: () => {
					commits++;
				},
				onRunAccepted: handle => {
					accepted.push(handle);
				},
			},
		);
		if (revised.status !== "completed") throw new Error("Expected completed revision");
		expect(commits).toBe(1);
		expect(accepted.length).toBeGreaterThan(0);
		expect(model.calls).toHaveLength(2);
		expect(result.session.activePromptHandle).toBeUndefined();
		expect(manager.getLeafId()).toBe(revised.assistantEntryId);
		expect(getEmbeddedPromptRevision(result.session, original)).toEqual({
			index: 0,
			count: 2,
			next: revised.replacementEntryId,
		});
		expect(getEmbeddedPromptRevision(result.session, revised.replacementEntryId)).toEqual({
			index: 1,
			count: 2,
			previous: original,
		});
		const projection = getEmbeddedPromptRevision(result.session, original);
		if (!projection) throw new Error("Expected sibling projection");
		projection.count = 99;
		expect(getEmbeddedPromptRevision(result.session, original)?.count).toBe(2);
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected transcript");
		const transcript = await Bun.file(file).text();
		const entries = manager.getEntries();
		const revisions = manager.revisionSnapshot();
		const navigate = result.session.navigateTree.bind(result.session);
		const publications: ExecutionSelectionPublication[] = [];
		const navigation = spyOn(result.session, "navigateTree").mockImplementation(async (target, options) => {
			const outcome = await navigate(target, options);
			if (outcome.executionSelection) publications.push(outcome.executionSelection);
			return outcome;
		});
		restores.push(() => navigation.mockRestore());
		const selected = await result.revise({ action: "select", entryId: original });
		const publication = publications[0];
		if (!publication || publication.pending.CB === null) throw new Error("Expected durable answered selection");
		expect(selected).toEqual({
			sessionId: result.session.sessionId,
			entryId: original,
			selected: true,
			status: "selected",
			leafEntryId: publication.pending.CB,
		});
		expect(publication.pending.plan.target).toBe(originalLeaf);
		expect(publication.result.receipt.op).toBe(publication.pending.op);
		expect(publication.result.receipt.commitment.operationComplete).toBe(true);
		expect(publication.result.receipt.commitment.continueEligible).toBe(true);
		expect(result.session.agent.state.messages).toEqual(result.session.buildDisplaySessionContext().messages);
		for (const entry of entries) expect(manager.getEntry(entry.id)).toEqual(entry);
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
		expect(manager.revisionSnapshot()).toEqual({
			...revisions,
			entry: revisions.entry + additions.length,
			leaf: revisions.leaf + 1,
		});
		await manager.flush();
		expect(await Bun.file(file).text()).toBe(
			`${transcript}${additions.map(entry => `${JSON.stringify(entry)}\n`).join("")}`,
		);
		expect(model.calls).toHaveLength(2);
	});

	it("renews revision ownership only after a settled factory branch and rejects a foreign adoption", async () => {
		let cancel = true;
		const { result, model } = await open({
			extensions: [
				api => {
					api.on("session_before_branch", () => (cancel ? { cancel: true } : undefined));
				},
			],
		});
		const first = await prompt(result, "first");
		const second = await prompt(result, "second");
		const manager = result.session.sessionManager;
		const identity = manager.getSessionIdentityGeneration();
		const sessionId = result.session.sessionId;
		expect(await result.branch(second)).toEqual({ selectedText: "second", cancelled: true });
		expect(manager.getSessionIdentityGeneration()).toBe(identity);
		cancel = false;
		expect(await result.branch(second)).toEqual({ selectedText: "second", cancelled: false });
		expect(manager.getSessionIdentityGeneration()).toBe(identity + 1);
		expect(result.session.sessionId).not.toBe(sessionId);
		expect(manager.getBranch().some(entry => entry.id === first)).toBe(true);
		expect(manager.getBranch().some(entry => entry.id === second)).toBe(false);
		const revised = await result.revise({ entryId: first, body: "branched revision" });
		expect(revised.status).toBe("completed");
		expect(model.calls).toHaveLength(3);
		await result.session.newSession();
		await expect(result.revise({ entryId: first, body: "stale" })).rejects.toMatchObject({ code: "resource_gone" });
		await expect(result.branch(first)).rejects.toMatchObject({ code: "resource_gone" });
	});

	it("rechecks an awaited preflight callback before accepting a competing branch", async () => {
		const { result, model } = await open();
		const original = await prompt(result, "original");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pending = result.revise(
			{ entryId: original, body: "must not publish" },
			{
				onPreflightAcceptCommit: async () => {
					entered.resolve();
					await release.promise;
				},
			},
		);
		void pending.catch(() => {});
		try {
			await Promise.race([
				entered.promise,
				pending.then(() => {
					throw new Error("Revision settled before host admission");
				}),
			]);
			const manager = result.session.sessionManager;
			const competing = manager.appendMessage({ role: "user", content: "foreign work", timestamp: 3 });
			const entries = manager.getEntries();
			release.resolve();
			await expect(pending).rejects.toMatchObject({ code: "resource_gone", rollbackFailed: false });
			expect(manager.getLeafId()).toBe(competing);
			expect(manager.getEntries()).toEqual(entries);
			expect(model.calls).toHaveLength(1);
		} finally {
			release.resolve();
			await pending.catch(() => {});
		}
	});

	it("rejects foreign authority and busy revisions without starting another run", async () => {
		const { result, model } = await open();
		const original = await prompt(result, "original");
		await expect(
			result.revise({ entryId: original, body: "foreign", sessionId: "foreign" } as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		model.push(async () => {
			entered.resolve();
			await release.promise;
			return { content: ["independent"] };
		});
		const pending = result.session.prompt("independent");
		try {
			await entered.promise;
			await expect(result.revise({ entryId: original, body: "competing" })).rejects.toMatchObject({ code: "busy" });
			expect(result.session.isStreaming).toBe(true);
		} finally {
			release.resolve();
			await pending;
			await result.session.waitForIdle();
		}
		expect(model.calls).toHaveLength(2);
	});

	it("refreshes commands from its own project and models using its credential identity", async () => {
		const { result, cwd } = await open();
		await Bun.write(path.join(cwd, ".gjc", "commands", "embedded.md"), "Embedded command text");
		const setCommands = spyOn(result.session, "setSlashCommands");
		restores.push(() => setCommands.mockRestore());
		await result.refreshCommands();
		expect(setCommands.mock.calls.at(-1)?.[0].some(command => command.name === "embedded")).toBe(true);
		const refresh = spyOn(result.session.modelRegistry, "refresh");
		restores.push(() => refresh.mockRestore());
		await result.refreshModels("offline");
		expect(refresh).toHaveBeenCalledWith("offline", result.session.credentialSessionId);
		expect(getEmbeddedAvailableModels(result.session).some(model => model.provider === "anthropic")).toBe(true);
	});

	it("filters unavailable credential pins while retaining explicit runtime-key precedence", async () => {
		const { result, auth } = await open();
		const models = result.session.getAvailableModels();
		expect(models.some(model => model.provider === "anthropic")).toBe(true);
		const available = spyOn(result.session, "getAvailableModels").mockReturnValue(models);
		restores.push(() => available.mockRestore());
		auth.markSessionCredentialUnavailable(result.session.credentialSessionId, "anthropic", {
			kind: "id",
			value: "missing-test-credential",
		});
		expect(getEmbeddedAvailableModels(result.session).some(model => model.provider === "anthropic")).toBe(true);
		auth.removeRuntimeApiKey("anthropic");
		expect(getEmbeddedAvailableModels(result.session).some(model => model.provider === "anthropic")).toBe(false);
	});

	it("rejects model refresh completion after identity changes instead of publishing stale success", async () => {
		const { result } = await open();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refresh = spyOn(result.session.modelRegistry, "refresh").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		restores.push(() => refresh.mockRestore());
		const pending = result.refreshModels("offline");
		void pending.catch(() => {});
		try {
			await entered.promise;
			await result.session.newSession();
			release.resolve();
			await expect(pending).rejects.toThrow("Session changed while refreshing models");
		} finally {
			release.resolve();
			await pending.catch(() => {});
		}
	});

	it("rejects asynchronous command publication and extension initialization after a transition starts", async () => {
		const { result } = await open();
		const commands = result.refreshCommands();
		void commands.catch(() => {});
		const initialization = result.initializeUI({ reportSendError() {}, reportRuntimeError() {} });
		void initialization.catch(() => {});
		const transition = result.session.newSession();
		try {
			await expect(commands).rejects.toThrow("Session changed while refreshing commands");
			await expect(initialization).rejects.toThrow("Session changed before extension initialization");
		} finally {
			await transition;
		}
	});

	it("uses the global model enrollment view for control-only owners and denies conversation controls", async () => {
		const { result, model } = await open({ controlOnly: true, storage: { persist: false } });
		expect(result.session.sessionManager.getSessionFile()).toBeUndefined();
		expect(result.session.getActiveToolNames()).toEqual([]);
		await expect(result.refreshCommands()).rejects.toThrow("control-only");
		await expect(result.revise({ entryId: "not-owned", body: "no run" })).rejects.toMatchObject({
			code: "resource_gone",
		});
		await expect(result.branch("not-owned")).rejects.toMatchObject({ code: "resource_gone" });
		const refresh = spyOn(result.session.modelRegistry, "refresh");
		restores.push(() => refresh.mockRestore());
		await result.refreshModels("offline");
		expect(refresh).toHaveBeenCalledWith("offline");
		expect(model.calls).toHaveLength(0);
	});

	it("validates patches without granting writes and applies real session-scoped preferences", async () => {
		const { result } = await open();
		expect(validateEmbeddedConfigPatch({ "compaction.enabled": "invalid" }).length).toBeGreaterThan(0);
		expect(result.session.settings.get("compaction.enabled")).toBe(false);
		const controls = createSdkPreferenceControls(result.session);
		try {
			const outcome = await controls.patchConfig({ scope: "session", patch: { "compaction.enabled": true } });
			expect(outcome).toMatchObject({ applied: true, durability: "session" });
			expect(result.session.settings.get("compaction.enabled")).toBe(true);
		} finally {
			controls.dispose();
		}
	});

	it("joins actual teardown and coalesces dependency release, then rejects retired controls", async () => {
		const { result } = await open();
		const original = await prompt(result, "retained");
		const first = result.releaseResources();
		expect(result.releaseResources()).toBe(first);
		await first;
		expect(result.session.sessionLifecycle.disposed).toBe(true);
		await expect(result.revise({ entryId: original, body: "retired" })).rejects.toMatchObject({
			code: "resource_gone",
		});
		await expect(result.branch(original)).rejects.toMatchObject({ code: "resource_gone" });
		await expect(result.refreshModels("offline")).rejects.toThrow("Session changed");
		await expect(result.refreshCommands()).rejects.toThrow("Session changed");
		expect(() => result.initializeUI({ reportSendError() {}, reportRuntimeError() {} })).toThrow("Session changed");
	});

	it("rejects a supplied manager from a different project before constructing a session", async () => {
		const dir = TempDir.createSync("sdk-embedding-foreign-");
		try {
			const manager = SessionManager.inMemory(path.join(dir.path(), "foreign"));
			await expect(
				createEmbeddedAgentSession({
					cwd: dir.path(),
					agentDir: path.join(dir.path(), "agent"),
					storage: { directory: path.join(dir.path(), "sessions"), manager },
				}),
			).rejects.toThrow("Session project does not match catalog");
			await manager.close();
		} finally {
			dir.removeSync();
		}
	});
});
