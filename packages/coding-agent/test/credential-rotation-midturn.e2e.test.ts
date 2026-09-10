import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Message, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import type { CredentialRankingStrategy, UsageProvider, UsageReport } from "@gajae-code/ai/usage";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { classifyFallbackTrigger } from "@gajae-code/ai/utils/fallback-transport";
import * as oauth from "@gajae-code/ai/utils/oauth";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as z from "zod/v4";

const provider = "openai-codex";
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function usageLimitStream(model: Model, trigger: "quota" | "rate_limit"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage:
			trigger === "quota"
				? "Codex error event: The usage limit has been reached (code=usage_limit_reached)"
				: "Codex error event: Rate limit exceeded (code=rate_limit_exceeded)",
		timestamp: Date.now(),
		transportFailure:
			trigger === "quota"
				? { kind: "transport", providerCode: "usage_limit_reached" }
				: { kind: "transport", status: 429, providerCode: "rate_limit_exceeded" },
	};
	expect(classifyFallbackTrigger(message.transportFailure).class).toBe(trigger);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

const toolSchema = z.object({});
const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
	name: "fixture_step",
	label: "Fixture step",
	description: "Return a synthetic tool result",
	parameters: toolSchema,
	async execute() {
		return { content: [{ type: "text", text: "step complete" }], details: {} };
	},
};

const strategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({ primary: report.limits[0] }),
	windowDefaults: { primaryMs: 3_600_000, secondaryMs: 86_400_000 },
};

const scenarios = ["first", "after-tool", "already-exhausted", "unknown-before"] as const;
const triggers = ["quota", "rate_limit"] as const;

describe("quota and rate-limit marking before credential re-resolution", () => {
	for (const { scenario, trigger } of triggers.flatMap(trigger =>
		scenarios.map(scenario => ({ scenario, trigger })),
	)) {
		test(`${trigger}: ${scenario}`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-quota-replay-"));
			let failureIssued = false;
			let session: AgentSession | undefined;
			let pending: Promise<void> | undefined;
			const usageProvider: UsageProvider = {
				id: provider,
				async fetchUsage(params): Promise<UsageReport | null> {
					const accountId = params.credential.accountId ?? "unknown";
					if (scenario === "already-exhausted" && accountId === "a" && !failureIssued) return null;
					const exhausted = scenario === "already-exhausted" && accountId === "a" && failureIssued;
					return {
						provider,
						fetchedAt: Date.now(),
						limits: [
							{
								id: "requests",
								label: "Requests",
								scope: { provider, accountId },
								amount: { unit: "requests", used: exhausted ? 100 : 10, limit: 100 },
								status: exhausted ? "exhausted" : "ok",
							},
						],
					};
				},
			};
			const storage = await AuthStorage.create(path.join(root, "auth.db"), {
				usageProviderResolver: p => (p === provider ? usageProvider : undefined),
				rankingStrategyResolver: p => (p === provider ? strategy : undefined),
			});
			vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const credential = credentials[provider];
				return credential ? { apiKey: credential.access, newCredentials: credential } : null;
			});
			try {
				await storage.set(
					provider,
					["a", "b"].map(accountId => ({
						type: "oauth" as const,
						access: `TOKEN-${accountId}`,
						refresh: `refresh-${accountId}`,
						expires: Date.now() + 3_600_000,
						accountId,
					})),
				);
				storage.setRuntimePreferredCredentialSelector(provider, { kind: "account", value: "a" });
				const model = getBundledModel(provider, "gpt-5.1-codex");
				if (!model) throw new Error("Missing bundled Codex fixture model");
				const settings = Settings.isolated({ "compaction.enabled": false });
				settings.setModelRole("default", `${provider}/${model.id}`);
				for (const key of ["retry.enabled", "retry.maxRetries", "retry.baseDelayMs", "retry.maxDelayMs"] as const) {
					expect(settings.has(key)).toBe(false);
				}
				const registry = new ModelRegistry(storage, path.join(root, "models.yml"), settings);
				const toolTurn = createMockModel({
					handler: () => ({
						content: [{ type: "toolCall" as const, id: "step-1", name: "fixture_step", arguments: {} }],
					}),
				});
				const success = createMockModel({ responses: [{ content: ["accepted"] }] });
				const keys: string[] = [];
				const failOn = scenario === "after-tool" ? 2 : 1;
				let rowAtFailure: number | undefined;
				const agent = new Agent({
					initialState: { model, systemPrompt: ["Synthetic test"], tools: [tool], messages: [] },
					convertToLlm: identityConverter,
					getApiKey: async () => {
						if (!session) throw new Error("Session not initialized");
						return registry.getApiKey(model, session.credentialSessionId);
					},
					streamFn: (m, context, options) => {
						keys.push(String(options?.apiKey));
						if (keys.length === failOn) {
							failureIssued = true;
							rowAtFailure = storage.getSessionCredentialRowId(provider, session!.credentialSessionId);
							if (scenario === "unknown-before") {
								// Only the mark-time observation is absent; real storage still marks A and resolves B.
								vi.spyOn(storage, "getSessionCredentialRowId").mockReturnValueOnce(undefined);
							}
							return usageLimitStream(m, trigger);
						}
						if (keys.length < failOn) return toolTurn.stream(m, context, options);
						return options?.apiKey === "TOKEN-b"
							? success.stream(m, context, options)
							: usageLimitStream(m, trigger);
					},
				});
				session = new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(),
					settings,
					modelRegistry: registry,
				});
				const marks = vi.spyOn(storage, "markUsageLimitReached");
				pending = session.prompt("go");
				await pending;
				await session.waitForIdle();
				expect(marks).toHaveBeenCalledTimes(1);
				expect(rowAtFailure).toBeDefined();
				const after = storage.getSessionCredentialRowId(provider, session.credentialSessionId);
				expect(after).toBeDefined();
				expect(after).not.toBe(rowAtFailure);
				if (scenario === "unknown-before") {
					expect(keys).toHaveLength(failOn);
					expect(marks.mock.calls[0]?.[2]?.rowId).toBeUndefined();
				} else {
					expect(keys).toHaveLength(failOn + 1);
					expect(keys.at(-1)).toBe("TOKEN-b");
					expect(marks.mock.calls[0]?.[2]?.rowId).toBe(rowAtFailure);
					const last = agent.state.messages.at(-1);
					expect(last?.role).toBe("assistant");
					if (last?.role === "assistant") expect(last.content).toContainEqual({ type: "text", text: "accepted" });
				}
			} finally {
				await session?.dispose();
				if (pending) await Promise.allSettled([pending]);
				vi.restoreAllMocks();
				storage.close();
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}
});
