import { afterEach, describe, expect, test } from "bun:test";
import { type Api, type GeneratedProvider, getBundledModel, type Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk/session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import {
	type CanonicalModelRecordInput,
	createCanonicalModelCatalog,
	ModelCatalogError,
	projectModelRegistry,
} from "../src/config/model-catalog";
import { createModelResolutionOverlay, type ModelResolutionOverlayInput } from "../src/config/model-resolution-overlay";
import {
	projectCanonicalModelCatalog,
	projectModelResolutionOverlay,
	type SdkModelCatalog,
	type SdkModelResolutionOverlay,
} from "../src/sdk/models";

const fixtures: Array<{
	result: CreateAgentSessionResult;
	authStorage: AuthStorage;
	tempDir: TempDir;
}> = [];

function model(provider: GeneratedProvider, id: string): Model<Api> {
	const value = getBundledModel(provider, id);
	if (!value) throw new Error(`Expected bundled model ${provider}/${id}`);
	return value;
}

function catalogOf(result: CreateAgentSessionResult): SdkModelCatalog {
	const catalog = result.getModelCatalog?.();
	if (!catalog) throw new Error("The SDK session did not expose a model catalog projection.");
	return catalog;
}

function overlayOf(result: CreateAgentSessionResult): SdkModelResolutionOverlay {
	const overlay = result.getModelResolutionOverlay?.();
	if (!overlay) throw new Error("The SDK session did not expose a current-session overlay projection.");
	return overlay;
}

async function createFixture(currentModel: Model<Api>, roleModel: Model<Api>): Promise<CreateAgentSessionResult> {
	const tempDir = TempDir.createSync("@sdk-model-catalog-projection-");
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey(currentModel.provider, "test-key");
	authStorage.setRuntimeApiKey(roleModel.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated({
		modelRoles: {
			default: `${currentModel.provider}/${currentModel.id}:medium`,
		},
		"task.agentModelOverrides": {
			executor: `${roleModel.provider}/${roleModel.id}:low`,
		},
	});
	const result = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		authStorage,
		modelRegistry,
		model: currentModel,
		settings,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		disableExtensionDiscovery: true,
		extensions: [],
		rules: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames: [],
		workspaceTree: {
			rootPath: tempDir.path(),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
	});
	fixtures.push({ result, authStorage, tempDir });
	return result;
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) {
		await fixture.result.session.dispose();
		fixture.authStorage.close();
		fixture.tempDir.removeSync();
	}
});

describe("SDK canonical model catalog and session overlay projections", () => {
	test("deep-freezes safe catalog copies and excludes registry-private fields", () => {
		const source = model("openai", "gpt-4o-mini");
		const catalog = projectCanonicalModelCatalog(projectModelRegistry([source]));
		const record = catalog.records[0];
		if (!record) throw new Error("Expected one projected model record");

		expect(Object.isFrozen(catalog)).toBe(true);
		expect(Object.isFrozen(catalog.records)).toBe(true);
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.inputModalities)).toBe(true);
		expect(Object.isFrozen(record.capabilities)).toBe(true);
		expect(Object.isFrozen(record.freshness)).toBe(true);
		expect(JSON.stringify(catalog)).not.toContain("baseUrl");
		expect(JSON.stringify(catalog)).not.toContain("apiKey");
		expect(JSON.stringify(catalog)).not.toContain("cost");
		expect(JSON.stringify(catalog)).not.toContain("sessionId");
		expect(JSON.stringify(catalog)).not.toContain("fallbackChain");
	});

	test("rejects an overlay projected for a different session", () => {
		const record: CanonicalModelRecordInput = {
			canonicalId: "openai/primary",
			provider: "openai",
			modelId: "primary",
			displayName: "Primary",
			inputModalities: ["text"],
			capabilities: ["reasoning"],
			reasoning: true,
			contextWindow: 1000,
			maxTokens: 100,
			source: "builtin",
			sourceVersion: "builtin",
			revision: 1,
			freshness: { status: "fresh" },
		};
		const catalog = createCanonicalModelCatalog([record], { revision: 4 });
		const input: ModelResolutionOverlayInput = {
			sessionId: "session-a",
			catalogRevision: 4,
			sessionRevision: 1,
			catalogRecordId: "openai/primary",
			requestedSelectors: ["openai/primary:medium"],
			requestedRoles: ["default"],
			resolvedCanonicalIds: ["openai/primary"],
			resolvedEfforts: ["medium"],
			fallbackChain: ["openai/primary"],
			activeIndex: 0,
			skips: [],
			receiptRefs: [],
		};
		const overlay = createModelResolutionOverlay(input, catalog);

		expect(() => projectModelResolutionOverlay(overlay, "session-b")).toThrow(ModelCatalogError);
		try {
			projectModelResolutionOverlay(overlay, "session-b");
		} catch (error: unknown) {
			expect(error).toMatchObject({ code: "invalid_session_id" });
		}
	});

	test("returns a fresh base snapshot and an explicit current-session overlay", async () => {
		const current = model("openai", "gpt-4o-mini");
		const role = model("anthropic", "claude-sonnet-4-5");
		const result = await createFixture(current, role);
		const firstCatalog = catalogOf(result);
		const secondCatalog = catalogOf(result);
		const overlay = overlayOf(result);

		expect(secondCatalog).not.toBe(firstCatalog);
		expect(secondCatalog.records).not.toBe(firstCatalog.records);
		expect(overlay.sessionId).toBe(result.session.sessionId);
		expect(overlay.catalogRecordId).toBe(`${current.provider}/${current.id}`);
		expect(overlay.requestedRoles).toContain("default");
		expect(overlay.requestedRoles).toContain("executor");
		expect(overlay.requestedSelectors).toContain(`${current.provider}/${current.id}:medium`);
		expect(overlay.requestedSelectors).toContain(`${role.provider}/${role.id}:low`);
		expect(overlay.resolvedCanonicalIds).toContain(`${current.provider}/${current.id}`);
		expect(overlay.fallbackChain).toEqual([]);
		expect(overlay.activeIndex).toBeNull();
		expect(Object.isFrozen(overlay)).toBe(true);
		expect(Object.isFrozen(overlay.requestedSelectors)).toBe(true);
		expect(Object.isFrozen(overlay.fallbackChain)).toBe(true);
	});
	test("redacts hostile configured selectors and never invents usability or fallback facts", async () => {
		const current = model("openai", "gpt-4o-mini");
		const role = model("anthropic", "claude-sonnet-4-5");
		const result = await createFixture(current, role);
		result.session.settings.setModelRole("default", "openai/gpt-4o-mini?api_key=SECRET");
		result.session.setConfiguredModelChain("default", [], "test");
		const overlay = overlayOf(result);

		expect(overlay.requestedSelectors).toContain("<redacted-selector>");
		expect(JSON.stringify(overlay)).not.toContain("SECRET");
		expect(overlay.usability).toBeUndefined();
		expect(overlay.fallbackChain).toEqual([]);
		expect(overlay.activeIndex).toBeNull();
	});

	test("keeps two session overlays isolated while sharing catalog facts", async () => {
		const firstModel = model("openai", "gpt-4o-mini");
		const secondModel = model("anthropic", "claude-sonnet-4-5");
		const first = await createFixture(firstModel, secondModel);
		const second = await createFixture(secondModel, firstModel);
		const firstOverlay = overlayOf(first);
		const secondOverlay = overlayOf(second);
		const firstCatalog = catalogOf(first);
		const secondCatalog = catalogOf(second);

		expect(firstOverlay.sessionId).not.toBe(secondOverlay.sessionId);
		expect(firstOverlay.sessionId).toBe(first.session.sessionId);
		expect(secondOverlay.sessionId).toBe(second.session.sessionId);
		expect(firstOverlay.catalogRecordId).toBe(`${firstModel.provider}/${firstModel.id}`);
		expect(secondOverlay.catalogRecordId).toBe(`${secondModel.provider}/${secondModel.id}`);
		expect(firstCatalog.records).toEqual(secondCatalog.records);
		expect(overlayOf(first).sessionId).toBe(first.session.sessionId);
		expect(overlayOf(first).catalogRecordId).toBe(`${firstModel.provider}/${firstModel.id}`);
	});
});
