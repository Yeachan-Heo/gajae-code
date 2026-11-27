/**
 * Devin provider surface (coding-agent side).
 *
 * Proves the user-visible path: once `devin acp` is on PATH, Devin models are
 * discovered through the ordinary provider/model selection path and are
 * credentialless — GJC never asks for a Devin API key, because authentication
 * belongs to the CLI (`devin auth login`).
 *
 * `test/fixtures/devin` is a stand-in executable that speaks ACP v1 over stdio
 * using the same fixture the ai package tests use. Devin CLI itself is not
 * installable here, so no live Devin traffic is claimed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { kNoAuth, ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { Snowflake } from "@gajae-code/utils";

const DEVIN_STANDIN_DIR = path.resolve(import.meta.dir, "fixtures");
const WINDOWS_SKIP = "the Devin CLI stand-in is a POSIX shebang executable";

describe("devin provider surface", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `gjc-test-devin-surface-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }));
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function setEnvForTest(key: string, value: string): () => void {
		const previous = Bun.env[key];
		Bun.env[key] = value;
		return () => {
			if (previous === undefined) delete Bun.env[key];
			else Bun.env[key] = previous;
		};
	}

	function unsetEnvForTest(key: string): () => void {
		const previous = Bun.env[key];
		delete Bun.env[key];
		return () => {
			if (previous !== undefined) Bun.env[key] = previous;
		};
	}

	test.skipIf(process.platform === "win32")(
		`discovers Devin models as a credentialless provider (${WINDOWS_SKIP})`,
		async () => {
			const restorePath = setEnvForTest("PATH", `${DEVIN_STANDIN_DIR}${path.delimiter}${Bun.env.PATH ?? ""}`);
			const restorePresetRegistry = setEnvForTest("GJC_MODEL_PRESET_REGISTRY_DISABLED", "true");
			const restoreCliPath = unsetEnvForTest("GJC_DEVIN_CLI_PATH");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("devin", "online");

				const models = registry.getAll().filter(model => model.provider === "devin");
				expect(models.map(model => model.id).sort()).toEqual(["adaptive", "opus", "sonnet"]);
				expect(models.every(model => model.api === "devin-acp")).toBe(true);
				expect(registry.getActiveProviders().filter(entry => entry.provider === "devin")).toEqual([
					{ provider: "devin", connectionKind: "credentialless" },
				]);
				expect(await registry.getApiKey(models[0])).toBe(kNoAuth);
				expect(registry.getAvailable().map(model => model.id)).toContain("adaptive");
			} finally {
				restoreCliPath();
				restorePresetRegistry();
				restorePath();
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		`treats Devin as credentialless before any discovery sweep (${WINDOWS_SKIP})`,
		async () => {
			const restorePath = setEnvForTest("PATH", `${DEVIN_STANDIN_DIR}${path.delimiter}${Bun.env.PATH ?? ""}`);
			const restorePresetRegistry = setEnvForTest("GJC_MODEL_PRESET_REGISTRY_DISABLED", "true");
			const restoreCliPath = unsetEnvForTest("GJC_DEVIN_CLI_PATH");
			try {
				const parent = new ModelRegistry(authStorage, modelsJsonPath);
				await parent.refreshProvider("devin", "online");
				const model = parent.getAll().find(candidate => candidate.provider === "devin");
				expect(model).toBeDefined();

				// A registry that never runs the discovery sweep (a subagent's own
				// registry, an offline refresh) must not demand a Devin API key.
				const child = new ModelRegistry(authStorage, modelsJsonPath);
				expect(await child.getApiKey(model!)).toBe(kNoAuth);
				await child.refresh("offline");
				expect(await child.getApiKey(model!)).toBe(kNoAuth);
			} finally {
				restoreCliPath();
				restorePresetRegistry();
				restorePath();
			}
		},
	);

	test("keeps the models.yml auth mode for a configured Devin provider", async () => {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					devin: {
						api: "devin-acp",
						baseUrl: "acp://devin-cli",
						apiKeyEnv: "GJC_TEST_DEVIN_UNSET_KEY",
						models: [{ id: "adaptive", name: "Adaptive" }],
					},
				},
			}),
		);
		const restoreKey = unsetEnvForTest("GJC_TEST_DEVIN_UNSET_KEY");
		try {
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.getAll().find(candidate => candidate.provider === "devin");
			expect(model).toBeDefined();
			expect(await registry.getApiKey(model!)).toBeUndefined();
		} finally {
			restoreKey();
		}
	});

	test.skipIf(process.platform === "win32")(
		`discovers no Devin models when the CLI is missing (${WINDOWS_SKIP})`,
		async () => {
			const missing = path.join(tempDir, "missing-devin");
			const restoreCliPath = setEnvForTest("GJC_DEVIN_CLI_PATH", missing);
			const restorePresetRegistry = setEnvForTest("GJC_MODEL_PRESET_REGISTRY_DISABLED", "true");
			try {
				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				await registry.refreshProvider("devin", "online");
				expect(registry.getAll().filter(model => model.provider === "devin")).toEqual([]);
			} finally {
				restorePresetRegistry();
				restoreCliPath();
			}
		},
	);
});
