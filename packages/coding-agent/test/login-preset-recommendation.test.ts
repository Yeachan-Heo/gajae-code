import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";

const model = (provider: string, id: string): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
		thinking: { minLevel: ThinkingLevel.Low, maxLevel: ThinkingLevel.XHigh },
	}) as Model;

const codexModel = model("openai-codex", "gpt-5.5");
const minimaxModel = model("minimax-code", "minimax-v3");

const profile = (name: string, provider: string, selector: string): ModelProfileDefinition => ({
	name,
	requiredProviders: [provider],
	modelMapping: { default: selector },
	source: "builtin",
});

const codexProfile = profile("codex-medium", "openai-codex", "openai-codex/gpt-5.5:medium");
const minimaxProfile = profile("minimax-medium", "minimax-code", "minimax-code/minimax-v3:medium");
const plainMinimaxProfile = profile("minimax", "minimax-code", "minimax-code/minimax-v3:medium");
let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

function createControllerContext(
	options: {
		confirm?: boolean;
		activeProfile?: string;
		defaultProfile?: string;
		profiles?: ModelProfileDefinition[];
	} = {},
) {
	const settings = Settings.isolated({
		"task.agentModelOverrides": { executor: "openai-codex/original-executor" },
		"modelProfile.default": options.defaultProfile,
	});
	const setCalls: Array<{ path: string; value: unknown }> = [];
	const originalSet = settings.set.bind(settings);
	settings.set = ((path: never, value: never) => {
		setCalls.push({ path: path as string, value });
		return originalSet(path, value);
	}) as typeof settings.set;
	settings.flush = vi.fn(async () => {}) as typeof settings.flush;

	const profiles = new Map((options.profiles ?? [codexProfile, minimaxProfile]).map(entry => [entry.name, entry]));
	let activeProfile = options.activeProfile;
	let configuredDefaultChain: readonly string[] | undefined;
	const session = {
		model: undefined as Model | undefined,
		thinkingLevel: undefined as ThinkingLevel | undefined,
		sessionId: "session-1",
		scopedModels: [],
		setModelTemporaryCalls: [] as Array<{ model: Model; thinkingLevel?: ThinkingLevel }>,
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			this.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			this.model = next;
			this.thinkingLevel = thinkingLevel;
		},
		getConfiguredModelChain: () => configuredDefaultChain,
		setConfiguredModelChain(_role: string, chain: readonly string[]) {
			configuredDefaultChain = chain;
		},
		setActiveModelProfile: vi.fn((name: string | undefined) => {
			activeProfile = name;
		}),
		getActiveModelProfile: vi.fn(() => activeProfile),
		modelRegistry: {
			refresh: vi.fn(async () => {}),
			authStorage: {
				login: vi.fn(async () => {}),
			},
			getModelProfiles: () => new Map(profiles),
			getModelProfile: (name: string) => profiles.get(name),
			getAvailableModelProfileNames: () => [...profiles.keys()],
			getApiKeyForProvider: vi.fn(async () => "key"),
			getAll: () => [codexModel, minimaxModel],
			resolveCanonicalModel: () => undefined,
			getCanonicalVariants: () => [],
			getCanonicalId: () => undefined,
		},
	};
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		settings,
		session,
		chatContainer: { addChild: vi.fn() },
		oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
		openInBrowser: vi.fn(),
		showHookConfirm: vi.fn(async () => options.confirm ?? false),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
	return { ctx, settings, session, setCalls };
}

async function login(ctx: ReturnType<typeof createControllerContext>["ctx"], providerId: string): Promise<void> {
	installTestTheme();
	const controller = new SelectorController(ctx as never);
	await controller.showOAuthSelector("login", providerId);
}

describe("login preset recommendation", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		installTestTheme();
	});

	test("login on openai-codex with no active profile prompts and confirm activates session-only profile", async () => {
		const { ctx, settings, session, setCalls } = createControllerContext({ confirm: true });

		await login(ctx, "openai-codex");

		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.showHookConfirm).toHaveBeenCalledWith("Apply codex-medium now?", "");
		expect(session.setModelTemporaryCalls).toEqual([{ model: codexModel, thinkingLevel: ThinkingLevel.Medium }]);
		expect(session.setActiveModelProfile).toHaveBeenCalledWith("codex-medium");
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(setCalls).not.toContainEqual({ path: "modelProfile.default", value: "codex-medium" });
	});

	test("declining the post-login recommendation performs no mutation", async () => {
		const { ctx, session, settings } = createControllerContext({ confirm: false });

		await login(ctx, "openai-codex");

		expect(ctx.showHookConfirm).toHaveBeenCalledWith("Apply codex-medium now?", "");
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(session.setActiveModelProfile).not.toHaveBeenCalled();
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "openai-codex/original-executor" });
	});

	test("login with session active profile shows hint instead of prompting", async () => {
		const { ctx, session } = createControllerContext({ activeProfile: "codex-eco" });

		await login(ctx, "openai-codex");

		expect(ctx.showHookConfirm).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Preset codex-medium is available in /model.");
		expect(session.setModelTemporaryCalls).toEqual([]);
	});

	test("login with default profile setting shows hint instead of prompting", async () => {
		const { ctx, session } = createControllerContext({ defaultProfile: "codex-eco" });

		await login(ctx, "openai-codex");

		expect(ctx.showHookConfirm).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Preset codex-medium is available in /model.");
		expect(session.setModelTemporaryCalls).toEqual([]);
	});

	test("minimax-code login recommends minimax-medium", async () => {
		const { ctx, session } = createControllerContext({ confirm: true });

		await login(ctx, "minimax-code");

		expect(ctx.showHookConfirm).toHaveBeenCalledWith("Apply minimax-medium now?", "");
		expect(session.setModelTemporaryCalls).toEqual([{ model: minimaxModel, thinkingLevel: ThinkingLevel.Medium }]);
		expect(session.setActiveModelProfile).toHaveBeenCalledWith("minimax-medium");
	});

	test("provider with no recommendation mapping does nothing", async () => {
		const { ctx, session } = createControllerContext();

		await login(ctx, "ollama");

		expect(ctx.showHookConfirm).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Logging in to ollama…");
		expect(session.setModelTemporaryCalls).toEqual([]);
	});

	test("plain minimax has no recommendation mapping", async () => {
		const { ctx, session } = createControllerContext({
			activeProfile: "codex-eco",
			profiles: [codexProfile, minimaxProfile, plainMinimaxProfile],
		});

		await login(ctx, "minimax");

		expect(ctx.showHookConfirm).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Logging in to minimax…");
		expect(ctx.showStatus).not.toHaveBeenCalledWith("Preset minimax-medium is available in /model.");
		expect(session.setModelTemporaryCalls).toEqual([]);
	});
});
