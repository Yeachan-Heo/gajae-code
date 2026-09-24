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
const providerAlias = "openai-codex-device";
const selector = (model: Model) => `${model.provider}/${model.id}`;
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function usageLimitStream(
	model: Model,
	trigger: "quota" | "rate_limit" | "credential",
	retryMaxAttempts?: number,
	retryAfterMs?: number,
): AssistantMessageEventStream {
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
				: trigger === "credential"
					? "This model is not supported when using Codex with a ChatGPT account"
					: "Codex error event: Rate limit exceeded (code=rate_limit_exceeded)",
		timestamp: Date.now(),
		transportFailure:
			trigger === "quota"
				? {
						kind: "transport",
						providerCode: "usage_limit_reached",
						...(retryAfterMs === undefined ? {} : { headers: { "retry-after-ms": String(retryAfterMs) } }),
						...(retryMaxAttempts === undefined ? {} : { retryMaxAttempts }),
					}
				: trigger === "credential"
					? {
							kind: "transport",
							status: 400,
							providerCode: "invalid_request_error",
							credentialModelUnavailable: true,
							headers: { "retry-after": "3600" },
							...(retryMaxAttempts === undefined ? {} : { retryMaxAttempts }),
						}
					: {
							kind: "transport",
							status: 429,
							providerCode: "rate_limit_exceeded",
							...(retryAfterMs === undefined ? {} : { headers: { "retry-after-ms": String(retryAfterMs) } }),
							...(retryMaxAttempts === undefined ? {} : { retryMaxAttempts }),
						},
	};
	const classifiedTrigger = classifyFallbackTrigger(message.transportFailure);
	expect(classifiedTrigger.class).toBe(trigger);
	if (retryAfterMs !== undefined) expect(classifiedTrigger.retryAfterMs).toBe(retryAfterMs);
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

const scenarios = ["first", "after-tool", "already-exhausted", "unknown-before", "all-blocked"] as const;
const cases = [
	...(["quota", "rate_limit", "credential"] as const).flatMap(trigger =>
		scenarios.map(scenario => ({ scenario, trigger })),
	),
	{ trigger: "credential", scenario: "no-oauth" } as const,
	{ trigger: "credential", scenario: "pinned" } as const,
];

describe("credential marking before re-resolution", () => {
	for (const { scenario, trigger } of cases) {
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
				if (scenario === "all-blocked") {
					const preblockedSession = "preblocked-session";
					await storage.getApiKey(provider, preblockedSession, {
						credentialSelector: { kind: "account", value: "b" },
					});
					const blockedRowId = storage.getSessionCredentialRowId(provider, preblockedSession);
					if (blockedRowId === undefined) throw new Error("Missing secondary OAuth row");
					const markResult = await storage.markUsageLimitReached(provider, preblockedSession, {
						rowId: blockedRowId,
						retryAfterMs: 120_000,
					});
					expect(markResult.state).toBe("marked");
					expect(markResult.failedRowId).toBe(blockedRowId);
					expect(markResult.credentialKind).toBe("oauth");
					expect(markResult.remainingCredentialIds).toHaveLength(1);
				}
				storage.setRuntimePreferredCredentialSelector(provider, { kind: "account", value: "a" });
				if (scenario === "no-oauth") {
					await storage.set(provider, { type: "api_key", key: "synthetic-api-key" });
					storage.removeRuntimePreferredCredentialSelector(provider);
				}
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
				if (scenario === "pinned") {
					storage.setSessionCredentialSelector(session.credentialSessionId, provider, {
						kind: "account",
						value: "a",
					});
				}
				const marks = vi.spyOn(storage, "markUsageLimitReached");
				pending = session.prompt("go");
				await pending;
				await session.waitForIdle();
				if (scenario === "no-oauth" || scenario === "pinned") {
					expect(marks).not.toHaveBeenCalled();
					expect(keys).toHaveLength(1);
					expect(storage.getEarliestUnblockAt(provider)).toBeUndefined();
					if (scenario === "pinned") {
						expect(storage.hasSessionCredentialSelector(provider, session.credentialSessionId)).toBe(true);
						expect(storage.getSessionCredentialRowId(provider, session.credentialSessionId)).toBe(rowAtFailure);
					}
					return;
				}
				if (scenario === "all-blocked") {
					expect(marks).toHaveBeenCalledTimes(1);
					expect(rowAtFailure).toBeDefined();
					expect(keys).toEqual(["TOKEN-a"]);
					expect(storage.getSessionCredentialRowId(provider, session.credentialSessionId)).toBe(rowAtFailure);
					expect(agent.state.messages.at(-1)?.role).toBe("assistant");
					return;
				}
				expect(marks).toHaveBeenCalledTimes(1);
				expect(rowAtFailure).toBeDefined();
				const after = storage.getSessionCredentialRowId(provider, session.credentialSessionId);
				expect(after).toBeDefined();
				expect(after).not.toBe(rowAtFailure);
				if (trigger === "credential") {
					expect(marks.mock.calls[0]?.[2]).not.toHaveProperty("retryAfterMs");
					if (scenario !== "already-exhausted") {
						const unblockAt = storage.getEarliestUnblockAt(provider);
						expect(unblockAt).toBeGreaterThan(Date.now());
						expect(unblockAt).toBeLessThan(Date.now() + 120_000);
					}
				}
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

async function runManagedFallbackQuotaScenario(options: {
	accounts: readonly string[];
	quotaKeys: readonly string[];
	maxAttempts?: number;
	providerRetryMaxAttempts?: number;
	retryAfterMs?: number;
	dispatchGuardLimit?: number;
	failFirstProviderDispatch?: boolean;
	trigger?: "quota" | "rate_limit" | "credential";
	preblockedAccounts?: readonly string[];
	storedApiKeys?: readonly string[];
	runtimeApiKey?: string;
	addApiKeyDuringMark?: string;
	addOAuthAccountAfterExhaustion?: string;
	predecessorModel?: Model;
	secondCodexModel?: Model;
	modelProviderAlias?: boolean;
	canonicalThenAlias?: boolean;
	terminalCodexEntry?: boolean;
	removeFailedCredentialDuringMark?: boolean;
	unknownFailedRowIdFromMark?: boolean;
	unresolvablePeerDuringMark?: boolean;
}): Promise<{
	models: string[];
	keys: string[];
	markCount: number;
	activeIndex?: number;
	dispatchGuardExceeded?: boolean;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-fallback-quota-"));
	let session: AgentSession | undefined;
	const usageProvider: UsageProvider = {
		id: provider,
		async fetchUsage(params): Promise<UsageReport | null> {
			const accountId = params.credential.accountId ?? "unknown";
			return {
				provider,
				fetchedAt: Date.now(),
				limits: [
					{
						id: "requests",
						label: "Requests",
						scope: { provider, accountId },
						amount: { unit: "requests", used: 10, limit: 100 },
						status: "ok",
					},
				],
			};
		},
	};
	const storage = await AuthStorage.create(path.join(root, "auth.db"), {
		usageProviderResolver: currentProvider => (currentProvider === provider ? usageProvider : undefined),
		rankingStrategyResolver: currentProvider => (currentProvider === provider ? strategy : undefined),
	});
	const aliasSourceId = `fixture:${root}`;
	let registeredRegistry: ModelRegistry | undefined;
	let model = getBundledModel(provider, "gpt-5.1-codex");
	let aliasModel: Model | undefined;
	const fallback = getBundledModel("openai", "gpt-4o-mini");
	if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
	let restorePeerResolver: (() => void) | undefined;
	const unresolvablePeerIds = new Set<number>();
	let unknownRowIdInjected = false;
	try {
		await storage.set(provider, [
			...options.accounts.map(accountId => ({
				type: "oauth" as const,
				access: `TOKEN-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 3_600_000,
				accountId,
			})),
			...(options.storedApiKeys ?? []).map(key => ({ type: "api_key" as const, key })),
		]);
		for (const accountId of options.preblockedAccounts ?? []) {
			const preblockedSessionId = `preblocked-${accountId}`;
			await storage.getApiKey(provider, preblockedSessionId, {
				credentialSelector: { kind: "account", value: accountId },
			});
			const blockedRowId = storage.getSessionCredentialRowId(provider, preblockedSessionId);
			if (blockedRowId === undefined) throw new Error(`Missing ${accountId} OAuth row to preblock`);
			const markResult = await storage.markUsageLimitReached(provider, preblockedSessionId, {
				rowId: blockedRowId,
				retryAfterMs: 120_000,
			});
			if (markResult.remainingCredentialIds.length === 0)
				throw new Error(`Could not preblock ${accountId} OAuth row`);
		}
		if (options.accounts.length > 0)
			storage.setRuntimePreferredCredentialSelector(provider, { kind: "account", value: "a" });
		if (options.runtimeApiKey !== undefined) storage.setRuntimeApiKey(provider, options.runtimeApiKey);
		storage.setRuntimeApiKey("openai", "fallback-test-key");
		const registry = new ModelRegistry(storage, path.join(root, "models.yml"));
		registeredRegistry = registry;
		if (options.modelProviderAlias || options.canonicalThenAlias) {
			registry.registerProvider(
				providerAlias,
				{
					baseUrl: model.baseUrl,
					api: model.api,
					oauth: {
						name: "Fixture OAuth",
						async login() {
							return { access: "unused-fixture-token", refresh: "unused-fixture-refresh", expires: Date.now() };
						},
					},
					models: [
						{
							id: model.id,
							name: model.name,
							api: model.api,
							reasoning: model.reasoning,
							input: model.input,
							cost: model.cost,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
							...(model.thinking === undefined ? {} : { thinking: model.thinking }),
						},
					],
				},
				aliasSourceId,
			);
			aliasModel = registry.find(providerAlias, model.id);
			if (!aliasModel) throw new Error("Could not register the Codex device-alias fixture model");
			if (options.modelProviderAlias) model = aliasModel;
		}
		const initialModel = options.predecessorModel ?? model;
		const isCredentialProvider = (requestedProvider: string) =>
			options.modelProviderAlias
				? requestedProvider === providerAlias
				: requestedProvider === provider || (options.canonicalThenAlias && requestedProvider === providerAlias);
		if (options.unresolvablePeerDuringMark) {
			const getApiKeyBeforeMock = registry.getApiKey.bind(registry);
			const getApiKeySpy = vi.spyOn(registry, "getApiKey");
			getApiKeySpy.mockImplementation(async (requestedModel, sessionId, getApiKeyOptions) => {
				const selector = getApiKeyOptions?.credentialSelector;
				if (selector?.kind === "id" && unresolvablePeerIds.has(Number(selector.value))) return undefined;
				return getApiKeyBeforeMock(requestedModel, sessionId, getApiKeyOptions);
			});
			restorePeerResolver = () => getApiKeySpy.mockRestore();
		}
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": options.maxAttempts ?? 3,
			"retry.baseDelayMs": 1,
		});
		settings.setModelRole("default", selector(initialModel));
		const calls: Array<{ model: string; key: string }> = [];
		const quotaKeys = new Set(options.quotaKeys);
		const success = createMockModel({ responses: [{ content: ["accepted"] }] });
		let firstProviderDispatchQuotaInjected = false;
		let providerDispatchCount = 0;
		let dispatchGuardExceeded = false;
		const agent = new Agent({
			initialState: { model: initialModel, systemPrompt: ["Synthetic test"], tools: [], messages: [] },
			convertToLlm: identityConverter,
			getApiKey: async requestedProvider => {
				if (!session) throw new Error("Session not initialized");
				return registry.getApiKeyForProvider(requestedProvider, session.credentialSessionId);
			},
			streamFn: (requestedModel, context, streamOptions) => {
				const key = String(streamOptions?.apiKey);
				calls.push({ model: selector(requestedModel), key });
				if (isCredentialProvider(requestedModel.provider)) {
					providerDispatchCount++;
					if (options.dispatchGuardLimit !== undefined && providerDispatchCount > options.dispatchGuardLimit) {
						dispatchGuardExceeded = true;
						return success.stream(requestedModel, context, streamOptions);
					}
				}
				if (
					isCredentialProvider(requestedModel.provider) &&
					options.failFirstProviderDispatch &&
					!firstProviderDispatchQuotaInjected
				) {
					quotaKeys.add(key);
					firstProviderDispatchQuotaInjected = true;
				}
				if (isCredentialProvider(requestedModel.provider) && quotaKeys.has(key)) {
					return usageLimitStream(
						requestedModel,
						options.trigger ?? "quota",
						options.providerRetryMaxAttempts,
						options.retryAfterMs,
					);
				}
				return success.stream(requestedModel, context, streamOptions);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		const entries = options.predecessorModel
			? options.terminalCodexEntry
				? [selector(options.predecessorModel), selector(model)]
				: [selector(options.predecessorModel), selector(model), selector(fallback)]
			: options.secondCodexModel
				? [selector(model), selector(options.secondCodexModel), selector(fallback)]
				: options.canonicalThenAlias
					? [selector(model), selector(aliasModel!), selector(fallback)]
					: [selector(model), selector(fallback)];
		session.setConfiguredModelChain("default", entries, "test");
		if (options.terminalCodexEntry) session.seedDefaultFallbackResolution(1, []);
		const markBeforeRemoval = storage.markUsageLimitReached.bind(storage);
		const markUsageLimitReached = vi.spyOn(storage, "markUsageLimitReached");
		if (
			options.removeFailedCredentialDuringMark ||
			options.addApiKeyDuringMark !== undefined ||
			options.addOAuthAccountAfterExhaustion !== undefined ||
			options.unknownFailedRowIdFromMark ||
			options.unresolvablePeerDuringMark
		) {
			let removedFailedCredential = false;
			let addedApiKey = false;
			let addedOAuthAccount = false;
			markUsageLimitReached.mockImplementation(async (markProvider, markSessionId, markOptions) => {
				const pendingMark = markBeforeRemoval(markProvider, markSessionId, markOptions);
				if (options.removeFailedCredentialDuringMark && !removedFailedCredential) {
					const rowId =
						markOptions?.rowId ??
						(markSessionId === undefined
							? undefined
							: storage.getSessionCredentialRowId(markProvider, markSessionId));
					if (rowId !== undefined) {
						const removalTarget = storage
							.listCredentialRemovalTargets(markProvider)
							.find(target => target.id === rowId);
						if (!removalTarget) throw new Error("Missing removal target for failed credential row");
						const removal = storage.removeAuthCredentialsHard(markProvider, [removalTarget]);
						if (removal.kind !== "removed") throw new Error("Could not remove failed credential row");
						storage.removeRuntimePreferredCredentialSelector(markProvider);
						removedFailedCredential = true;
					}
				}
				if (markOptions?.rowId !== undefined && options.addApiKeyDuringMark !== undefined && !addedApiKey) {
					storage.upsertCredential(provider, { type: "api_key", key: options.addApiKeyDuringMark });
					addedApiKey = true;
				}
				const markResult = await pendingMark;
				const reportedMarkResult =
					options.unknownFailedRowIdFromMark && !unknownRowIdInjected && markResult.state === "marked"
						? { ...markResult, failedRowId: Number.MAX_SAFE_INTEGER }
						: markResult;
				if (options.unknownFailedRowIdFromMark) unknownRowIdInjected = true;
				if (
					options.addOAuthAccountAfterExhaustion !== undefined &&
					markUsageLimitReached.mock.calls.length >= options.accounts.length &&
					!addedOAuthAccount
				) {
					const accountId = options.addOAuthAccountAfterExhaustion;
					storage.upsertCredential(provider, {
						type: "oauth",
						access: `TOKEN-${accountId}`,
						refresh: `refresh-${accountId}`,
						expires: Date.now() + 3_600_000,
						accountId,
					});
					addedOAuthAccount = true;
				}
				if (options.unresolvablePeerDuringMark) {
					for (const peerId of reportedMarkResult.remainingCredentialIds) unresolvablePeerIds.add(peerId);
				}
				return reportedMarkResult;
			});
		}
		await session.prompt("recover from a Codex quota error");
		await session.waitForIdle();
		return {
			models: calls.map(call => call.model),
			keys: calls.map(call => call.key),
			markCount: markUsageLimitReached.mock.calls.length,
			...(options.dispatchGuardLimit === undefined ? {} : { dispatchGuardExceeded }),
			...(options.predecessorModel
				? { activeIndex: session.getDefaultFallbackRuntimeState().controller.activeIndex }
				: {}),
		};
	} finally {
		restorePeerResolver?.();
		await session?.dispose();
		registeredRegistry?.clearSourceRegistrations(aliasSourceId);
		storage.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("managed fallback quota credential rotation", () => {
	test("retries the same Codex model with the next credential before fallback", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!model) throw new Error("Missing bundled Codex fixture model");
		const result = await runManagedFallbackQuotaScenario({ accounts: ["a", "b"], quotaKeys: ["TOKEN-a"] });
		expect(result).toEqual({
			models: [selector(model), selector(model)],
			keys: ["TOKEN-a", "TOKEN-b"],
			markCount: 1,
		});
	});

	test("keeps same-provider row history independent across model IDs", async () => {
		const modelA = getBundledModel(provider, "gpt-5.1-codex");
		const modelB = getBundledModel(provider, "gpt-5.2-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!modelA || !modelB || !fallback)
			throw new Error("Missing bundled multi-model managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a", "TOKEN-b"],
			retryAfterMs: 0,
			secondCodexModel: modelB,
		});
		expect(result).toEqual({
			models: [selector(modelA), selector(modelA), selector(modelB), selector(modelB), selector(fallback)],
			keys: ["TOKEN-a", "TOKEN-b", "TOKEN-b", "TOKEN-a", "fallback-test-key"],
			markCount: 4,
		});
	});

	test("canonicalizes the device alias inventory before advancing after OAuth exhaustion", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a", "TOKEN-b"],
			addApiKeyDuringMark: "unrelated-codex-api-key",
			modelProviderAlias: true,
		});
		expect(result).toEqual({
			models: [`${providerAlias}/${model.id}`, `${providerAlias}/${model.id}`, selector(fallback)],
			keys: ["TOKEN-a", "TOKEN-b", "fallback-test-key"],
			markCount: 2,
		});
	});

	test("does not redispatch tried OAuth rows through canonical and device-alias chain entries", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a", "TOKEN-b"],
			retryAfterMs: 0,
			dispatchGuardLimit: 6,
			canonicalThenAlias: true,
		});
		expect(result.dispatchGuardExceeded).toBe(false);
		expect(result.models).toEqual([selector(model), selector(model), selector(fallback)]);
		expect(result.keys).toEqual(["TOKEN-a", "TOKEN-b", "fallback-test-key"]);
		expect(result.markCount).toBe(2);
	});

	test("keeps a new same-kind row eligible at a canonical-to-alias duplicate", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!model) throw new Error("Missing bundled managed-fallback fixture model");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a", "TOKEN-b"],
			addOAuthAccountAfterExhaustion: "c",
			retryAfterMs: 0,
			dispatchGuardLimit: 6,
			canonicalThenAlias: true,
		});
		expect(result).toEqual({
			models: [selector(model), selector(model), `${providerAlias}/${model.id}`],
			keys: ["TOKEN-a", "TOKEN-b", "TOKEN-c"],
			markCount: 2,
			dispatchGuardExceeded: false,
		});
	});

	test("does not bypass a provider retry ceiling through a canonical-to-alias duplicate", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a", "TOKEN-b"],
			providerRetryMaxAttempts: 1,
			retryAfterMs: 0,
			dispatchGuardLimit: 4,
			canonicalThenAlias: true,
		});
		expect(result.dispatchGuardExceeded).toBe(false);
		expect(result.models).toEqual([selector(model), selector(fallback)]);
		expect(result.keys).toEqual(["TOKEN-a", "fallback-test-key"]);
		expect(result.markCount).toBe(1);
	});

	test("stays within the failed credential kind when another kind is also stored", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!model) throw new Error("Missing bundled Codex fixture model");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a"],
			addApiKeyDuringMark: "stored-codex-api-key",
		});
		expect(result).toEqual({
			models: [selector(model), selector(model)],
			keys: ["TOKEN-a", "TOKEN-b"],
			markCount: 1,
		});
	});

	test("does not count a different-kind row as an OAuth alternate", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const apiKey = "stored-codex-api-key";
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a"],
			quotaKeys: ["TOKEN-a", apiKey],
			addApiKeyDuringMark: apiKey,
		});
		expect(result.models).toEqual([selector(model), selector(model), selector(model), selector(fallback)]);
		expect(result.keys).toHaveLength(4);
		expect(result.keys[0]).toBe("TOKEN-a");
		for (const key of result.keys.slice(0, 3)) expect(["TOKEN-a", apiKey]).toContain(key);
		expect(result.keys[3]).toBe("fallback-test-key");
		expect(result.markCount).toBe(3);
	});

	test("rotates through API-key rows as the same credential kind", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!model) throw new Error("Missing bundled Codex fixture model");
		const result = await runManagedFallbackQuotaScenario({
			accounts: [],
			quotaKeys: [],
			storedApiKeys: ["stored-codex-key-a", "stored-codex-key-b"],
			failFirstProviderDispatch: true,
		});
		expect(result.models).toEqual([selector(model), selector(model)]);
		expect(result.keys).toHaveLength(2);
		expect(new Set(result.keys).size).toBe(2);
		expect(result.markCount).toBe(1);
	});

	test("does not accept an unresolved stored API-key peer as a rotation", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: [],
			quotaKeys: [],
			storedApiKeys: ["stored-codex-key-a", "stored-codex-key-b"],
			failFirstProviderDispatch: true,
			unresolvablePeerDuringMark: true,
		});
		expect(result.models).toEqual([selector(model), selector(fallback)]);
		expect(["stored-codex-key-a", "stored-codex-key-b"]).toContain(result.keys[0]);
		expect(result.keys.at(-1)).toBe("fallback-test-key");
		expect(result.markCount).toBe(1);
	});

	test("retries from request-bound identity when the mark reports an unknown row ID", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!model) throw new Error("Missing bundled Codex fixture model");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a"],
			maxAttempts: 1,
			unknownFailedRowIdFromMark: true,
		});
		expect(result).toEqual({
			models: [selector(model), selector(model)],
			keys: ["TOKEN-a", "TOKEN-b"],
			markCount: 1,
		});
	});

	test("advances to the next model only after every Codex credential is quota-limited", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a", "TOKEN-b"],
		});
		expect(result).toEqual({
			models: [selector(model), selector(model), selector(fallback)],
			keys: ["TOKEN-a", "TOKEN-b", "fallback-test-key"],
			markCount: 2,
		});
	});

	test("advances when every other stored Codex credential was already quota-limited", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a"],
			preblockedAccounts: ["b"],
		});
		expect(result).toEqual({
			models: [selector(model), selector(fallback)],
			keys: ["TOKEN-a", "fallback-test-key"],
			markCount: 1,
		});
	});

	test("does not treat a row that vanishes during marking as an exhausted pool", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!model) throw new Error("Missing bundled Codex fixture model");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b", "c"],
			quotaKeys: ["TOKEN-a"],
			removeFailedCredentialDuringMark: true,
		});
		expect(result.models).toEqual([selector(model), selector(model)]);
		expect(result.keys[0]).toBe("TOKEN-a");
		expect(["TOKEN-b", "TOKEN-c"]).toContain(result.keys[1]);
		expect(result.markCount).toBe(1);
	});

	test("finds a peer when the failed row vanishes with unknown mark identity", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!model) throw new Error("Missing bundled Codex fixture model");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b", "c"],
			quotaKeys: ["TOKEN-a"],
			maxAttempts: 1,
			removeFailedCredentialDuringMark: true,
			unknownFailedRowIdFromMark: true,
		});
		expect(result.models).toEqual([selector(model), selector(model)]);
		expect(result.keys[0]).toBe("TOKEN-a");
		expect(["TOKEN-b", "TOKEN-c"]).toContain(result.keys[1]);
		expect(result.markCount).toBe(1);
	});

	test("preserves the existing retry budget when the provider has no alternate credential", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a"],
			quotaKeys: ["TOKEN-a"],
		});
		expect(result).toEqual({
			models: [selector(model), selector(model), selector(model), selector(fallback)],
			keys: ["TOKEN-a", "TOKEN-a", "TOKEN-a", "fallback-test-key"],
			markCount: 3,
		});
	});

	test("advances after both Codex accounts are rate-limited", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["TOKEN-a", "TOKEN-b"],
			trigger: "rate_limit",
		});
		expect(result).toEqual({
			models: [selector(model), selector(model), selector(fallback)],
			keys: ["TOKEN-a", "TOKEN-b", "fallback-test-key"],
			markCount: 2,
		});
	});

	for (const trigger of ["quota", "rate_limit"] as const) {
		test(`does not revisit same-kind credentials after zero Retry-After ${trigger} failures`, async () => {
			const model = getBundledModel(provider, "gpt-5.1-codex");
			const fallback = getBundledModel("openai", "gpt-4o-mini");
			if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
			const result = await runManagedFallbackQuotaScenario({
				accounts: ["a", "b", "c"],
				quotaKeys: ["TOKEN-a", "TOKEN-b", "TOKEN-c"],
				trigger,
				retryAfterMs: 0,
				dispatchGuardLimit: 6,
			});
			expect(result.dispatchGuardExceeded).toBe(false);
			expect(result.models).toEqual([selector(model), selector(model), selector(model), selector(fallback)]);
			expect(result.keys[0]).toBe("TOKEN-a");
			expect(result.keys.slice(0, 3).sort()).toEqual(["TOKEN-a", "TOKEN-b", "TOKEN-c"]);
			expect(new Set(result.keys.slice(0, 3)).size).toBe(3);
			expect(result.keys.at(-1)).toBe("fallback-test-key");
			expect(result.markCount).toBe(3);
		});
	}

	test("tries every Codex credential even when the credential pool exceeds the model retry budget", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b", "c"],
			quotaKeys: ["TOKEN-a", "TOKEN-b", "TOKEN-c"],
			maxAttempts: 1,
		});
		expect(result.models).toEqual([selector(model), selector(model), selector(model), selector(fallback)]);
		expect(result.keys[0]).toBe("TOKEN-a");
		expect(result.keys.slice(0, 3).sort()).toEqual(["TOKEN-a", "TOKEN-b", "TOKEN-c"]);
		expect(result.keys.at(-1)).toBe("fallback-test-key");
		expect(result.markCount).toBe(3);
	});

	test("records the final quota failure without exceeding the provider retry ceiling", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b", "c"],
			quotaKeys: ["TOKEN-a", "TOKEN-b", "TOKEN-c"],
			providerRetryMaxAttempts: 2,
		});
		expect(result.models).toEqual([selector(model), selector(model), selector(fallback)]);
		expect(result.keys[0]).toBe("TOKEN-a");
		expect(["TOKEN-b", "TOKEN-c"]).toContain(result.keys[1]);
		expect(result.keys.at(-1)).toBe("fallback-test-key");
		expect(result.markCount).toBe(2);
	});

	test("does not restore a model-unavailable rotation past the provider retry ceiling", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b", "c"],
			quotaKeys: ["TOKEN-a", "TOKEN-b", "TOKEN-c"],
			trigger: "credential",
			providerRetryMaxAttempts: 2,
		});
		expect(result).toEqual({
			models: [selector(model), selector(model), selector(fallback)],
			keys: ["TOKEN-a", "TOKEN-b", "fallback-test-key"],
			markCount: 1,
		});
	});

	test("records the final quota failure without exceeding the ceiling on the final model entry", async () => {
		const predecessor = getBundledModel("anthropic", "claude-sonnet-4-5");
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!predecessor || !model) throw new Error("Missing bundled terminal fallback fixture models");
		const previousAnthropicApiKey = Bun.env.ANTHROPIC_API_KEY;
		const previousAnthropicOAuthToken = Bun.env.ANTHROPIC_OAUTH_TOKEN;
		delete Bun.env.ANTHROPIC_API_KEY;
		delete Bun.env.ANTHROPIC_OAUTH_TOKEN;
		try {
			const result = await runManagedFallbackQuotaScenario({
				accounts: ["a", "b", "c"],
				quotaKeys: ["TOKEN-a", "TOKEN-b", "TOKEN-c"],
				providerRetryMaxAttempts: 2,
				predecessorModel: predecessor,
				terminalCodexEntry: true,
			});
			expect(result.models).toEqual([selector(model), selector(model)]);
			expect(result.keys).toEqual(["TOKEN-a", "TOKEN-b"]);
			expect(result.markCount).toBe(2);
		} finally {
			if (previousAnthropicApiKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
			else Bun.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
			if (previousAnthropicOAuthToken === undefined) delete Bun.env.ANTHROPIC_OAUTH_TOKEN;
			else Bun.env.ANTHROPIC_OAUTH_TOKEN = previousAnthropicOAuthToken;
		}
	});

	test("keeps the active non-head fallback entry when quota rotation retries it", async () => {
		const predecessor = getBundledModel("anthropic", "claude-sonnet-4-5");
		const model = getBundledModel(provider, "gpt-5.1-codex");
		if (!predecessor || !model) throw new Error("Missing bundled non-head fallback fixture models");
		const previousAnthropicApiKey = Bun.env.ANTHROPIC_API_KEY;
		const previousAnthropicOAuthToken = Bun.env.ANTHROPIC_OAUTH_TOKEN;
		delete Bun.env.ANTHROPIC_API_KEY;
		delete Bun.env.ANTHROPIC_OAUTH_TOKEN;
		try {
			const result = await runManagedFallbackQuotaScenario({
				accounts: ["a", "b"],
				quotaKeys: ["TOKEN-a"],
				predecessorModel: predecessor,
			});
			expect(result).toEqual({
				models: [selector(model), selector(model)],
				keys: ["TOKEN-a", "TOKEN-b"],
				markCount: 1,
				activeIndex: 1,
			});
		} finally {
			if (previousAnthropicApiKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
			else Bun.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
			if (previousAnthropicOAuthToken === undefined) delete Bun.env.ANTHROPIC_OAUTH_TOKEN;
			else Bun.env.ANTHROPIC_OAUTH_TOKEN = previousAnthropicOAuthToken;
		}
	});

	test("does not mutate credentials pinned by a runtime API key", async () => {
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("Missing bundled managed-fallback fixture models");
		const result = await runManagedFallbackQuotaScenario({
			accounts: ["a", "b"],
			quotaKeys: ["pinned-codex-key"],
			runtimeApiKey: "pinned-codex-key",
			maxAttempts: 1,
		});
		expect(result).toEqual({
			models: [selector(model), selector(fallback)],
			keys: ["pinned-codex-key", "fallback-test-key"],
			markCount: 0,
		});
	});
});
