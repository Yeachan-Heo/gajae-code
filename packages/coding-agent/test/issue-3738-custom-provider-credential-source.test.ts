import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelsConfigFile } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { Snowflake } from "@gajae-code/utils";

function loadModelsConfig(modelsPath: string, yaml: string) {
	fs.writeFileSync(modelsPath, yaml);
	return ModelsConfigFile.relocate(modelsPath).tryLoad();
}

describe("issue #3738 custom provider credential-source validation", () => {
	let tempDir: string;
	let modelsPath: string;

	beforeEach(() => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `gjc-test-issue-3738-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
	});

	afterEach(() => {
		resetSettingsForTest();
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	test("missing credential source names the three corrective forms instead of restating the rule", () => {
		const result = loadModelsConfig(
			modelsPath,
			[
				"providers:",
				"  tokenrouter:",
				"    baseUrl: https://example.invalid/v1",
				"    api: openai-completions",
				"    auth: apiKey",
				"    models:",
				"      - id: example",
				"",
			].join("\n"),
		);

		expect(result.status).toBe("error");
		const message = String(result.error);
		expect(message).toContain("Provider tokenrouter: custom models need a credential source");
		// The reporter's confusion in #3738: `auth: apiKey` reads like it supplies the key.
		expect(message).toContain('"auth" only selects the scheme');
		expect(message).toContain('"apiKeyEnv: <ENV_VAR>"');
		expect(message).toContain('"apiKey: <literal-key>"');
		expect(message).toContain('"auth: none"');
	});

	test("apiKeyEnv, literal apiKey, and auth: none each satisfy the credential requirement", () => {
		const base = ["    baseUrl: https://example.invalid/v1", "    api: openai-completions"];
		const cases: string[][] = [
			[...base, "    auth: apiKey", "    apiKeyEnv: TOKENROUTER_API_KEY"],
			[...base, "    auth: apiKey", "    apiKey: literal-key"],
			[...base, "    auth: none"],
		];

		for (const providerLines of cases) {
			const result = loadModelsConfig(
				modelsPath,
				["providers:", "  tokenrouter:", ...providerLines, "    models:", "      - id: example", ""].join("\n"),
			);

			expect(result.status).toBe("ok");
			expect(result.value?.providers?.tokenrouter?.models?.[0]?.id).toBe("example");
		}
	});
});
