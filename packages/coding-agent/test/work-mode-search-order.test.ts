import { beforeAll, expect, test } from "bun:test";
import * as path from "node:path";
import { ProcessTerminal, TUI } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { CURATED_WORK_MODES, getCuratedWorkMode, type WorkModeId } from "../src/config/work-mode-catalog";
import {
	buildWorkModeRoleTuple,
	computeWorkModeFingerprint,
	definitionFactFromProfile,
	presentFingerprintFact,
	type ReadinessFact,
	type RoleResolutionFact,
	type WorkModeFacts,
	type WorkModeFingerprintInput,
	type WorkModePreviewResult,
	type WorkModeRoleReadiness,
} from "../src/config/work-mode-result";
import {
	createWorkModePreviewView,
	createWorkModeSelectorCards,
	type WorkModeSelectorCard,
} from "../src/config/work-mode-view";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
	type ModelSelectorWorkModeAdapter,
} from "../src/modes/components/model-selector";
import {
	type SettingsCallbacks,
	type SettingsRuntimeContext,
	SettingsSelectorComponent,
} from "../src/modes/components/settings-selector";
import { initTheme } from "../src/modes/theme/theme";
import { AuthStorage } from "../src/session/auth-storage";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

type RegistryHarness = {
	tempDir: TempDir;
	authStorage: AuthStorage;
	registry: ModelRegistry;
};

async function createRegistryHarness(): Promise<RegistryHarness> {
	const tempDir = TempDir.createSync("@work-mode-search-order-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	return { tempDir, authStorage, registry };
}

function makeFingerprint(modeId: WorkModeId) {
	const mode = getCuratedWorkMode(modeId);
	if (!mode) throw new Error(`Unknown Work Mode: ${modeId}`);
	const profile = BUILTIN_MODEL_PROFILES.find(candidate => candidate.name === mode.profileId);
	if (!profile) throw new Error(`Missing bundled profile: ${mode.profileId}`);
	const definition = definitionFactFromProfile(profile, profile.name);
	if (!definition) throw new Error(`Missing profile facts: ${profile.name}`);

	const input: WorkModeFingerprintInput = {
		catalog: presentFingerprintFact({
			version: 1,
			modeId: mode.id,
			profileId: mode.profileId,
			entryDigest: `entry:${mode.id}`,
		}),
		bundledDefinition: presentFingerprintFact(definition),
		effectiveDefinition: presentFingerprintFact(definition),
		registryResolution: presentFingerprintFact({
			registryRevision: "registry-test",
			resolutionRevision: "resolution-test",
			resolutionDigest: "resolution-digest",
		}),
		readiness: presentFingerprintFact({
			strictProviders: profile.requiredProviders.map(providerId => ({ providerId, state: "ready" })),
			alternativeGroups: (profile.alternativeProviderGroups ?? []).map(providerIds => ({
				providerIds,
				state: "ready",
				selectedProviderId: providerIds[0] ?? null,
			})),
		} satisfies ReadinessFact),
		roles: buildWorkModeRoleTuple((_index, role) => {
			const requested = profile.modelMapping[role] ?? null;
			const roleFact: RoleResolutionFact = {
				role,
				requested,
				resolved: requested === null ? null : String(requested),
				effort: requested === null ? null : "high",
				state: requested === null ? "not_configured" : "resolved",
			};
			return presentFingerprintFact(roleFact);
		}),
		fallback: presentFingerprintFact({
			defaultChain: [String(profile.modelMapping.default ?? "")],
			activeIndex: 0,
			skips: [],
		}),
		confirmation: { required: false, roleDegradation: [] },
	};
	return computeWorkModeFingerprint(input);
}

function makePreview(modeId: WorkModeId): WorkModePreviewResult {
	const mode = getCuratedWorkMode(modeId);
	if (!mode) throw new Error(`Unknown Work Mode: ${modeId}`);
	const profile: ModelProfileDefinition | undefined = BUILTIN_MODEL_PROFILES.find(
		candidate => candidate.name === mode.profileId,
	);
	if (!profile) throw new Error(`Missing bundled profile: ${mode.profileId}`);
	const roleReadiness: WorkModeRoleReadiness = {
		kind: "complete",
		confirmation: "not_required",
	};
	const facts: WorkModeFacts = {
		mode,
		profileId: profile.name,
		requestedRoleReadiness: roleReadiness,
	};
	return {
		phase: "preview",
		state: "ready",
		fingerprint: makeFingerprint(modeId),
		facts,
		roleReadiness,
		confirmationRequired: false,
	};
}

function makeSelector(
	tui: TUI,
	registry: ModelRegistry,
	cards: readonly WorkModeSelectorCard[],
	previews: string[],
): ModelSelectorComponent {
	const adapter: ModelSelectorWorkModeAdapter = {
		cards,
		preview: async modeId => {
			previews.push(modeId);
			const mode = getCuratedWorkMode(modeId);
			if (!mode) throw new Error(`Unknown Work Mode: ${modeId}`);
			const result = makePreview(mode.id);
			return { result, view: createWorkModePreviewView(modeId, result) };
		},
	};
	const selections: ModelSelectorSelection[] = [];
	return new ModelSelectorComponent(
		tui,
		undefined,
		Settings.isolated(),
		registry,
		[],
		selection => {
			selections.push(selection);
		},
		() => {},
		{ workModeAdapter: adapter },
	);
}

type SettingsSelectorHarness = {
	component: SettingsSelectorComponent;
	settings: Settings;
};

function makeSettingsSelector(cards: readonly WorkModeSelectorCard[], selected: string[]): SettingsSelectorHarness {
	const settings = Settings.isolated();
	const context: SettingsRuntimeContext = {
		settings,
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: ["dark"],
		availableModelProfiles: [],
		workModeCards: cards,
		cwd: process.cwd(),
	};
	const callbacks: SettingsCallbacks = {
		onWorkModeSelect: modeId => {
			selected.push(modeId);
		},
		onChange: () => {},
		onCancel: () => {},
	};
	return { component: new SettingsSelectorComponent(context, callbacks), settings };
}

function plain(text: string): string {
	return Bun.stripANSI(text).replace(/\s+/g, " ").trim();
}

test("keeps curated Work Modes in catalog order, searches without applying, and previews only on Enter", async () => {
	const cards = createWorkModeSelectorCards();
	expect(cards.map(card => card.modeId)).toEqual(CURATED_WORK_MODES.map(mode => mode.id));
	expect(cards.map(card => card.label)).toEqual(["Quick Edit", "Daily Coding", "Deep Plan", "Review", "Autonomous"]);
	expect(cards.every(card => card.searchText.includes(card.modeId))).toBe(true);

	const selected: string[] = [];
	const settingsHarness = makeSettingsSelector(cards, selected);
	const settingsSelector = settingsHarness.component;
	const initialDefaultProfile = settingsHarness.settings.get("modelProfile.default");
	settingsSelector.handleInput("\n");
	const submenu = plain(settingsSelector.render(120).join("\n"));
	expect(submenu).toContain("Work Modes");
	expect(submenu.indexOf("Quick Edit")).toBeLessThan(submenu.indexOf("Autonomous"));
	settingsSelector.handleInput("\n");
	expect(selected).toEqual(["quick-edit"]);
	expect(settingsHarness.settings.get("modelProfile.default")).toBe(initialDefaultProfile);

	const registryHarness = await createRegistryHarness();
	try {
		const tui = new TUI(new ProcessTerminal(), false, { widthSettleMs: 0 });
		const previews: string[] = [];
		const selector = makeSelector(tui, registryHarness.registry, cards, previews);
		await Bun.sleep(10);
		const rendered = selector.render(220).map(plain).join("\n");
		const order = cards.map(card => rendered.indexOf(card.label));
		expect(order.every(index => index >= 0)).toBe(true);
		for (let index = 1; index < order.length; index += 1) {
			expect(order[index - 1]!).toBeLessThan(order[index]!);
		}
		expect(order.at(-1)!).toBeLessThan(rendered.indexOf("Browse all models"));

		selector.getSearchInput().focused = true;
		selector.handleInput("q");
		expect(selector.getSearchInput().getValue()).toBe("q");
		expect(previews).toEqual([]);
		selector.dispose();
		tui.stop();

		const disabledCards = createWorkModeSelectorCards({
			unavailableModeIds: new Set(["quick-edit"]),
			unavailableReasons: new Map([["quick-edit", "Login required for openai-codex"]]),
		});
		const disabledTui = new TUI(new ProcessTerminal(), false, { widthSettleMs: 0 });
		const disabledPreviews: string[] = [];
		const disabledSelector = makeSelector(disabledTui, registryHarness.registry, disabledCards, disabledPreviews);
		await Bun.sleep(10);
		disabledSelector.handleInput("\n");
		await Bun.sleep(10);
		expect(disabledPreviews).toEqual([]);
		expect(disabledSelector.render(220).map(plain).join("\n")).toContain("Login required for openai-codex");
		disabledSelector.dispose();
		disabledTui.stop();

		const enterTui = new TUI(new ProcessTerminal(), false, { widthSettleMs: 0 });
		const enterPreviews: string[] = [];
		const enterSelector = makeSelector(enterTui, registryHarness.registry, cards, enterPreviews);
		await Bun.sleep(10);
		enterSelector.handleInput("\n");
		await Bun.sleep(10);
		expect(enterPreviews).toEqual(["quick-edit"]);
		expect(enterSelector.render(220).map(plain).join("\n")).toContain("Work Mode preview: Quick Edit");
		enterSelector.dispose();
		enterTui.stop();
	} finally {
		registryHarness.authStorage.close();
		registryHarness.tempDir.removeSync();
	}
});
