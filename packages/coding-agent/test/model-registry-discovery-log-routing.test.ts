import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { hookFetch, logger, Snowflake } from "@gajae-code/utils";

/**
 * These tests drive the real configured-discovery logging callsite. They stay separate
 * from the large registry suite so transport-routing failures have an independent budget.
 */
describe("model discovery failure log routing", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let previousPresetRegistryDisabled: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		previousPresetRegistryDisabled = Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = "true";
		tempDir = path.join(os.tmpdir(), `pi-test-discovery-routing-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (previousPresetRegistryDisabled === undefined) delete Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED;
		else Bun.env.GJC_MODEL_PRESET_REGISTRY_DISABLED = previousPresetRegistryDisabled;
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	async function refreshWithDiscoveryFailure(
		baseUrl: string,
		code: string,
	): Promise<{ warned: string[]; debugged: string[] }> {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					ollama: { baseUrl, api: "openai-completions", auth: "none", discovery: { type: "ollama" } },
				},
			}),
		);
		using _hook = hookFetch(() => {
			throw Object.assign(new Error(`transport failure: ${code}`), { code });
		});
		const warned: string[] = [];
		const debugged: string[] = [];
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(message => {
			if (message === "model discovery failed for provider") warned.push(message);
		});
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(message => {
			if (message === "model discovery failed for provider") debugged.push(message);
		});
		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refreshProvider("ollama", "online");
		} finally {
			warnSpy.mockRestore();
			debugSpy.mockRestore();
		}
		return { warned, debugged };
	}

	test("demotes a proven-refused loopback endpoint to debug", async () => {
		const { warned, debugged } = await refreshWithDiscoveryFailure("http://127.0.0.1:11434/v1", "ECONNREFUSED");
		expect(debugged.length).toBeGreaterThanOrEqual(1);
		expect(warned).toEqual([]);
	});

	for (const code of ["ENOTFOUND", "EHOSTUNREACH"] as const) {
		test(`keeps loopback ${code} failures at warn`, async () => {
			const { warned, debugged } = await refreshWithDiscoveryFailure("http://127.0.0.1:11434/v1", code);
			expect(warned.length).toBeGreaterThanOrEqual(1);
			expect(debugged).toEqual([]);
		});
	}

	test("keeps a refused remote endpoint at warn", async () => {
		const { warned, debugged } = await refreshWithDiscoveryFailure("https://ollama.example.com/v1", "ECONNREFUSED");
		expect(warned.length).toBeGreaterThanOrEqual(1);
		expect(debugged).toEqual([]);
	});
});
