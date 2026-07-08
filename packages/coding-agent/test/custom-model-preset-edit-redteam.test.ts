import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import * as modelProfileActivation from "@gajae-code/coding-agent/config/model-profile-activation";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { ModelProfileConfig } from "@gajae-code/coding-agent/config/models-config-schema";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	CustomModelPresetWizardComponent,
	type CustomModelPresetWizardSubmit,
} from "@gajae-code/coding-agent/modes/components/custom-model-preset-wizard";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";

// Adversarial (red-team) coverage for the "edit existing custom model preset" feature.
// Goal: try to BREAK the safety/transaction guarantees, not re-confirm the happy path.
// Implementation is FROZEN; this file only adds tests. It intentionally exercises the
// REAL ModelRegistry (real models.yml writes/restores) at the controller layer, which
// the committed controller tests do not (they use an in-memory mock registry).

let tempDir: string;
let authStorage: AuthStorage;

const currentModel = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const effortModel = (provider: string, id: string, thinking?: Model["thinking"]): Model =>
	({
		provider,
		id,
		name: id,
		api: "openai-responses",
		contextWindow: 1000,
		maxTokens: 1000,
		thinking,
		reasoning: thinking !== undefined,
	}) as Model;

const createSnapshot: ModelProfileConfig = {
	required_providers: ["my-oai"],
	model_mapping: { default: "my-oai/gpt-custom:low" },
};

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-preset-redteam-"));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	setThemeInstance((await getThemeByName("red-claw"))!);
});

afterEach(async () => {
	authStorage.close();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function normalizeRenderedText(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function typeText(component: { handleInput(input: string): void }, value: string): void {
	for (const char of value) component.handleInput(char);
	component.handleInput("\n");
}

type CandidateRegistry = Pick<
	ModelRegistry,
	"getAll" | "getApiKeyForProvider" | "resolveCanonicalModel" | "getCanonicalVariants" | "getCanonicalId"
>;

// Registry surface for the pure validator (mirrors the committed validation suite),
// including an effort-capped model (max level xhigh) so clamp behaviour is exercised.
function candidateRegistry(options?: { missingProviders?: string[] }): CandidateRegistry {
	const missing = new Set(options?.missingProviders ?? []);
	return {
		getAll: () => [
			effortModel("my-oai", "gpt-custom"),
			effortModel("anthropic", "claude"),
			effortModel("openai-codex", "gpt-5.5", {
				mode: "effort",
				minLevel: ThinkingLevel.Low,
				maxLevel: ThinkingLevel.XHigh,
			}),
		],
		getApiKeyForProvider: async (provider: string) => (missing.has(provider) ? undefined : `key-${provider}`),
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	} as unknown as CandidateRegistry;
}

interface RealEditHarness {
	ctx: unknown;
	registry: ModelRegistry;
	modelsPath: string;
	before: string;
	statuses: string[];
	errors: string[];
	getSelector: () => ModelSelectorComponent | undefined;
	getWizard: () => CustomModelPresetWizardComponent | undefined;
}

// Controller harness backed by a REAL ModelRegistry writing a REAL models.yml.
async function createRealEditHarness(config: {
	activeModelProfile?: string;
	defaultModelProfile?: string;
}): Promise<RealEditHarness> {
	const modelsPath = path.join(tempDir, "models.yml");
	const registry = new ModelRegistry(authStorage, modelsPath);
	await registry.saveCustomModelProfile("my-fast", {
		display_name: "My Fast",
		required_providers: ["my-oai"],
		model_mapping: { default: "my-oai/gpt-custom:low" },
	});
	const before = await Bun.file(modelsPath).text();
	const settings = Settings.isolated(
		config.defaultModelProfile ? { "modelProfile.default": config.defaultModelProfile } : {},
	);
	const activeProfiles: (string | undefined)[] = [config.activeModelProfile];
	const statuses: string[] = [];
	const errors: string[] = [];
	let selector: ModelSelectorComponent | undefined;
	let wizard: CustomModelPresetWizardComponent | undefined;
	const ctx = {
		ui: { setFocus: () => {}, requestRender: () => {} },
		editorContainer: {
			clear: () => {},
			addChild: (child: unknown) => {
				if (child instanceof ModelSelectorComponent) selector = child;
				if (child instanceof CustomModelPresetWizardComponent) wizard = child;
			},
		},
		editor: {},
		settings,
		session: {
			model: currentModel("my-oai", "gpt-custom"),
			thinkingLevel: ThinkingLevel.Low,
			sessionId: "session",
			scopedModels: [],
			modelRegistry: registry,
			getActiveModelProfile: () => activeProfiles.at(-1),
			setActiveModelProfile: (name?: string) => activeProfiles.push(name),
			isFastForProvider: () => false,
			isFastForSubagentProvider: () => false,
			isFastModeActive: () => false,
		},
		statusLine: { invalidate: () => {} },
		updateEditorBorderColor: () => {},
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => errors.push(message),
		notifyConfigChanged: async () => {},
	};
	return {
		ctx,
		registry,
		modelsPath,
		before,
		statuses,
		errors,
		getSelector: () => selector,
		getWizard: () => wizard,
	};
}

async function runEditSave(harness: RealEditHarness, profileName: string): Promise<void> {
	new SelectorController(harness.ctx as never).showModelSelector();
	await Bun.sleep(0);
	const selector = harness.getSelector();
	if (!selector) throw new Error("selector not mounted");
	await selector.__testSelectPresetAction(profileName, "edit");
	await Bun.sleep(0);
	const wizard = harness.getWizard();
	if (!wizard) throw new Error("edit wizard not mounted");
	wizard.handleInput("s");
	await Bun.sleep(20);
}

// ok:true validator that echoes the wizard's submitted profile (no mutation).
function spyValidateEcho() {
	return spyOn(modelProfileActivation, "validateModelProfileCandidate").mockImplementation(async options => ({
		ok: true,
		profile: options.profile,
		requiredProviders: options.profile.required_providers,
		normalizedMapping: options.profile.model_mapping,
	}));
}

// ok:true validator that injects a CHANGED normalized profile, forcing a real models.yml
// mutation through the controller (simulates the user editing the default selector).
function spyValidateMutated(mutated: ModelProfileConfig) {
	return spyOn(modelProfileActivation, "validateModelProfileCandidate").mockImplementation(async () => ({
		ok: true,
		profile: mutated,
		requiredProviders: mutated.required_providers,
		normalizedMapping: mutated.model_mapping,
	}));
}

describe("custom model preset edit — red team", () => {
	// (a) primitive: real edit mutates models.yml; restore reverts byte-exact + refreshes profile.
	it("(a) editCustomModelProfile mutates models.yml then restore reverts byte-exact and refreshes getModelProfiles", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("my-fast", {
			display_name: "My Fast",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});
		const before = await Bun.file(modelsPath).text();

		const { snapshot } = await registry.editCustomModelProfile("my-fast", {
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude:high", executor: "my-oai/gpt-custom" },
		});
		const afterEdit = await Bun.file(modelsPath).text();
		expect(afterEdit).not.toBe(before);
		expect(afterEdit).toContain("anthropic/claude:high");
		expect(snapshot.previousModelsConfigText).toBe(before);
		expect(registry.getModelProfiles().get("my-fast")?.modelMapping.default).toBe("anthropic/claude:high");

		await registry.restoreCustomModelProfileEdit(snapshot);
		const afterRestore = await Bun.file(modelsPath).text();
		expect(afterRestore).toBe(before); // byte-exact restore
		expect(afterRestore).not.toContain("anthropic/claude:high"); // zero residual mutation

		const restored = registry.getModelProfiles().get("my-fast");
		expect(restored?.displayName).toBe("My Fast");
		expect(restored?.modelMapping.default).toBe("my-oai/gpt-custom:low");
		expect(restored?.modelMapping.executor).toBeUndefined();
		expect(restored?.requiredProviders).toEqual(["my-oai"]);
	});

	// (a) transaction robustness: a normal edit re-serializes YAML (dropping comments and
	// reordering keys), but a failed activation must restore the ORIGINAL bytes exactly,
	// including a hand-authored comment and the untouched providers block.
	it("(a) restore rewrites the exact prior bytes including comments a normal edit would drop", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const original = [
			"# hand-authored config",
			"providers:",
			"  my-oai:",
			"    baseUrl: https://proxy.example.com/v1",
			"    apiKeyEnv: MY_OAI_KEY",
			"profiles:",
			"  my-fast:",
			"    display_name: My Fast",
			"    required_providers: [my-oai]",
			"    model_mapping:",
			"      default: my-oai/gpt-custom:low",
			"",
		].join("\n");
		await Bun.write(modelsPath, original);
		const registry = new ModelRegistry(authStorage, modelsPath);

		const { snapshot } = await registry.editCustomModelProfile("my-fast", {
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude:high" },
		});
		const afterEdit = await Bun.file(modelsPath).text();
		expect(afterEdit).not.toBe(original);
		expect(afterEdit).not.toContain("# hand-authored config"); // edit re-serialization drops the comment
		expect(snapshot.previousModelsConfigText).toBe(original); // exact prior bytes captured

		await registry.restoreCustomModelProfileEdit(snapshot);
		const afterRestore = await Bun.file(modelsPath).text();
		expect(afterRestore).toBe(original); // byte-exact incl comment + providers block
		expect(afterRestore).toContain("# hand-authored config"); // comment fully restored
		expect(registry.getModelProfiles().get("my-fast")?.modelMapping.default).toBe("my-oai/gpt-custom:low");
	});

	// (a) controller wiring: activation PREPARE failure -> byte-exact restore of the real file.
	it("(a) controller restores byte-exact models.yml when activation PREPARE fails (real registry)", async () => {
		const harness = await createRealEditHarness({ activeModelProfile: "my-fast", defaultModelProfile: "my-fast" });
		const mutated: ModelProfileConfig = {
			display_name: "My Fast",
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude:high" },
		};
		const validateSpy = spyValidateMutated(mutated);
		const activateSpy = spyOn(modelProfileActivation, "activateModelProfile").mockRejectedValue(
			new Error("prepare exploded"),
		);
		try {
			await runEditSave(harness, "my-fast");
			const afterRestore = await Bun.file(harness.modelsPath).text();
			expect(afterRestore).toBe(harness.before); // byte-exact
			expect(afterRestore).not.toContain("anthropic/claude:high"); // mutation reverted
			const restored = harness.registry.getModelProfiles().get("my-fast");
			expect(restored?.displayName).toBe("My Fast");
			expect(restored?.modelMapping.default).toBe("my-oai/gpt-custom:low");
			expect(restored?.requiredProviders).toEqual(["my-oai"]);
			expect(activateSpy).toHaveBeenCalledTimes(1);
			expect(harness.statuses).toEqual([]); // success suppressed
			expect(harness.errors.some(message => message.includes("prepare exploded"))).toBe(true);
		} finally {
			validateSpy.mockRestore();
			activateSpy.mockRestore();
		}
	});

	// (a) controller wiring: activation APPLY failure -> byte-exact restore of the real file.
	it("(a) controller restores byte-exact models.yml when activation APPLY fails (real registry)", async () => {
		const harness = await createRealEditHarness({ activeModelProfile: "my-fast", defaultModelProfile: "my-fast" });
		const mutated: ModelProfileConfig = {
			display_name: "My Fast",
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude:high" },
		};
		const validateSpy = spyValidateMutated(mutated);
		const activateSpy = spyOn(modelProfileActivation, "activateModelProfile").mockRejectedValue(
			new Error("apply exploded"),
		);
		try {
			await runEditSave(harness, "my-fast");
			const afterRestore = await Bun.file(harness.modelsPath).text();
			expect(afterRestore).toBe(harness.before); // byte-exact
			expect(afterRestore).not.toContain("anthropic/claude:high");
			expect(harness.registry.getModelProfiles().get("my-fast")?.modelMapping.default).toBe("my-oai/gpt-custom:low");
			expect(activateSpy).toHaveBeenCalledTimes(1);
			expect(harness.statuses).toEqual([]);
			expect(harness.errors.some(message => message.includes("apply exploded"))).toBe(true);
		} finally {
			validateSpy.mockRestore();
			activateSpy.mockRestore();
		}
	});

	// (b) unit: the real validator rejects each invalid candidate.
	it("(b) validator rejects an unresolvable selector (ok:false)", async () => {
		const result = await modelProfileActivation.validateModelProfileCandidate({
			profileName: "bad",
			profile: { required_providers: ["ghost"], model_mapping: { default: "ghost/does-not-exist:high" } },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("did not resolve");
	});

	it("(b) validator rejects a missing-credential provider (ok:false)", async () => {
		const result = await modelProfileActivation.validateModelProfileCandidate({
			profileName: "needs-key",
			profile: { required_providers: ["my-oai"], model_mapping: { default: "my-oai/gpt-custom:low" } },
			modelRegistry: candidateRegistry({ missingProviders: ["my-oai"] }),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("my-oai");
	});

	it("(b) validator rejects zero mapped roles (ok:false)", async () => {
		const result = await modelProfileActivation.validateModelProfileCandidate({
			profileName: "empty",
			profile: { required_providers: ["my-oai"], model_mapping: {} },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("at least one role");
	});

	it("(b) validator rejects an unknown effort suffix :ultra (ok:false)", async () => {
		const result = await modelProfileActivation.validateModelProfileCandidate({
			profileName: "ultra",
			profile: { required_providers: ["openai-codex"], model_mapping: { default: "openai-codex/gpt-5.5:ultra" } },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.toLowerCase()).toContain("invalid");
	});

	// (b) controller: validate-before-write. When validation fails, editCustomModelProfile is
	// NEVER invoked and models.yml is left byte-identical. Reason-agnostic guard, so probe all 4.
	const guardCases = [
		{
			id: "unresolvable-selector",
			reason: "Model profile default selector did not resolve: ghost/x:high",
			contains: "did not resolve",
		},
		{
			id: "missing-credential",
			reason:
				'Model profile "my-fast" requires credentials for: my-oai. Run /login and configure the missing provider(s), then retry.',
			contains: "requires credentials",
		},
		{ id: "zero-roles", reason: "Model profile must map at least one role.", contains: "at least one role" },
		{
			id: "unknown-effort",
			reason: "Invalid model profile at /model_mapping/default: unknown effort",
			contains: "Invalid model profile",
		},
	] as const;

	for (const guard of guardCases) {
		it(`(b) controller never writes models.yml or calls editCustomModelProfile when validation fails: ${guard.id}`, async () => {
			const harness = await createRealEditHarness({
				activeModelProfile: "my-fast",
				defaultModelProfile: "my-fast",
			});
			const editSpy = spyOn(harness.registry, "editCustomModelProfile");
			const validateSpy = spyOn(modelProfileActivation, "validateModelProfileCandidate").mockResolvedValue({
				ok: false,
				reason: guard.reason,
			});
			try {
				await runEditSave(harness, "my-fast");
				expect(editSpy).not.toHaveBeenCalled(); // no config write attempted
				expect(await Bun.file(harness.modelsPath).text()).toBe(harness.before); // file untouched
				expect(harness.statuses).toEqual([]); // no success surfaced
				const rendered = normalizeRenderedText(harness.getWizard()!.render(120).join("\n"));
				expect(rendered).toContain(guard.contains);
			} finally {
				validateSpy.mockRestore();
				editSpy.mockRestore();
			}
		});
	}

	// (c) 4-case activation matrix — exact activateModelProfile call counts + persistDefault flag.
	it("(c) active+default -> activate called exactly once with persistDefault:true (no double-mutate)", async () => {
		const harness = await createRealEditHarness({ activeModelProfile: "my-fast", defaultModelProfile: "my-fast" });
		const validateSpy = spyValidateEcho();
		const activateSpy = spyOn(modelProfileActivation, "activateModelProfile").mockResolvedValue(undefined);
		try {
			await runEditSave(harness, "my-fast");
			expect(activateSpy).toHaveBeenCalledTimes(1);
			expect(activateSpy.mock.calls[0]?.[1]).toEqual({ persistDefault: true });
			expect(harness.errors).toEqual([]);
			expect(harness.statuses.length).toBeGreaterThan(0);
		} finally {
			validateSpy.mockRestore();
			activateSpy.mockRestore();
		}
	});

	it("(c) active-only -> activate called exactly once with persistDefault:false", async () => {
		const harness = await createRealEditHarness({
			activeModelProfile: "my-fast",
			defaultModelProfile: "other-default",
		});
		const validateSpy = spyValidateEcho();
		const activateSpy = spyOn(modelProfileActivation, "activateModelProfile").mockResolvedValue(undefined);
		try {
			await runEditSave(harness, "my-fast");
			expect(activateSpy).toHaveBeenCalledTimes(1);
			expect(activateSpy.mock.calls[0]?.[1]).toEqual({ persistDefault: false });
			expect(harness.statuses.length).toBeGreaterThan(0);
		} finally {
			validateSpy.mockRestore();
			activateSpy.mockRestore();
		}
	});

	it("(c) default-but-not-active -> activate NEVER called", async () => {
		const harness = await createRealEditHarness({
			activeModelProfile: "other-active",
			defaultModelProfile: "my-fast",
		});
		const validateSpy = spyValidateEcho();
		const activateSpy = spyOn(modelProfileActivation, "activateModelProfile").mockResolvedValue(undefined);
		try {
			await runEditSave(harness, "my-fast");
			expect(activateSpy).not.toHaveBeenCalled();
			expect(harness.statuses.length).toBeGreaterThan(0);
		} finally {
			validateSpy.mockRestore();
			activateSpy.mockRestore();
		}
	});

	it("(c) inactive+not-default -> activate NEVER called", async () => {
		const harness = await createRealEditHarness({
			activeModelProfile: "other-active",
			defaultModelProfile: "other-default",
		});
		const validateSpy = spyValidateEcho();
		const activateSpy = spyOn(modelProfileActivation, "activateModelProfile").mockResolvedValue(undefined);
		try {
			await runEditSave(harness, "my-fast");
			expect(activateSpy).not.toHaveBeenCalled();
			expect(harness.statuses.length).toBeGreaterThan(0);
		} finally {
			validateSpy.mockRestore();
			activateSpy.mockRestore();
		}
	});

	// (d) clamp-not-reject: above-max effort accepted+normalized; unknown suffix rejected.
	it("(d) above-max effort :max is accepted and normalizedMapping holds the clamped :xhigh selector", async () => {
		const result = await modelProfileActivation.validateModelProfileCandidate({
			profileName: "clamp",
			profile: { required_providers: ["openai-codex"], model_mapping: { default: "openai-codex/gpt-5.5:max" } },
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.normalizedMapping.default).toBe("openai-codex/gpt-5.5:xhigh");
			expect(result.normalizedMapping.default).not.toBe("openai-codex/gpt-5.5:max");
		}
	});

	it("(d) :ultra is rejected even when paired with an otherwise-valid role (no partial clamp)", async () => {
		const result = await modelProfileActivation.validateModelProfileCandidate({
			profileName: "mixed",
			profile: {
				required_providers: ["openai-codex", "anthropic"],
				model_mapping: { default: "openai-codex/gpt-5.5:max", executor: "openai-codex/gpt-5.5:ultra" },
			},
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.toLowerCase()).toContain("invalid");
	});

	it("(d) a clamped role and an exact-effort role are both accepted and normalized per role", async () => {
		const result = await modelProfileActivation.validateModelProfileCandidate({
			profileName: "per-role",
			profile: {
				required_providers: ["openai-codex", "anthropic"],
				model_mapping: { default: "openai-codex/gpt-5.5:max", executor: "openai-codex/gpt-5.5:high" },
			},
			modelRegistry: candidateRegistry(),
			settings: Settings.isolated(),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.normalizedMapping.default).toBe("openai-codex/gpt-5.5:xhigh"); // clamped
			expect(result.normalizedMapping.executor).toBe("openai-codex/gpt-5.5:high"); // untouched
		}
	});

	// (e) edit preserves key + display_name even when a different display_name/key is supplied.
	it("(e) edit preserves the profile key and original display_name, ignoring a supplied display_name", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.saveCustomModelProfile("keep-me", {
			display_name: "Original Name",
			required_providers: ["my-oai"],
			model_mapping: { default: "my-oai/gpt-custom:low" },
		});

		const { profile } = await registry.editCustomModelProfile("keep-me", {
			display_name: "Attempted New Name",
			required_providers: ["anthropic"],
			model_mapping: { default: "anthropic/claude:high" },
		});

		expect(profile.name).toBe("keep-me");
		expect(profile.displayName).toBe("Original Name"); // supplied display_name ignored
		expect(profile.modelMapping.default).toBe("anthropic/claude:high"); // mapping still updated

		const profiles = registry.getModelProfiles();
		expect(profiles.get("keep-me")?.displayName).toBe("Original Name");
		expect(profiles.get("keep-me")?.modelMapping.default).toBe("anthropic/claude:high");
		expect(profiles.get("Attempted New Name")).toBeUndefined(); // no rogue key created
		expect(registry.getModelProfile("Attempted New Name")).toBeUndefined();
	});

	// (f) create-mode wizard is unchanged: single id input, no roles/secrets, one create submit.
	it("(f) create-mode wizard still emits the single-input create submit unchanged", () => {
		const submitted: CustomModelPresetWizardSubmit[] = [];
		const wizard = new CustomModelPresetWizardComponent(
			createSnapshot,
			input => submitted.push(input),
			() => {},
			() => {},
		);

		typeText(wizard, "Bad Name");
		const rejected = normalizeRenderedText(wizard.render(120).join("\n"));
		expect(rejected).toContain("Preset id must use lowercase letters, numbers, dots, underscores, or hyphens.");
		expect(rejected).not.toContain("Roles");
		expect(rejected).not.toContain("API key");
		expect(rejected).not.toContain("secret");
		expect(submitted).toEqual([]);

		typeText(wizard, "my-fast");
		expect(submitted).toEqual([
			{
				name: "my-fast",
				profile: {
					display_name: "my-fast",
					required_providers: ["my-oai"],
					model_mapping: { default: "my-oai/gpt-custom:low" },
				},
			},
		]);
	});
});
