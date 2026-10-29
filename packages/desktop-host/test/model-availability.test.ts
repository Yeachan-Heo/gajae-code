import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { registerOAuthProvider, unregisterOAuthProviders } from "@gajae-code/ai/core";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { ModelsConfig } from "@gajae-code/coding-agent/config/models-config-schema";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type {
	DesktopAuthState,
	DesktopCredentialSaveResult,
	DesktopFrame,
	DesktopModel,
	DesktopProject,
	DesktopRequest,
	DesktopSession,
} from "../src/protocol";
import { parseRequest } from "../src/protocol";

const provider = "desktop-eligible";
const otherProvider = "desktop-unauthed";
const eligibleIds = [`${provider}/first`, `${provider}/second`];
const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
});
const configuredProviders: NonNullable<ModelsConfig["providers"]> = {
	[provider]: {
		baseUrl: "https://eligible.example.invalid",
		api: "anthropic-messages",
		apiKeyEnv: "GJC_DESKTOP_ELIGIBLE_FIXTURE_KEY",
		models: [model("first"), model("second")],
	},
	[otherProvider]: {
		baseUrl: "https://unauthed.example.invalid",
		api: "anthropic-messages",
		apiKeyEnv: "GJC_DESKTOP_UNAUTHED_FIXTURE_KEY",
		models: [model("hidden")],
	},
};
const ids = (models: readonly DesktopModel[]) => models.map(model => model.id).sort();

/** Availability is always evaluated by real ModelRegistry + AuthStorage, never catalog/list mocks. */
describe("desktop canonical model availability", () => {
	let environment: NodeJS.ProcessEnv;
	let previousAgentDir: string;
	let originalRefresh: ModelRegistry["refresh"];
	const cleanups: Array<() => Promise<void>> = [];
	beforeEach(() => {
		environment = { ...process.env };
		previousAgentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		// Do not probe provider/credential endpoints: exercise the real offline
		// catalog refresh while downgrading only the host's startup online request.
		originalRefresh = ModelRegistry.prototype.refresh;
		vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(function (
			this: ModelRegistry,
			_strategy,
			sessionId,
		) {
			return originalRefresh.call(this, "offline", sessionId);
		});
		const blockedFetch: typeof fetch = Object.assign(
			async () => {
				throw new Error("Availability tests must not probe provider or credential endpoints");
			},
			{
				preconnect: () => {
					throw new Error("Availability tests must not preconnect to provider endpoints");
				},
			},
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(blockedFetch);
	});
	afterEach(async () => {
		try {
			while (cleanups.length) await cleanups.pop()?.();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
			Object.assign(process.env, environment);
			setAgentDir(previousAgentDir);
		}
	});

	async function launch(
		options: { providers?: NonNullable<ModelsConfig["providers"]>; disabledProviders?: string[] } = {},
	) {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-availability-"));
		const projectDir = path.join(dataDir, "project");
		const agentDir = path.join(dataDir, "agent");
		await fs.mkdir(projectDir);
		await fs.mkdir(agentDir);
		await setModelPresetRegistryDisabled({ agentDir, disabled: true });
		const providers = options.providers ?? configuredProviders;
		for (const config of Object.values(providers)) {
			if (config.apiKeyEnv) delete process.env[config.apiKeyEnv];
		}
		await Bun.write(path.join(agentDir, "models.yml"), JSON.stringify({ providers }));
		if (options.disabledProviders)
			await Bun.write(
				path.join(agentDir, "config.yml"),
				JSON.stringify({ disabledProviders: options.disabledProviders }),
			);
		const frames: DesktopFrame[] = [];
		const sessions: AgentSession[] = [];
		const authSettled = Promise.withResolvers<DesktopAuthState>();
		const host = new DesktopHost({
			dataDir,
			emit(frame) {
				frames.push(frame);
				if (frame.type === "auth" && ["complete", "error", "cancelled"].includes(frame.auth.status))
					authSettled.resolve(frame.auth);
			},
			createSession: async options => {
				const { modelRegistry, sessionManager, settings } = options;
				if (!modelRegistry || !sessionManager || !settings)
					throw new Error("Missing host-owned session dependencies");
				expect(modelRegistry.getError()).toBeUndefined();
				const agent = new Agent({
					initialState: { model: undefined, tools: [], messages: [], systemPrompt: ["private fixture prompt"] },
					getApiKey: () => {
						throw new Error("Availability tests must not start provider turns");
					},
					streamFn: () => {
						throw new Error("Availability tests must not start provider turns");
					},
				});
				const session = new AgentSession({
					agent,
					sessionManager,
					settings,
					modelRegistry,
					agentDir: options.agentDir,
					disposeAsyncJobManager: false,
				});
				sessions.push(session);
				const eventBus = new EventBus();
				return {
					session,
					setToolUIContext: () => {},
					eventBus,
					extensionsResult: await loadExtensions([], String(options.cwd), eventBus),
				} satisfies CreateAgentSessionResult;
			},
		});
		cleanups.push(async () => {
			try {
				await host.close();
			} finally {
				await fs.rm(dataDir, { recursive: true, force: true });
			}
		});
		async function call<T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> {
			const id = crypto.randomUUID();
			await host.handle(parseRequest(JSON.stringify({ id, method, params })));
			const response = frames.find(frame => frame.type === "response" && frame.id === id);
			if (response?.type !== "response") throw new Error(`Missing response for ${method}`);
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		}
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const create = () => call<DesktopSession>("session.create", { projectId: project.id });
		const first = await create();
		const second = await create();
		const list = (sessionId: string) => call<DesktopModel[]>("models.list", { sessionId });
		return { host, call, sessions, first, second, frames, list, authSettled: authSettled.promise };
	}

	test("startup recovers from online refresh failure but rejects a failed offline refresh", async () => {
		vi.spyOn(ModelRegistry.prototype, "refresh").mockRejectedValueOnce(new Error("Online catalog unavailable"));
		const { list, first } = await launch();
		expect(await list(first.id)).toEqual([]);
		expect(ModelRegistry.prototype.refresh).toHaveBeenNthCalledWith(1, "online");
		expect(ModelRegistry.prototype.refresh).toHaveBeenNthCalledWith(2, "offline");
		vi.spyOn(ModelRegistry.prototype, "refresh")
			.mockRejectedValueOnce(new Error("Online catalog unavailable"))
			.mockRejectedValueOnce(new Error("Offline catalog unavailable"));
		await expect(launch()).rejects.toThrow("Offline catalog unavailable");
	});

	test("saved keys remain committed when one catalog fails; failed scopes refuse selection until explicit retry", async () => {
		const { call, first, second, sessions, list, frames } = await launch();
		const sdk = sessions[0]!;
		const key = "committed-api-key-secret";
		let attempts = 0;
		const scopes: Array<string | undefined> = [];
		// Bun can share an inherited method spy across instances. Bind failure to
		// the actual registry receiver, never spy call order across the refresh batch.
		vi.spyOn(sdk.modelRegistry, "refresh").mockImplementation(async function (
			this: ModelRegistry,
			_strategy,
			sessionId,
		) {
			if (this === sdk.modelRegistry) {
				scopes.push(sessionId);
				if (++attempts === 1) throw new Error(`Refresh failed: ${key}`);
			}
			await originalRefresh.call(this, "offline", sessionId);
		});
		const result = await call<DesktopCredentialSaveResult>("auth.setKey", { provider, key });
		expect(result).toEqual({ provider, saved: true, catalogRefreshed: false });
		expect(JSON.stringify(sdk.modelRegistry.authStorage.getAll()[provider])).toContain(key);
		await expect(list(first.id)).rejects.toThrow("모델 목록을 새로 고치지 못했습니다");
		expect(ids(await list(second.id))).toEqual(eligibleIds);
		const select = vi.spyOn(sdk, "setDefaultModelSelection");
		await expect(call("model.set", { sessionId: first.id, modelId: eligibleIds[0] })).rejects.toThrow(
			"모델 목록을 새로 고치지 못했습니다",
		);
		expect(select).not.toHaveBeenCalled();
		await expect(call("models.list", { sessionId: first.id, refresh: "offline" })).rejects.toThrow(
			"Invalid model catalog refresh",
		);
		expect(ids(await call<DesktopModel[]>("models.list", { sessionId: first.id, refresh: true }))).toEqual(
			eligibleIds,
		);
		expect(attempts).toBe(2);
		expect(scopes).toEqual([sdk.credentialSessionId, sdk.credentialSessionId]);
		expect(JSON.stringify(frames)).not.toContain(sdk.credentialSessionId);
		expect(JSON.stringify(frames)).not.toContain(key);
		expect(JSON.stringify(frames)).not.toContain("Refresh failed:");
		expect(
			frames.some(frame => frame.type === "snapshot" && ids(frame.snapshot.models).join() === eligibleIds.join()),
		).toBe(true);
		expect(sdk.model).toBeUndefined();
	});

	test("a delayed catalog refresh cannot publish models for a deleted session", async () => {
		const { call, first, sessions } = await launch();
		const sdk = sessions[0]!;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(sdk.modelRegistry, "refresh").mockImplementation(async function (
			this: ModelRegistry,
			_strategy,
			sessionId,
		) {
			if (this === sdk.modelRegistry) {
				entered.resolve();
				await release.promise;
				return;
			}
			await originalRefresh.call(this, "offline", sessionId);
		});
		const pending = call("models.list", { sessionId: first.id, refresh: true }).then(
			value => ({ status: "resolved", value }),
			(error: Error) => ({ status: "rejected", message: error.message }),
		);
		try {
			await entered.promise;
			await call("session.delete", { sessionId: first.id });
		} finally {
			release.resolve();
		}
		expect(await pending).toEqual({ status: "rejected", message: "Session changed while refreshing model catalog" });
	});

	test("unregistered or unauthenticated providers are absent; stored API-key registration updates already-open SDK sessions", async () => {
		const { host, call, first, second, sessions, list, frames } = await launch();
		expect(ids(host.snapshot().models)).toEqual([]);
		expect(await list(first.id)).toEqual([]);
		expect(await list(second.id)).toEqual([]);
		// Enrollment metadata must remain discoverable before authentication,
		// without advertising the provider's model catalog or credential values.
		const enrollment = await call<string[]>("auth.keyProviders");
		expect(enrollment).toContain(provider);
		expect(enrollment).toContain(otherProvider);
		expect(enrollment.every(id => typeof id === "string" && !id.includes("/"))).toBe(true);
		expect(enrollment).not.toContain(eligibleIds[0]!);
		expect(enrollment).not.toContain(eligibleIds[1]!);
		expect(JSON.stringify(enrollment)).not.toContain("api_key");
		expect(await list(first.id)).toEqual([]);
		const [sdkA, sdkB] = sessions;
		if (!sdkA || !sdkB) throw new Error("Expected two opened SDK sessions");
		expect(sdkA.modelRegistry).not.toBe(sdkB.modelRegistry);
		expect(sdkA.modelRegistry.authStorage).toBe(sdkB.modelRegistry.authStorage);
		// Stored auth alone never fabricates a catalog for an unregistered provider.
		await sdkA.modelRegistry.authStorage.set("desktop-orphan-credential", { type: "api_key", key: "orphan-secret" });
		expect(await list(first.id)).toEqual([]);
		expect(await list(second.id)).toEqual([]);
		expect(host.snapshot().models).toEqual([]);
		const refreshA = vi.spyOn(sdkA.modelRegistry, "refresh");
		const refreshB = vi.spyOn(sdkB.modelRegistry, "refresh");
		await expect(call("auth.setKey", { provider: "not-registered", key: "never-stored" })).rejects.toThrow(
			"Unknown provider",
		);
		expect(sdkA.modelRegistry.authStorage.has("not-registered")).toBe(false);
		await call("auth.setKey", { provider, key: "eligible-api-key-secret" });
		const authenticatedEnrollment = await call<string[]>("auth.keyProviders");
		expect(authenticatedEnrollment).toEqual(enrollment);
		expect(JSON.stringify(authenticatedEnrollment)).not.toContain("eligible-api-key-secret");
		expect(refreshA).toHaveBeenCalledWith("offline", sdkA.credentialSessionId);
		expect(refreshB).toHaveBeenCalledWith("offline", sdkB.credentialSessionId);
		expect(ids(host.snapshot().models)).toEqual(eligibleIds);
		expect(ids(await list(first.id))).toEqual(eligibleIds);
		expect(ids(await list(second.id))).toEqual(eligibleIds);
		expect(
			sdkA.modelRegistry
				.getAvailable(sdkA.credentialSessionId)
				.map(model => `${model.provider}/${model.id}`)
				.sort(),
		).toEqual(eligibleIds);
		expect(
			frames.some(frame => frame.type === "snapshot" && ids(frame.snapshot.models).join() === eligibleIds.join()),
		).toBe(true);
		expect(JSON.stringify(frames)).not.toContain("eligible-api-key-secret");
		await call("model.set", { sessionId: first.id, modelId: eligibleIds[0] });
		expect(sdkA.model?.id).toBe("first");
		expect(sdkB.model).toBeUndefined();
	});

	test("a runtime-registered provider exposes only its declared subset in its owning SDK registry", async () => {
		const { host, call, first, second, sessions, list } = await launch();
		const sdk = sessions[0]!;
		await sdk.modelRegistry.authStorage.set("desktop-runtime", { type: "api_key", key: "runtime-secret" });
		expect(await list(first.id)).toEqual([]);
		sdk.modelRegistry.registerProvider("desktop-runtime", {
			baseUrl: "https://runtime.example.invalid",
			api: "anthropic-messages",
			apiKey: "runtime-secret",
			models: [model("registered-only")],
		});
		expect(sdk.modelRegistry.getError()).toBeUndefined();
		expect(ids(await list(first.id))).toEqual(["desktop-runtime/registered-only"]);
		expect(await list(second.id)).toEqual([]);
		expect(host.snapshot().models).toEqual([]);
		await call("model.set", { sessionId: first.id, modelId: "desktop-runtime/registered-only" });
		expect(sdk.model?.id).toBe("registered-only");
		await expect(
			call("model.set", { sessionId: second.id, modelId: "desktop-runtime/registered-only" }),
		).rejects.toThrow("등록된 제공자에서 사용할 수 없는 모델");
	});

	test("session credential pins fail closed without leaking another scope's eligible models", async () => {
		const { host, call, first, second, sessions, list } = await launch();
		const [sdkA, sdkB] = sessions;
		if (!sdkA || !sdkB) throw new Error("Expected two opened SDK sessions");
		const auth = sdkA.modelRegistry.authStorage;
		await auth.set(provider, [
			{
				type: "oauth",
				access: "account-a-access",
				refresh: "account-a-refresh",
				expires: Date.now() + 3_600_000,
				email: "a@example.invalid",
			},
			{
				type: "oauth",
				access: "account-b-access",
				refresh: "account-b-refresh",
				expires: Date.now() + 3_600_000,
				email: "b@example.invalid",
			},
		]);
		await sdkA.setCredentialPin(provider, { kind: "email", value: "a@example.invalid" });
		await sdkB.setCredentialPin(provider, { kind: "email", value: "b@example.invalid" });
		expect(ids(await list(first.id))).toEqual(eligibleIds);
		expect(ids(await list(second.id))).toEqual(eligibleIds);
		auth.markSessionCredentialUnavailable(sdkA.credentialSessionId, provider, {
			kind: "email",
			value: "a@example.invalid",
		});
		expect(await list(first.id)).toEqual([]);
		expect(ids(await list(second.id))).toEqual(eligibleIds);
		expect(ids(host.snapshot().models)).toEqual(eligibleIds);
		const selection = vi.spyOn(sdkA, "setDefaultModelSelection");
		await expect(call("model.set", { sessionId: first.id, modelId: eligibleIds[0] })).rejects.toThrow(
			"등록된 제공자에서 사용할 수 없는 모델",
		);
		expect(selection).not.toHaveBeenCalled();
		expect(sdkA.model).toBeUndefined();
		expect(sdkA.getSessionDefaultModelSelector()).toBeUndefined();
		const beforeRepin = [sdkA, sdkB].map(sdk => ({
			model: sdk.model,
			level: sdk.thinkingLevel,
			selector: sdk.getSessionDefaultModelSelector(),
			roles: structuredClone(sdk.settings.getGlobal("modelRoles")),
		}));
		// A fresh public scope operation must also invalidate negative eligibility:
		// repinning A to account B restores A without mutating either session's model.
		await sdkA.setCredentialPin(provider, { kind: "email", value: "b@example.invalid" });
		expect(ids(await list(first.id))).toEqual(eligibleIds);
		expect(ids(await list(second.id))).toEqual(eligibleIds);
		expect(auth.hasSessionCredentialUnavailable(provider, sdkA.credentialSessionId)).toBe(false);
		for (const [index, sdk] of [sdkA, sdkB].entries()) {
			const before = beforeRepin[index]!;
			expect(sdk.model).toBe(before.model);
			expect(sdk.thinkingLevel).toBe(before.level);
			expect(sdk.getSessionDefaultModelSelector()).toBe(before.selector);
			expect(sdk.settings.getGlobal("modelRoles")).toEqual(before.roles);
		}
		expect(selection).not.toHaveBeenCalled();
	});

	test("disabled providers stay hidden and cannot mutate model, effort, or role defaults", async () => {
		const { host, call, first, second, sessions, list } = await launch({ disabledProviders: [provider] });
		await call("auth.setKey", { provider, key: "disabled-provider-secret" });
		expect(host.snapshot().models).toEqual([]);
		expect(await list(first.id)).toEqual([]);
		expect(await list(second.id)).toEqual([]);
		const sdk = sessions[0]!;
		const selection = vi.spyOn(sdk, "setDefaultModelSelection");
		const roles = structuredClone(sdk.settings.getGlobal("modelRoles"));
		const level = sdk.thinkingLevel;
		await expect(call("model.set", { sessionId: first.id, modelId: eligibleIds[0] })).rejects.toThrow(
			"등록된 제공자에서 사용할 수 없는 모델",
		);
		expect(selection).not.toHaveBeenCalled();
		expect(sdk.model).toBeUndefined();
		expect(sdk.thinkingLevel).toBe(level);
		expect(sdk.getSessionDefaultModelSelector()).toBeUndefined();
		expect(sdk.settings.getGlobal("modelRoles")).toEqual(roles);
	});

	test("forged known-provider and unregistered model IDs are refused before the selection transaction", async () => {
		const { call, first, sessions } = await launch();
		await call("auth.setKey", { provider, key: "forged-test-secret" });
		await call("model.set", { sessionId: first.id, modelId: eligibleIds[0] });
		const sdk = sessions[0]!;
		const before = {
			model: sdk.model,
			level: sdk.thinkingLevel,
			selector: sdk.getSessionDefaultModelSelector(),
			roles: structuredClone(sdk.settings.getGlobal("modelRoles")),
		};
		const selection = vi.spyOn(sdk, "setDefaultModelSelection");
		for (const modelId of ["anthropic/not-a-registered-model", `${provider}/forged`, `${otherProvider}/hidden`])
			await expect(call("model.set", { sessionId: first.id, modelId, thinkingLevel: "high" })).rejects.toThrow(
				"등록된 제공자에서 사용할 수 없는 모델",
			);
		expect(selection).not.toHaveBeenCalled();
		expect(sdk.model).toBe(before.model);
		expect(sdk.thinkingLevel).toBe(before.level);
		expect(sdk.getSessionDefaultModelSelector()).toBe(before.selector);
		expect(sdk.settings.getGlobal("modelRoles")).toEqual(before.roles);
	});

	test("configured keyless local models remain canonically eligible without fabricated credentials", async () => {
		const localProvider = "desktop-local";
		const { host, call, first, sessions, list } = await launch({
			providers: {
				...configuredProviders,
				[localProvider]: {
					baseUrl: "http://127.0.0.1:19876/v1",
					api: "openai-completions",
					auth: "none",
					models: [model("local-only")],
				},
			},
		});
		expect(ids(host.snapshot().models)).toEqual([`${localProvider}/local-only`]);
		expect(ids(await list(first.id))).toEqual([`${localProvider}/local-only`]);
		expect(sessions[0]!.modelRegistry.authStorage.has(localProvider)).toBe(false);
		await call("model.set", { sessionId: first.id, modelId: `${localProvider}/local-only` });
		expect(sessions[0]!.model?.provider).toBe(localProvider);
	});

	test.each([
		false,
		true,
	])("OAuth persistence and catalog refresh report separate outcomes (refresh fails: %s)", async refreshFails => {
		const oauthProvider = "desktop-oauth-availability";
		const sourceId = crypto.randomUUID();
		const login = vi.fn(async () => ({
			access: "oauth-secret-access",
			refresh: "oauth-secret-refresh",
			expires: Date.now() + 3_600_000,
		}));
		registerOAuthProvider({
			id: oauthProvider,
			name: "Fixture authorization",
			sourceId,
			login,
			getApiKey: credentials => credentials.access,
		});
		// Registered before launch so the controller's actual provider inventory admits it.
		cleanups.push(async () => {
			unregisterOAuthProviders(sourceId);
		});
		const { host, call, first, second, sessions, list, frames, authSettled } = await launch({
			providers: {
				...configuredProviders,
				[oauthProvider]: {
					baseUrl: "https://oauth.example.invalid",
					api: "anthropic-messages",
					auth: "oauth",
					apiKeyEnv: "GJC_DESKTOP_OAUTH_FIXTURE_KEY",
					models: [model("authorized-only")],
				},
			},
		});
		expect(await list(first.id)).toEqual([]);
		expect(await list(second.id)).toEqual([]);
		const refreshA = vi.spyOn(sessions[0]!.modelRegistry, "refresh");
		const refreshB = vi.spyOn(sessions[1]!.modelRegistry, "refresh");
		let rejected = false;
		if (refreshFails)
			refreshA.mockImplementation(async function (this: ModelRegistry, _strategy, sessionId) {
				if (this === sessions[0]!.modelRegistry && !rejected) {
					rejected = true;
					throw new Error("oauth-secret-access refresh failure");
				}
				await originalRefresh.call(this, "offline", sessionId);
			});
		await call("auth.login", { provider: oauthProvider });
		const settled = await authSettled;
		expect(settled.status).toBe(refreshFails ? "error" : "complete");
		if (refreshFails) {
			expect(settled.error).toContain("Credentials were saved");
			expect(sessions[0]!.modelRegistry.authStorage.hasAuth(oauthProvider)).toBe(true);
			await expect(list(first.id)).rejects.toThrow("모델 목록을 새로 고치지 못했습니다");
			await call("models.list", { sessionId: first.id, refresh: true });
		}
		expect(login).toHaveBeenCalledTimes(1);
		expect(refreshA).toHaveBeenCalledWith("offline", sessions[0]!.credentialSessionId);
		expect(refreshB).toHaveBeenCalledWith("offline", sessions[1]!.credentialSessionId);
		expect(ids(host.snapshot().models)).toEqual([`${oauthProvider}/authorized-only`]);
		expect(ids(await list(first.id))).toEqual([`${oauthProvider}/authorized-only`]);
		expect(ids(await list(second.id))).toEqual([`${oauthProvider}/authorized-only`]);
		expect(JSON.stringify(frames)).not.toContain("oauth-secret-access");
		expect(JSON.stringify(frames)).not.toContain("oauth-secret-refresh");
	});
});
