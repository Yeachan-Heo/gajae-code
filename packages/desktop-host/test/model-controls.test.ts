import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai/core";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions";
import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { EventBus } from "@gajae-code/coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import { projectDesktopThinking } from "../src/model-controls";
import type { DesktopFrame, DesktopProject, DesktopRequest, DesktopSession } from "../src/protocol";
import { parseRequest } from "../src/protocol";

const reasoning: Model = {
	id: "discrete",
	name: "Discrete reasoning",
	provider: "desktop-fixture",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: {
		mode: "budget",
		minLevel: Effort.Low,
		maxLevel: Effort.Max,
		levels: [Effort.Low, Effort.High, Effort.Max],
	},
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4096,
};
const plain: Model = { ...reasoning, id: "plain", name: "Plain", reasoning: false, thinking: undefined };
const toggle: Model = {
	...reasoning,
	id: "MiniMax-M3",
	provider: "minimax",
	baseUrl: "https://api.minimax.io/anthropic",
	thinking: { mode: "effort", minLevel: Effort.High, maxLevel: Effort.High },
};
const alwaysOn: Model = { ...toggle, id: "MiniMax-M2.7", thinking: undefined };
const missingKey: Model = { ...reasoning, provider: "desktop-missing-key", id: "unavailable" };
const selector = (model: Model) => `${model.provider}/${model.id}`;

/** Real public AgentSession controls and persistence; no stream ever contacts a provider. */
describe("desktop model and session reasoning controls", () => {
	let environment: NodeJS.ProcessEnv;
	let previousAgentDir: string;
	const cleanups: Array<() => Promise<void>> = [];
	beforeEach(() => {
		environment = { ...process.env };
		previousAgentDir = getAgentDir();
		process.env.GJC_DESKTOP_ISOLATED = "1";
		// Keep genuine configured catalog/auth availability; only force the host's
		// initial online refresh onto the canonical offline path (no provider probes).
		const refresh = ModelRegistry.prototype.refresh;
		vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(function (
			this: ModelRegistry,
			_strategy,
			sessionId,
		) {
			return refresh.call(this, "offline", sessionId);
		});
		const blockedFetch: typeof fetch = Object.assign(
			async () => {
				throw new Error("Model control tests must not probe provider or credential endpoints");
			},
			{
				preconnect: () => {
					throw new Error("Model control tests must not preconnect to provider endpoints");
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

	async function launch(initialModel: Model | undefined = reasoning) {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-models-"));
		const projectDir = path.join(dataDir, "project");
		await fs.mkdir(projectDir);
		await fs.mkdir(path.join(dataDir, "agent"));
		await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
		const providers: Record<
			string,
			{ baseUrl: string; api: Model["api"]; apiKeyEnv: string; models: Omit<Model, "provider">[] }
		> = {};
		for (const { provider, ...model } of [reasoning, plain, toggle, alwaysOn, missingKey]) {
			const apiKeyEnv = `GJC_DESKTOP_MODEL_FIXTURE_${provider.replaceAll("-", "_").toUpperCase()}_KEY`;
			delete process.env[apiKeyEnv];
			providers[provider] ??= { baseUrl: model.baseUrl, api: model.api, apiKeyEnv, models: [] };
			providers[provider]!.models.push(model);
		}
		await Bun.write(path.join(dataDir, "agent", "models.yml"), JSON.stringify({ providers }));
		const frames: DesktopFrame[] = [];
		const sessions: AgentSession[] = [];
		let nextModel: Model | undefined = initialModel;
		const host = new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: async options => {
				const { authStorage, modelRegistry, sessionManager, settings } = options;
				if (!authStorage || !modelRegistry || !sessionManager || !settings)
					throw new Error("Missing host-owned dependencies");
				expect(modelRegistry.getError()).toBeUndefined();
				authStorage.setRuntimeApiKey(reasoning.provider, "fixture-key-never-send");
				authStorage.setRuntimeApiKey(toggle.provider, "fixture-native-key-never-send");
				const agent = new Agent({
					getApiKey: () => {
						throw new Error("No provider turns in model controls tests");
					},
					initialState: { model: nextModel, tools: [], messages: [], systemPrompt: ["private fixture prompt"] },
					streamFn: () => {
						throw new Error("No provider turns in model controls tests");
					},
				});
				const session = new AgentSession({
					agent,
					sessionManager,
					settings,
					modelRegistry,
					agentDir: options.agentDir,
					thinkingLevel: nextModel?.thinking?.minLevel,
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
			if (!response || response.type !== "response") throw new Error(`Missing response for ${method}`);
			if (!response.ok) throw new Error(response.error);
			return response.result as T;
		}
		const project = await call<DesktopProject>("project.open", { path: projectDir });
		const create = () => call<DesktopSession>("session.create", { projectId: project.id });
		const dto = (id: string) => host.snapshot().sessions.find(session => session.id === id)!;
		const session = await create();
		return {
			host,
			frames,
			sessions,
			session,
			create,
			call,
			dto,
			setNextModel: (model: Model | undefined) => {
				nextModel = model;
			},
		};
	}

	test("projects canonical discrete efforts and model metadata without prompts or credentials", async () => {
		const { host, session, frames } = await launch();
		const snapshot = host.snapshot();
		expect(snapshot.models.find(model => model.id === selector(reasoning))).toMatchObject({
			contextWindow: 32_768,
			reasoning: true,
			thinking: {
				mode: "budget",
				options: [{ value: "off" }, { value: "low" }, { value: "high" }, { value: "max" }],
			},
		});
		expect(session.thinking).toMatchObject({ level: "low", scope: "global config", mode: "budget", available: true });
		expect(session.thinking?.options.map(option => option.value)).toEqual(["inherit", "off", "low", "high", "max"]);
		expect(snapshot.models.find(model => model.id === selector(plain))).toMatchObject({
			reasoning: false,
			thinking: { options: [] },
		});
		const serialized = JSON.stringify(frames);
		expect(serialized).not.toContain("fixture-key-never-send");
		expect(serialized).not.toContain("private fixture prompt");
	});

	test("publishes the selected live level in session scope without changing another session or defaults", async () => {
		const { call, create, sessions, session, dto, frames } = await launch();
		const other = await create();
		const sdk = sessions[0]!;
		const originalDefault = sdk.settings.getGlobal("defaultThinkingLevel");
		const control = vi.spyOn(sdk, "setThinkingLevelForControl");
		await call("thinking.set", { sessionId: session.id, level: "max" });
		expect(control).toHaveBeenCalledWith(ThinkingLevel.Max, false);
		expect(sdk.thinkingLevel).toBe(ThinkingLevel.Max);
		expect(dto(session.id).thinking).toMatchObject({ level: "max", scope: "session" });
		expect(dto(other.id).thinking?.level).toBe("low");
		expect(sdk.settings.getGlobal("defaultThinkingLevel")).toBe(originalDefault);
		expect(
			frames.some(
				frame =>
					frame.type === "session" && frame.session.id === session.id && frame.session.thinking?.level === "max",
			),
		).toBe(true);
		await call("thinking.set", { sessionId: session.id, level: "inherit" });
		expect(dto(session.id).thinking).toMatchObject({ level: sdk.thinkingLevel ?? null, scope: "global config" });
	});

	test("rejects malformed, unknown and discrete-gap efforts before invoking either mutation", async () => {
		const { call, session, sessions, dto } = await launch();
		const thinking = vi.spyOn(sessions[0]!, "setThinkingLevelForControl");
		const model = vi.spyOn(sessions[0]!, "setDefaultModelSelection");
		for (const level of [null, true, {}, [], "", " high", "HIGH", "ultra", "medium", "xhigh"]) {
			await expect(call("thinking.set", { sessionId: session.id, level })).rejects.toThrow(/thinking level/i);
			await expect(
				call("model.set", { sessionId: session.id, modelId: selector(reasoning), thinkingLevel: level }),
			).rejects.toThrow(/thinking level/i);
		}
		await expect(call("thinking.set", { sessionId: session.id })).rejects.toThrow("Invalid thinking level");
		await expect(
			call("model.set", { sessionId: session.id, modelId: selector(reasoning), thinkingLevel: "inherit" }),
		).rejects.toThrow("Unsupported thinking level");
		expect(thinking).not.toHaveBeenCalled();
		expect(model).not.toHaveBeenCalled();
		expect(dto(session.id)).toMatchObject({ model: selector(reasoning), thinking: { level: "low" } });
	});

	test("rejects reasoning writes for nonreasoning and no-model sessions truthfully", async () => {
		const { call, session, sessions, create, setNextModel, dto } = await launch(plain);
		expect(dto(session.id).thinking).toMatchObject({ available: false, level: null, options: [] });
		await expect(call("thinking.set", { sessionId: session.id, level: "high" })).rejects.toThrow("does not support");
		setNextModel(undefined);
		const empty = await create();
		expect(dto(empty.id).thinking).toMatchObject({
			available: false,
			level: null,
			scope: null,
			options: [],
			reason: "No model is selected.",
		});
		await expect(call("thinking.set", { sessionId: empty.id, level: "off" })).rejects.toThrow("No model is selected");
		expect(sessions[1]?.model).toBeUndefined();
		expect(projectDesktopThinking()).toMatchObject({
			available: false,
			level: null,
			scope: null,
			options: [],
			reason: "Open the session to read reasoning controls.",
		});
	});

	test("native toggle controls use on/off labels and always-on models cannot be disabled", async () => {
		const { host, call, session, create, setNextModel, dto } = await launch(toggle);
		expect(host.snapshot().models.find(model => model.id === selector(alwaysOn))).toMatchObject({
			reasoning: true,
			thinking: { mode: "always-on", options: [] },
		});
		expect(session.thinking).toMatchObject({ mode: "toggle", available: true });
		expect(session.thinking?.options.map(option => [option.value, option.label])).toEqual([
			["inherit", "inherit"],
			["off", "off"],
			["high", "on"],
		]);
		await call("thinking.set", { sessionId: session.id, level: "off" });
		expect(dto(session.id).thinking?.level).toBe("off");
		setNextModel(alwaysOn);
		const fixed = await create();
		expect(fixed.thinking).toMatchObject({ available: false, mode: "always-on", options: [] });
		await expect(call("thinking.set", { sessionId: fixed.id, level: "off" })).rejects.toThrow("always on");
		await expect(
			call("model.set", { sessionId: session.id, modelId: selector(alwaysOn), thinkingLevel: "off" }),
		).rejects.toThrow("Unsupported thinking level");
	});

	test("model changes use SDK durable selection and publish the selected effort", async () => {
		const { call, session, sessions, dto } = await launch(plain);
		const sdk = sessions[0]!;
		await call("model.set", { sessionId: session.id, modelId: selector(reasoning), thinkingLevel: "high" });
		expect(dto(session.id)).toMatchObject({ model: selector(reasoning), thinking: { level: "high" } });
		expect(sdk.getSessionDefaultModelSelector()).toBe(selector(reasoning));
		expect(sdk.settings.getGlobal("modelRoles")?.default).toBe(`${selector(reasoning)}:high`);
		await call("model.set", { sessionId: session.id, modelId: selector(plain), thinkingLevel: "off" });
		expect(dto(session.id)).toMatchObject({ model: selector(plain), thinking: { level: "off", available: false } });
	});

	test("rejects controls while a host operation owns the session", async () => {
		const { call, session, sessions, dto } = await launch();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(sessions[0]!, "compact").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return {} as never;
		});
		const compact = call("session.compact", { sessionId: session.id });
		await entered.promise;
		try {
			await expect(call("thinking.set", { sessionId: session.id, level: "high" })).rejects.toThrow(
				"Another operation is running",
			);
			await expect(call("model.set", { sessionId: session.id, modelId: selector(plain) })).rejects.toThrow(
				"Another operation is running",
			);
			expect(dto(session.id)).toMatchObject({ model: selector(reasoning), thinking: { level: "low" } });
		} finally {
			release.resolve();
			await compact;
		}
		// An SDK-owned active run is independently protected even without a host task.
		const sdk = sessions[0]!;
		const previousStreaming = sdk.agent.state.isStreaming;
		sdk.agent.state.isStreaming = true;
		try {
			expect(sdk.isStreaming).toBe(true);
			expect(dto(session.id).status).toBe("running");
			await expect(call("thinking.set", { sessionId: session.id, level: "high" })).rejects.toThrow(
				"Another operation is running",
			);
			await expect(call("model.set", { sessionId: session.id, modelId: selector(plain) })).rejects.toThrow(
				"Another operation is running",
			);
			expect(dto(session.id)).toMatchObject({ model: selector(reasoning), thinking: { level: "low" } });
		} finally {
			sdk.agent.state.isStreaming = previousStreaming;
		}
	});

	test("credential and durable-write failures preserve the selected model and reasoning level", async () => {
		const { call, session, sessions, dto } = await launch();
		const sdk = sessions[0]!;
		await call("thinking.set", { sessionId: session.id, level: "max" });
		await expect(
			call("model.set", { sessionId: session.id, modelId: selector(missingKey), thinkingLevel: "high" }),
		).rejects.toThrow("This model is not available from a registered provider");
		expect(dto(session.id)).toMatchObject({
			model: selector(reasoning),
			thinking: { level: "max", scope: "session" },
		});
		// Availability is genuine; credentials can still fail at the async SDK
		// preflight after admission. That failure must preserve the live selection.
		const credentialFailure = vi
			.spyOn(sdk.modelRegistry, "getApiKey")
			.mockRejectedValueOnce(new Error("No API key at selection preflight"));
		await expect(
			call("model.set", { sessionId: session.id, modelId: selector(reasoning), thinkingLevel: "high" }),
		).rejects.toThrow("No API key at selection preflight");
		credentialFailure.mockRestore();
		expect(dto(session.id)).toMatchObject({
			model: selector(reasoning),
			thinking: { level: "max", scope: "session" },
		});
		vi.spyOn(sdk.settings, "commitAtomicBatchWithCurrent").mockRejectedValue(
			new Error("fixture durable write refused"),
		);
		await expect(call("model.set", { sessionId: session.id, modelId: selector(plain) })).rejects.toThrow(
			"fixture durable write refused",
		);
		expect(dto(session.id)).toMatchObject({
			model: selector(reasoning),
			thinking: { level: "max", scope: "session" },
		});
		const control = vi
			.spyOn(sdk, "setThinkingLevelForControl")
			.mockRejectedValue(new Error("fixture reasoning write refused"));
		await expect(call("thinking.set", { sessionId: session.id, level: "low" })).rejects.toThrow(
			"fixture reasoning write refused",
		);
		expect(control).toHaveBeenCalledWith(ThinkingLevel.Low, false);
		expect(dto(session.id).thinking?.level).toBe("max");
	});

	test("failed session promotion rolls back durable model selection without changing live reasoning", async () => {
		const { call, session, sessions, dto } = await launch();
		const sdk = sessions[0]!;
		const previousRoles = structuredClone(sdk.settings.getGlobal("modelRoles"));
		await call("thinking.set", { sessionId: session.id, level: "max" });
		vi.spyOn(sdk.sessionManager, "promoteDefaultModelSelection").mockReturnValue({
			kind: "not_promoted",
			error: new Error("fixture promotion refused"),
		});
		await expect(call("model.set", { sessionId: session.id, modelId: selector(plain) })).rejects.toThrow(
			"Default model selection could not be completed after durable selection.",
		);
		expect(dto(session.id)).toMatchObject({
			model: selector(reasoning),
			thinking: { level: "max", scope: "session" },
		});
		expect(sdk.settings.getGlobal("modelRoles")).toEqual(previousRoles);
	});

	test("session ownership rejects unknown IDs without selecting a model", async () => {
		const { call, session, dto } = await launch();
		for (const method of ["thinking.set", "model.set"] as const)
			await expect(
				call(method, { sessionId: crypto.randomUUID(), level: "high", modelId: selector(plain) }),
			).rejects.toThrow("Session not found");
		expect(dto(session.id)).toMatchObject({ model: selector(reasoning), thinking: { level: "low" } });
	});
});
