import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { assistantMsg, userMsg } from "./utilities";

describe("issue #986 compaction auth fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-986-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(options?: { fallbackModelRole?: string; configureFallbackAuth?: boolean }) {
		const currentModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
		if (options?.fallbackModelRole) {
			settings.setModelRole(options.fallbackModelRole, `${fallbackModel.provider}/${fallbackModel.id}`);
		}

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "codex-token");
		if (options?.configureFallbackAuth !== false) {
			authStorage.setRuntimeApiKey(fallbackModel.provider, "anthropic-token");
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		return { currentModel, fallbackModel };
	}

	it("falls back to an authenticated role model when the current provider returns auth_unavailable", async () => {
		const { currentModel, fallbackModel } = await createSession({ fallbackModelRole: "default" });
		const events: Array<{ type: string; source?: string; message?: string }> = [];
		session.subscribe(event => events.push(event as (typeof events)[number]));
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(
					"Turn prefix summarization failed: 503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)",
				);
			}
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "fallback summary",
				shortSummary: "fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		const substitution = events.find(
			event => event.type === "notice" && event.source === "compaction-recovery" && event.message,
		);
		expect(substitution?.message).toContain(
			`Compaction recovery switched model from ${currentModel.provider}/${currentModel.id} to ${fallbackModel.provider}/${fallbackModel.id}`,
		);
		expect(substitution?.message).toContain("modelRoles.default");
		expect(substitution?.message).toContain("candidate credentials unavailable");
	});

	it("fails fast with a clear provider-specific error when no authenticated fallback exists", async () => {
		const { currentModel, fallbackModel } = await createSession({
			fallbackModelRole: "default",
			configureFallbackAuth: true,
		});
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(
					"Summarization failed: 503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)",
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			return undefined;
		});

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${fallbackModel.provider}/${fallbackModel.id}`,
		);
		expect((error as Error).message).not.toMatch(/auth_unavailable/i);
		expect((error as Error).message).not.toContain("Credential diagnostic unavailable.");
	});

	it("surfaces an SSE stall without dispatching an implicit model fallback", async () => {
		const { currentModel } = await createSession();
		const stall = "Turn prefix summarization failed: OpenAI Codex SSE stream stalled while waiting for the next event";
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error(stall));

		const error = await session.compact().catch(err => err);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [, dispatchedModel] = compactSpy.mock.calls[0]!;
		expect(`${dispatchedModel.provider}/${dispatchedModel.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("OpenAI Codex SSE stream stalled while waiting for the next event");
		expect((error as Error).message).not.toContain("Credential diagnostic unavailable.");
	});

	it("reports an auto-compaction SSE stall without retrying an implicit model", async () => {
		const { currentModel } = await createSession();
		session.settings.set("retry.maxRetries", 0);
		const endEvents: Array<{ errorMessage?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") endEvents.push(event);
		});
		const stall = "Turn prefix summarization failed: OpenAI Codex SSE stream stalled while waiting for the next event";
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error(stall));

		await session.runIdleCompaction();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [, dispatchedModel] = compactSpy.mock.calls[0]!;
		expect(`${dispatchedModel.provider}/${dispatchedModel.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]?.errorMessage).toContain("OpenAI Codex SSE stream stalled while waiting for the next event");
	});
});
