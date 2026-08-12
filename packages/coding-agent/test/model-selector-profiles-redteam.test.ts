import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { GJC_MODEL_ASSIGNMENT_TARGET_IDS, kNoAuth } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
} from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

const defaultModel = model("provider-a", "default");
const alternateModel = model("provider-a", "alternate");
const flatModel = model("provider-b", "zzz-flat-model");

const userProfile: ModelProfileDefinition = {
	name: "profile-a",
	displayName: "Profile Alpha",
	requiredProviders: ["provider-a"],
	modelMapping: { default: "provider-a/default:high", executor: "provider-a/alternate" },
	source: "user",
};

function createRegistry(
	options: {
		profiles?: ModelProfileDefinition[];
		missingCredentials?: boolean;
		apiKey?: string;
		apiKeyPromise?: Promise<string | undefined>;
	} = {},
) {
	const profiles = new Map((options.profiles ?? [userProfile]).map(profile => [profile.name, profile]));
	return {
		refresh: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [defaultModel, alternateModel, flatModel],
		getAll: () => [defaultModel, alternateModel, flatModel],
		hasConfiguredProviderAuth: () => false,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		getApiKeyForProvider: async () =>
			options.apiKeyPromise ?? options.apiKey ?? (options.missingCredentials ? undefined : "key"),
		getApiKey: async () => "key",
	};
}

function createSelector(
	onSelect: (selection: ModelSelectorSelection) => void | Promise<void>,
	options: {
		profiles?: ModelProfileDefinition[];
		temporaryOnly?: boolean;
		missingCredentials?: boolean;
		apiKey?: string;
		apiKeyPromise?: Promise<string | undefined>;
		settings?: Settings;
		initialSearchInput?: string;
	} = {},
) {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		undefined,
		options.settings ?? Settings.isolated(),
		createRegistry({
			profiles: options.profiles,
			missingCredentials: options.missingCredentials,
			apiKey: options.apiKey,
			apiKeyPromise: options.apiKeyPromise,
		}) as never,
		[],
		onSelect,
		() => {},
		{ temporaryOnly: options.temporaryOnly, initialSearchInput: options.initialSearchInput },
	);
}

async function renderSelector(selector: ModelSelectorComponent): Promise<string> {
	await Bun.sleep(10);
	installTestTheme();
	return normalizeRenderedText(selector.render(240).join("\n"));
}

function createControllerContext(options: { missingCredentials?: boolean; profiles?: ModelProfileDefinition[] } = {}) {
	const settings = Settings.isolated({
		"task.agentModelOverrides": { executor: "provider-a/original-executor" },
		"modelProfile.default": "old-profile",
	});
	const flushOrThrow = vi.fn(async () => {});
	settings.flushOrThrow = flushOrThrow as typeof settings.flushOrThrow;
	const setCalls: Array<{ path: string; value: unknown }> = [];
	const originalSet = settings.set.bind(settings);
	settings.set = ((path: never, value: never) => {
		setCalls.push({ path: path as string, value });
		return originalSet(path, value);
	}) as typeof settings.set;
	const overrideCalls: Array<{ path: string; value: unknown }> = [];
	const originalOverride = settings.override.bind(settings);
	settings.override = ((path: never, value: never) => {
		overrideCalls.push({ path: path as string, value });
		return originalOverride(path, value);
	}) as typeof settings.override;
	const session = {
		model: alternateModel as Model | undefined,
		thinkingLevel: ThinkingLevel.Low as ThinkingLevel | undefined,
		sessionId: "session-1",
		scopedModels: [],
		modelRegistry: createRegistry(options),
		configuredChains: {} as Record<string, readonly string[]>,
		sessionDefaultModelSelector: undefined as string | undefined,
		defaultFallbackRuntimeModel: undefined as string | undefined,
		activeModelProfile: undefined as string | undefined,
		getConfiguredModelChain(role: string): readonly string[] | undefined {
			return this.configuredChains[role];
		},
		setConfiguredModelChain(role: string, entries: readonly string[]) {
			this.configuredChains[role] = [...entries];
		},
		setModelCalls: [] as Array<{
			model: Model;
			role: string;
			options?: { cause?: string; selector?: string; thinkingLevel?: ThinkingLevel };
		}>,
		async setModel(
			next: Model,
			role: string,
			options?: { cause?: string; selector?: string; thinkingLevel?: ThinkingLevel },
		) {
			this.setModelCalls.push({ model: next, role, options });
			this.model = next;
			if (options?.thinkingLevel !== undefined) {
				this.thinkingLevel = options.thinkingLevel;
			}
			if (role === "default") {
				const selector = options?.selector ?? `${next.provider}/${next.id}`;
				this.configuredChains.default = [selector];
				this.sessionDefaultModelSelector = selector;
				this.defaultFallbackRuntimeModel = undefined;
			}
		},
		setThinkingLevel(next: ThinkingLevel) {
			this.thinkingLevel = next;
		},
		getSessionDefaultModelSelector() {
			return this.sessionDefaultModelSelector;
		},
		recordResumeDefaultModel(selector: string) {
			this.sessionDefaultModelSelector = selector;
		},
		getDefaultFallbackRuntimeModel() {
			return this.defaultFallbackRuntimeModel;
		},
		setDefaultFallbackRuntimeModel(selector: string) {
			this.defaultFallbackRuntimeModel = selector;
		},
		clearDefaultFallbackRuntimeModel() {
			this.defaultFallbackRuntimeModel = undefined;
		},
		getActiveModelProfile() {
			return this.activeModelProfile;
		},
		setActiveModelProfile(profileName: string | undefined) {
			this.activeModelProfile = profileName;
		},
		isFastForProvider: () => false,
		isFastForSubagentProvider: () => false,
		isFastModeActive: () => false,
		setModelTemporaryCalls: [] as Array<{ model: Model; thinkingLevel?: ThinkingLevel }>,
		async setModelTemporary(
			next: Model,
			thinkingLevel?: ThinkingLevel,
			options?: { persistAsSessionDefault?: boolean },
		) {
			this.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			this.model = next;
			this.thinkingLevel = thinkingLevel;
			if (options?.persistAsSessionDefault) this.sessionDefaultModelSelector = `${next.provider}/${next.id}`;
		},
	};
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		settings,
		session,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
	return { ctx, settings, session, flushOrThrow, setCalls, overrideCalls };
}

async function selectProfileThroughController(controller: SelectorController, setDefault = false): Promise<void> {
	controller.showModelSelector();
	const selector = (controller as unknown as { ctx: { editorContainer: { addChild: ReturnType<typeof vi.fn> } } }).ctx
		.editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
	await Bun.sleep(10);
	installTestTheme();
	await selector.__testSelectProfile("profile-a", setDefault);
	await Bun.sleep(0);
}

function createAssignmentControllerContext() {
	const context = createControllerContext({ profiles: [] });
	const previousSelector = "provider-a/alternate";
	const previousChain = [previousSelector, "provider-b/zzz-flat-model"];
	const previousAgentOverrides = {
		executor: previousSelector,
		architect: previousSelector,
		planner: previousSelector,
		critic: previousSelector,
	};

	context.settings.set("modelRoles", { default: previousSelector });
	context.settings.set("task.agentModelOverrides", previousAgentOverrides);
	context.settings.unset("modelProfile.default");
	context.session.configuredChains.default = previousChain;
	context.session.sessionDefaultModelSelector = previousSelector;
	context.session.defaultFallbackRuntimeModel = previousSelector;
	context.setCalls.length = 0;
	context.flushOrThrow.mockClear();

	return { ...context, previousSelector, previousChain, previousAgentOverrides };
}

async function openModelSelectorThroughController(
	context: ReturnType<typeof createAssignmentControllerContext>,
): Promise<ModelSelectorComponent> {
	const controller = new SelectorController(context.ctx as never);
	controller.showModelSelector();
	const selector = context.ctx.editorContainer.addChild.mock.calls.at(-1)?.[0] as ModelSelectorComponent | undefined;
	if (!selector) throw new Error("Model selector did not mount.");
	await Bun.sleep(10);
	installTestTheme();
	return selector;
}

function selectAssignmentThroughKeyboard(selector: ModelSelectorComponent, actionIndex: number): void {
	if (selector.getSearchInput().getValue() !== "default") {
		for (const character of "default") selector.handleInput(character);
	}
	selector.handleInput("\n");
	for (let index = 0; index < actionIndex; index += 1) selector.handleInput("\x1b[B");
	selector.handleInput("\n");
}

async function settleControllerSelection(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

function expectAllAssignmentBadges(rendered: string): void {
	for (const badge of ["[DEFAULT]", "[EXECUTOR]", "[ARCHITECT]", "[PLANNER]", "[CRITIC]"]) {
		expect(rendered).toContain(badge);
	}
}

async function assertAssignmentFlushFailureAndRetry(options: {
	actionIndex: number;
	includesDefault: boolean;
	includesRoleAgents: boolean;
	successStatus: string;
}): Promise<void> {
	const context = createAssignmentControllerContext();
	const selector = await openModelSelectorThroughController(context);
	const previousModel = context.session.model;
	const previousThinkingLevel = context.session.thinkingLevel;
	const previousModelRoles = structuredClone(context.settings.get("modelRoles"));
	const previousAgentModelOverrides = structuredClone(context.settings.get("task.agentModelOverrides"));
	const previousChain = [...(context.session.getConfiguredModelChain("default") ?? [])];
	const previousSessionDefault = context.session.getSessionDefaultModelSelector();
	const previousRuntimeDefault = context.session.getDefaultFallbackRuntimeModel();
	const before = normalizeRenderedText(selector.render(240).join("\n"));
	expectAllAssignmentBadges(before);

	context.flushOrThrow.mockRejectedValueOnce(new Error("durable write failed"));
	selectAssignmentThroughKeyboard(selector, options.actionIndex);
	await settleControllerSelection();

	const failed = normalizeRenderedText(selector.render(240).join("\n"));
	expect(failed).toContain("durable write failed");
	expect(context.ctx.showError).toHaveBeenCalledTimes(1);
	expect(context.ctx.showError).toHaveBeenCalledWith("durable write failed");
	expect(context.ctx.showStatus).not.toHaveBeenCalled();
	expect(context.flushOrThrow).toHaveBeenCalledTimes(2);
	expect(context.settings.get("modelRoles")).toEqual(previousModelRoles);
	expect(context.settings.get("task.agentModelOverrides")).toEqual(previousAgentModelOverrides);
	expect(context.session.model).toBe(previousModel);
	expect(context.session.thinkingLevel).toBe(previousThinkingLevel);
	expect(context.session.getConfiguredModelChain("default")).toEqual(previousChain);
	expect(context.session.getSessionDefaultModelSelector()).toBe(previousSessionDefault);
	expect(context.session.getDefaultFallbackRuntimeModel()).toBe(previousRuntimeDefault);

	selector.getSearchInput().setValue("");
	selector.refreshRoleAssignments();
	expectAllAssignmentBadges(normalizeRenderedText(selector.render(240).join("\n")));

	selectAssignmentThroughKeyboard(selector, options.actionIndex);
	await settleControllerSelection();

	const selectedModelRoles = options.includesDefault ? { default: "provider-a/default" } : previousModelRoles;
	const selectedAgentModelOverrides = options.includesRoleAgents
		? {
				executor: "provider-a/default",
				architect: "provider-a/default",
				planner: "provider-a/default",
				critic: "provider-a/default",
			}
		: previousAgentModelOverrides;
	const expectedModel = options.includesDefault ? defaultModel : previousModel;
	const expectedThinkingLevel = options.includesDefault ? ThinkingLevel.Inherit : previousThinkingLevel;
	const expectedChain = options.includesDefault ? ["provider-a/default"] : previousChain;
	const expectedSessionDefault = options.includesDefault ? "provider-a/default" : previousSessionDefault;
	const expectedRuntimeDefault = options.includesDefault ? undefined : previousRuntimeDefault;

	expect(context.flushOrThrow).toHaveBeenCalledTimes(3);
	expect(context.ctx.showError).toHaveBeenCalledTimes(1);
	expect(context.ctx.showStatus).toHaveBeenCalledTimes(1);
	expect(context.ctx.showStatus).toHaveBeenCalledWith(options.successStatus);
	expect(context.settings.get("modelRoles")).toEqual(selectedModelRoles);
	expect(context.settings.get("task.agentModelOverrides")).toEqual(selectedAgentModelOverrides);
	expect(context.session.model).toBe(expectedModel);
	expect(context.session.thinkingLevel).toBe(expectedThinkingLevel);
	expect(context.session.getConfiguredModelChain("default")).toEqual(expectedChain);
	expect(context.session.getSessionDefaultModelSelector()).toBe(expectedSessionDefault);
	expect(context.session.getDefaultFallbackRuntimeModel()).toBe(expectedRuntimeDefault);
}

describe("model selector profile red-team", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		installTestTheme();
	});

	test("empty profile catalog omits Profiles section and does not crash", async () => {
		const selector = createSelector(() => {}, { profiles: [] });
		const rendered = await renderSelector(selector);

		expect(rendered).not.toContain("Profiles");
		expect(rendered).toContain("provider-a/default");
	});

	test("temporary-only mode hides Profiles even when profiles exist", async () => {
		const selector = createSelector(() => {}, { temporaryOnly: true });
		const rendered = await renderSelector(selector);

		expect(rendered).not.toContain("Profiles");
		expect(rendered).not.toContain("profile-a");
	});

	test("user-overridden profile name appears once", async () => {
		const builtinProfile: ModelProfileDefinition = { ...userProfile, source: "builtin" };
		const overriddenProfile: ModelProfileDefinition = { ...userProfile, source: "user" };
		const selector = createSelector(() => {}, { profiles: [builtinProfile, overriddenProfile] });
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered.match(/Profile Alpha/g) ?? []).toHaveLength(1);
	});

	test("profile actions wire Apply for this session to persistDefault false and Set as default to true", async () => {
		const selections: ModelSelectorSelection[] = [];
		const applySelector = createSelector(selection => {
			selections.push(selection);
		});
		await renderSelector(applySelector);
		applySelector.handleInput("\x1b[C");
		applySelector.handleInput("\x1b[B");
		applySelector.handleInput("\n");
		applySelector.handleInput("\n");
		applySelector.handleInput("\n");
		await Bun.sleep(0);

		const defaultSelector = createSelector(selection => {
			selections.push(selection);
		});
		await renderSelector(defaultSelector);
		defaultSelector.handleInput("\x1b[C");
		defaultSelector.handleInput("\x1b[B");
		defaultSelector.handleInput("\n");
		defaultSelector.handleInput("\n");
		defaultSelector.handleInput("\x1b[B");
		defaultSelector.handleInput("\n");
		await Bun.sleep(0);

		expect(selections).toEqual([
			{ kind: "profile", profileName: "profile-a", setDefault: false },
			{ kind: "profile", profileName: "profile-a", setDefault: true },
		]);
	});

	test("shortcut 'd' key activates profile with Set as default (setDefault: true)", async () => {
		const selections: ModelSelectorSelection[] = [];
		const selector = createSelector(selection => {
			selections.push(selection);
		});
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("d");
		await Bun.sleep(0);

		expect(selections).toEqual([{ kind: "profile", profileName: "profile-a", setDefault: true }]);
	});
	test("treats kNoAuth as usable and applies a profile through the preset keyboard path", async () => {
		const selections: ModelSelectorSelection[] = [];
		const selector = createSelector(
			selection => {
				selections.push(selection);
			},
			{ apiKey: kNoAuth },
		);
		const rendered = await renderSelector(selector);

		expect(rendered).toContain("✓ CUSTOM");

		// Enter on the usable group expands it; the remaining keys are the same
		// preset path a user uses to choose the profile and apply it for this session.
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(selections).toEqual([{ kind: "profile", profileName: "profile-a", setDefault: false }]);
	});

	test("suppresses false login guidance while preset authentication is pending", async () => {
		let resolveAuth!: (apiKey: string | undefined) => void;
		const pendingAuth = new Promise<string | undefined>(resolve => {
			resolveAuth = resolve;
		});
		const selector = createSelector(() => {}, { apiKeyPromise: pendingAuth });

		const pending = await renderSelector(selector);
		const runtimeLoginHint =
			"Provider requires authentication before discovery. Use /provider login or /login for OAuth/subscription providers, or /provider add for API-compatible providers.";
		expect(pending).toContain("… CUSTOM");
		expect(pending).not.toContain(runtimeLoginHint);

		selector.handleInput("\n");
		await Bun.sleep(0);
		expect(normalizeRenderedText(selector.render(240).join("\n"))).not.toContain(runtimeLoginHint);

		resolveAuth("key");
		await pendingAuth;
		await Bun.sleep(0);
		expect(normalizeRenderedText(selector.render(240).join("\n"))).toContain("✓ CUSTOM");
	});

	test("sanitizes hostile provider IDs in rejected preset login guidance", async () => {
		const hostileProvider = "\x1b[31mprovider\nid\t\x1b[0m";
		const hostileProfile: ModelProfileDefinition = {
			...userProfile,
			name: "hostile-profile",
			displayName: "Hostile Profile",
			requiredProviders: [hostileProvider],
		};
		const selector = createSelector(() => {}, { profiles: [hostileProfile], missingCredentials: true });
		await renderSelector(selector);

		selector.handleInput("\n");
		const rendered = Bun.stripANSI(selector.render(240).join("\n"));
		expect(rendered).toContain("Hostile Profile: run /login provider id");
		expect(rendered).not.toContain("\x1b");
		expect(rendered).not.toContain("provider\nid");
	});

	test("double Enter in temporary model mode invokes the callback once", async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => {
			release = resolve;
		});
		const selections: ModelSelectorSelection[] = [];
		const selector = createSelector(
			selection => {
				selections.push(selection);
				return pending;
			},
			{ temporaryOnly: true, initialSearchInput: "default" },
		);
		await renderSelector(selector);

		selector.handleInput("\n");
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(selections).toHaveLength(1);
		expect(selections[0]).toMatchObject({ kind: "assignment", role: null, selector: "provider-a/default" });

		release();
		await pending;
		await Bun.sleep(0);
	});

	test("double Enter for all targets invokes once and preserves prior badges after rejection", async () => {
		const previousSelector = "provider-a/default";
		const selectorSettings = Settings.isolated({
			modelRoles: { default: previousSelector },
			"task.agentModelOverrides": {
				executor: previousSelector,
				architect: previousSelector,
				planner: previousSelector,
				critic: previousSelector,
			},
		});
		const selections: ModelSelectorSelection[] = [];
		const selector = createSelector(
			selection => {
				selections.push(selection);
				return Promise.reject(new Error("multi-target rejected"));
			},
			{ settings: selectorSettings, initialSearchInput: "default" },
		);
		await renderSelector(selector);
		const before = normalizeRenderedText(selector.render(240).join("\n"));
		for (const badge of ["[DEFAULT]", "[EXECUTOR]", "[ARCHITECT]", "[PLANNER]", "[CRITIC]"]) {
			expect(before).toContain(badge);
		}

		selector.handleInput("\n");
		for (let i = 0; i < GJC_MODEL_ASSIGNMENT_TARGET_IDS.length + 1; i++) selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");
		await Bun.sleep(0);
		await Bun.sleep(0);

		const after = normalizeRenderedText(selector.render(240).join("\n"));
		expect(selections).toHaveLength(1);
		expect(selections[0]).toMatchObject({
			kind: "assignment",
			role: "default",
			roles: GJC_MODEL_ASSIGNMENT_TARGET_IDS,
		});
		expect(after).toContain("multi-target rejected");
		for (const badge of ["[DEFAULT]", "[EXECUTOR]", "[ARCHITECT]", "[PLANNER]", "[CRITIC]"]) {
			expect(after).toContain(badge);
		}
	});
	test("double Enter while a profile action is pending invokes only one callback", async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => {
			release = resolve;
		});
		const selections: ModelSelectorSelection[] = [];
		const selector = createSelector(selection => {
			selections.push(selection);
			return pending;
		});
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(selections).toEqual([{ kind: "profile", profileName: "profile-a", setDefault: false }]);
		expect(normalizeRenderedText(selector.render(240).join("\n"))).toContain("Apply for this session");

		release();
		await pending;
		await Bun.sleep(0);
	});

	test("rejected profile action remains visible and can be retried", async () => {
		const selections: ModelSelectorSelection[] = [];
		const onSelect = vi
			.fn<(selection: ModelSelectorSelection) => void | Promise<void>>()
			.mockImplementationOnce(selection => {
				selections.push(selection);
				return Promise.reject(new Error("profile apply rejected"));
			})
			.mockImplementationOnce(selection => {
				selections.push(selection);
			});
		const selector = createSelector(onSelect);
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\n");
		await Bun.sleep(0);
		await Bun.sleep(0);

		const rejected = normalizeRenderedText(selector.render(240).join("\n"));
		expect(selections).toEqual([{ kind: "profile", profileName: "profile-a", setDefault: false }]);
		expect(rejected).toContain("profile apply rejected");
		expect(rejected).toContain("Apply for this session");

		selector.handleInput("\n");
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(selections).toEqual([
			{ kind: "profile", profileName: "profile-a", setDefault: false },
			{ kind: "profile", profileName: "profile-a", setDefault: false },
		]);
	});
	test("controller default assignment rolls back durable failure and retries through keyboard", async () => {
		await assertAssignmentFlushFailureAndRetry({
			actionIndex: 0,
			includesDefault: true,
			includesRoleAgents: false,
			successStatus: "Default model: provider-a/default",
		});
	});

	test("controller role-agent batch rolls back durable failure and retries through keyboard", async () => {
		await assertAssignmentFlushFailureAndRetry({
			actionIndex: GJC_MODEL_ASSIGNMENT_TARGET_IDS.length,
			includesDefault: false,
			includesRoleAgents: true,
			successStatus: "Role-agent models set to provider-a/default for EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		});
	});

	test("controller all-target assignment rolls back durable failure and retries through keyboard", async () => {
		await assertAssignmentFlushFailureAndRetry({
			actionIndex: GJC_MODEL_ASSIGNMENT_TARGET_IDS.length + 1,
			includesDefault: true,
			includesRoleAgents: true,
			successStatus:
				"All model targets set to provider-a/default for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		});
	});
	test("controller persists only Set as default and leaves Apply for this session non-default", async () => {
		const sessionOnly = createControllerContext();
		await selectProfileThroughController(new SelectorController(sessionOnly.ctx as never), false);

		expect(sessionOnly.setCalls).not.toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(sessionOnly.settings.get("modelProfile.default")).toBe("old-profile");
		expect(sessionOnly.ctx.showStatus).toHaveBeenCalledWith("Model profile: Profile Alpha applied.");

		const persistent = createControllerContext();
		await selectProfileThroughController(new SelectorController(persistent.ctx as never), true);

		expect(persistent.setCalls).toContainEqual({ path: "modelProfile.default", value: "profile-a" });
		expect(persistent.setCalls).toContainEqual({ path: "defaultThinkingLevel", value: ThinkingLevel.High });
		expect(persistent.flushOrThrow).toHaveBeenCalledTimes(1);
		expect(persistent.ctx.showStatus).toHaveBeenCalledWith("Default model profile: Profile Alpha saved and applied.");
	});

	test("activation credential error shows error and preserves active model, thinking, overrides, and default", async () => {
		const { ctx, settings, session, overrideCalls, setCalls } = createControllerContext({ missingCredentials: true });
		await selectProfileThroughController(new SelectorController(ctx as never), false);

		expect(ctx.showError).toHaveBeenCalledWith(
			'Model profile "Profile Alpha" requires credentials for: provider-a. Run /login and configure the missing provider(s), then retry.',
		);
		expect(session.setModelTemporaryCalls).toEqual([]);
		expect(session.model).toBe(alternateModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "provider-a/original-executor" });
		expect(settings.get("modelProfile.default")).toBe("old-profile");
		expect(overrideCalls).toEqual([]);
		expect(setCalls).toEqual([]);
	});

	test("profile names with unusual characters render without breaking the list", async () => {
		const weirdProfile: ModelProfileDefinition = {
			...userProfile,
			name: "Team/Profile: β 🚀 [default] {x}|$",
			displayName: "Team/Profile: β 🚀 [default] {x}|$",
		};
		const selector = createSelector(() => {}, { profiles: [weirdProfile] });
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("Model presets");
		expect(rendered).toContain("Team/Profile: β 🚀 [default] {x}|$");
		expect(rendered).toContain("Browse all models");
	});

	test("custom profile display names strip terminal control characters before rendering", async () => {
		const unsafeProfile: ModelProfileDefinition = {
			...userProfile,
			name: "unsafe-profile",
			displayName: "Unsafe\x1b[31mRed\x1b[0m\nNext\tName",
		};
		const selector = createSelector(() => {}, { profiles: [unsafeProfile] });
		await renderSelector(selector);
		selector.handleInput("\x1b[C");
		const rendered = selector.render(240).join("\n");
		const plain = Bun.stripANSI(rendered);

		expect(plain).toContain("UnsafeRed Next Name");
		expect(plain).not.toContain("UnsafeRed\nNext");
	});

	test("Browse all models switches to flat model rows", async () => {
		const selector = createSelector(() => {});
		await renderSelector(selector);

		const visitedRowIdentities = new Set<string>();
		while (true) {
			const rowIdentity = selector.__testSelectedPresetRowIdentity();
			if (!rowIdentity) throw new Error("Expected a selected preset landing row");
			if (rowIdentity === "browse") break;
			if (visitedRowIdentities.has(rowIdentity)) {
				throw new Error(`Preset landing navigation repeated ${rowIdentity} before browse`);
			}
			visitedRowIdentities.add(rowIdentity);
			selector.handleInput("\x1b[B");
		}

		expect(selector.__testSelectedPresetRowIdentity()).toBe("browse");
		selector.handleInput("\n");
		const rendered = normalizeRenderedText(selector.render(240).join("\n"));

		expect(rendered).toContain("Models");
		expect(rendered).toContain("provider-a/default");
		expect(rendered).toContain("provider-b/zzz-flat-model");
	});
});
test("alternative preset hint uses literal OR semantics", async () => {
	const alternativeProfile: ModelProfileDefinition = {
		name: "alternative-profile",
		displayName: "Alternative Profile",
		requiredProviders: ["strict-provider", "alternative-one", "alternative-two"],
		alternativeProviderGroups: [["alternative-one", "alternative-two"]],
		modelMapping: { default: "provider-a/default" },
		source: "user",
	};
	const selector = createSelector(() => {}, {
		profiles: [alternativeProfile],
		missingCredentials: true,
	});
	await renderSelector(selector);
	selector.handleInput("\n");
	await Bun.sleep(0);

	const rendered = normalizeRenderedText(selector.render(240).join("\n"));
	expect(rendered).toContain(
		"Alternative Profile: run /login strict-provider and /login for one of alternative-one or alternative-two",
	);
});

test("delete action leaves the profile deleted when post-delete notification fails", async () => {
	const profiles = new Map<string, ModelProfileDefinition>([[userProfile.name, { ...userProfile }]]);
	const registry = {
		...createRegistry({ profiles: [...profiles.values()] }),
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		deleteCustomModelProfile: vi.fn(async (name: string) => {
			if (!profiles.has(name)) throw new Error("missing profile");
			profiles.delete(name);
		}),
		saveCustomModelProfile: vi.fn(),
		refresh: vi.fn(async () => {}),
	};
	const settings = Settings.isolated({ "modelProfile.default": "unrelated" });
	const ctx = {
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor: {},
		settings,
		session: {
			model: alternateModel,
			thinkingLevel: ThinkingLevel.Low,
			sessionId: "session-1",
			scopedModels: [],
			modelRegistry: registry,
			getActiveModelProfile: () => undefined,
			isFastForProvider: () => false,
			isFastForSubagentProvider: () => false,
			isFastModeActive: () => false,
		},
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showHookConfirm: vi.fn(async () => true),
		notifyConfigChanged: vi.fn(async () => {
			throw new Error("notify failed");
		}),
	};
	const controller = new SelectorController(ctx as never);

	controller.showModelSelector();
	const selector = ctx.editorContainer.addChild.mock.calls[0]?.[0] as ModelSelectorComponent;
	await selector.__testSelectPresetAction("profile-a", "delete");

	expect(registry.deleteCustomModelProfile).toHaveBeenCalledWith("profile-a");
	expect(registry.saveCustomModelProfile).not.toHaveBeenCalled();
	expect(profiles.has("profile-a")).toBe(false);
	expect(ctx.showError).not.toHaveBeenCalled();
	expect(ctx.showStatus).toHaveBeenCalledWith(
		"Custom model preset deleted: Profile Alpha saved, but refresh failed: Settings refresh failed: notify failed",
	);
});
