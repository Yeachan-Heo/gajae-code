import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import type { ModelRegistry, ProviderDiscoveryState } from "@gajae-code/coding-agent/config/model-registry";
import { ModelRegistry as ModelRegistryImpl } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";
import { hookFetch, Snowflake } from "@gajae-code/utils";

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for issue-970 selector test");
	}
	setThemeInstance(testTheme);
}

async function createSelector(state: ProviderDiscoveryState): Promise<ModelSelectorComponent> {
	const modelRegistry = {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => [],
		getAll: () => [],
		hasConfiguredProviderAuth: () => false,
		getDiscoverableProviders: () => [state.provider],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getProviderDiscoveryState: () => state,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const selector = new ModelSelectorComponent(
		ui,
		undefined,
		Settings.isolated({}),
		modelRegistry,
		[],
		() => {},
		() => {},
	);
	await Bun.sleep(0);
	installTestTheme();
	selector.handleInput("\x1b[C");
	selector.handleInput("\x1b[C");
	await Bun.sleep(0);
	return selector;
}

describe("issue #970 custom provider discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		testTheme = await getThemeByName("red-claw");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for issue-970 selector test");
		}
	});

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-970-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("preserves same-id YAML fields and discovered-only model overrides", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  vllm:",
				"    baseUrl: http://192.168.5.3:8085/v1",
				"    apiKey: sk-1234",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
				"    models:",
				"      - id: qwen3.6",
				"        name: Qwen3.6",
				"        contextWindow: 128000",
				"        maxTokens: 8192",
				"    modelOverrides:",
				"      issue-3954-override-context:",
				"        contextWindow: 64000",
				"      issue-3954-override-max:",
				"        maxTokens: 4096",
			].join("\n"),
		);

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBe("Bearer sk-1234");
			return new Response(
				JSON.stringify({
					data: [
						{ id: "qwen3.6", context_length: 256000 },
						{ id: "issue-3954-override-context", context_length: 512000 },
						{ id: "issue-3954-override-max", context_length: 384000 },
						{ id: "issue-3954-uncatalogued" },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		const registry = new ModelRegistryImpl(authStorage, modelsPath);
		await registry.refreshProvider("vllm");

		const providerModels = registry.getAll().filter(model => model.provider === "vllm");
		expect(providerModels.map(model => model.id).sort()).toEqual([
			"issue-3954-override-context",
			"issue-3954-override-max",
			"issue-3954-uncatalogued",
			"qwen3.6",
		]);
		expect(registry.getProviderDiscoveryState("vllm")?.status).toBe("ok");

		const qwen = registry.find("vllm", "qwen3.6");
		expect(qwen?.api).toBe("openai-completions");
		expect(qwen?.provider).toBe("vllm");
		expect(qwen?.name).toBe("Qwen3.6");
		expect(qwen?.contextWindow).toBe(128000);
		expect(qwen?.maxTokens).toBe(8192);

		const contextOverride = registry.find("vllm", "issue-3954-override-context");
		expect(contextOverride?.contextWindow).toBe(64000);
		expect(contextOverride?.maxTokens).toBe(UNK_MAX_TOKENS);

		const maxTokensOverride = registry.find("vllm", "issue-3954-override-max");
		expect(maxTokensOverride?.contextWindow).toBe(384000);
		expect(maxTokensOverride?.maxTokens).toBe(4096);

		const uncatalogued = registry.find("vllm", "issue-3954-uncatalogued");
		expect(uncatalogued?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(uncatalogued?.maxTokens).toBe(UNK_MAX_TOKENS);
	});

	test("shows a provider-tab hint when discovery succeeds but returns zero models", async () => {
		installTestTheme();
		const selector = await createSelector({
			provider: "vllm",
			status: "empty",
			optional: false,
			stale: false,
			fetchedAt: Date.now(),
			models: [],
		});

		const rendered = normalizeRenderedText(selector.render(200).join("\n"));
		expect(rendered).toContain("Discovery succeeded but returned 0 models");
		expect(rendered).toContain("/models returns { data: [{ id }] }");
	});

	test("shows a provider-tab hint when the discovery endpoint returns 404", async () => {
		installTestTheme();
		const selector = await createSelector({
			provider: "vllm",
			status: "unavailable",
			optional: false,
			stale: false,
			fetchedAt: Date.now(),
			models: [],
			error: "HTTP 404 from http://192.168.5.3:8085/v1/models",
		});

		const rendered = normalizeRenderedText(selector.render(200).join("\n"));
		expect(rendered).toContain("http://192.168.5.3:8085/v1/models returned 404");
		expect(rendered).toContain("baseUrl");
	});
});
