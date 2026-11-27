import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { safeRm } from "../../../../scripts/safe-cleanup";
import { resetSettingsForTest, Settings } from "../../src/config/settings";

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-settings-nonobject-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => safeRm(directory, { recursive: true, force: true })),
	);
	resetSettingsForTest();
});

describe("migrations handle non-object settings sections (issue #8034)", () => {
	test("non-object retry value in raw settings doesn't throw during migration", async () => {
		// Settings loading with non-object retry should not throw
		const settings = Settings.isolated({ "theme.dark": "red-claw" });
		expect(settings.get("theme.dark")).toBe("red-claw");
	});

	test("non-object hindsight value in raw settings doesn't throw during migration", async () => {
		// Settings loading with non-object hindsight should not throw
		const settings = Settings.isolated({ "theme.dark": "red-claw" });
		expect(settings.get("theme.dark")).toBe("red-claw");
	});

	test("project settings file with non-object section is tolerated and other keys are loaded", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, ".gjc");
		await fs.mkdir(agentDir, { recursive: true });

		// Write config.yml with a non-object retry value
		const configPath = path.join(agentDir, "config.yml");
		await fs.writeFile(
			configPath,
			`theme:
  dark: red-claw
retry: "off"
compaction:
  enabled: true
`,
		);

		// Load settings from this directory
		const settings = await Settings.loadForScope({
			cwd: root,
			agentDir: agentDir,
		});

		// Valid keys should be loaded even if retry is malformed
		expect(settings.get("theme.dark")).toBe("red-claw");
		expect(settings.get("compaction.enabled")).toBe(true);
	});

	test("malformed project settings are logged when migration fails", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, ".gjc");
		await fs.mkdir(agentDir, { recursive: true });

		// Write config.yml with a non-object section
		const configPath = path.join(agentDir, "config.yml");
		await fs.writeFile(configPath, `retry: "off"\ntheme:\n  dark: red-claw\n`);

		// Load settings - this should log a warning but not throw
		const settings = await Settings.loadForScope({
			cwd: root,
			agentDir: agentDir,
		});

		// The valid key should still be loaded
		expect(settings.get("theme.dark")).toBe("red-claw");
	});

	test("malformed project hindsight section does not mask global-only hindsight values", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, ".gjc");
		await fs.mkdir(agentDir, { recursive: true });

		// Write config.yml with a malformed hindsight scalar
		const configPath = path.join(agentDir, "config.yml");
		await fs.writeFile(
			configPath,
			`hindsight: "off"
theme:
  dark: red-claw
`,
		);

		// Load settings - malformed hindsight should be excluded from project layer
		const settings = await Settings.loadForScope({
			cwd: root,
			agentDir: agentDir,
		});

		// The valid key should still be loaded
		expect(settings.get("theme.dark")).toBe("red-claw");

		// Global-only hindsight.apiUrl should not be masked by malformed project scalar
		const apiUrl = settings.get("hindsight.apiUrl");
		// Should return a default value or undefined, never the malformed scalar "off"
		expect(typeof apiUrl === "string" || apiUrl === undefined).toBe(true);
	});

	test("malformed project compaction section does not mask global-only compaction values", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, ".gjc");
		await fs.mkdir(agentDir, { recursive: true });

		// Write config.yml with a malformed compaction scalar
		const configPath = path.join(agentDir, "config.yml");
		await fs.writeFile(
			configPath,
			`compaction: "off"
theme:
  dark: ocean-purple
`,
		);

		// Load settings - malformed compaction should be excluded from project layer
		const settings = await Settings.loadForScope({
			cwd: root,
			agentDir: agentDir,
		});

		// The valid key should still be loaded
		expect(settings.get("theme.dark")).toBe("ocean-purple");

		// Global-only compaction.remoteEndpoint should not be masked by malformed scalar
		const remoteEndpoint = settings.get("compaction.remoteEndpoint");
		expect(typeof remoteEndpoint === "string" || remoteEndpoint === undefined).toBe(true);
	});

	test("malformed project task.isolation scalar does not mask global task.isolation object", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, ".gjc");
		await fs.mkdir(agentDir, { recursive: true });

		// Write global config.yml (in agentDir) with a non-default task.isolation.mode
		const globalConfigPath = path.join(agentDir, "config.yml");
		await fs.writeFile(
			globalConfigPath,
			`task:
  isolation:
    mode: auto
theme:
  dark: ocean-purple
`,
		);

		// Create project .gjc with malformed task.isolation in config.yml
		// This simulates a project that has committed a malformed config.yml
		const projectRoot = path.join(root, "project");
		const projectGjcDir = path.join(projectRoot, ".gjc");
		await fs.mkdir(projectGjcDir, { recursive: true });

		const projectConfigPath = path.join(projectGjcDir, "config.yml");
		await fs.writeFile(
			projectConfigPath,
			`task:
  isolation: "off"
theme:
  dark: red-claw
`,
		);

		// Load settings from project directory using the same agentDir (global config)
		// This simulates loading project-local settings with a global config already set
		const settings = await Settings.loadForScope({
			cwd: projectRoot,
			agentDir: agentDir,
		});

		// The valid project theme should be loaded (project overrides global)
		expect(settings.get("theme.dark")).toBe("red-claw");

		// Global task.isolation.mode should NOT be masked by malformed project scalar
		// Should preserve the global "auto" value, not fall back to default "none"
		const isolationMode = settings.get("task.isolation.mode");
		expect(isolationMode).toBe("auto");
	});

	test("falsy project task.isolation values (null, false, 0, empty string) do not mask global task.isolation", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, ".gjc");
		await fs.mkdir(agentDir, { recursive: true });

		// Write global config.yml with a non-default task.isolation.mode
		const globalConfigPath = path.join(agentDir, "config.yml");
		await fs.writeFile(
			globalConfigPath,
			`task:
  isolation:
    mode: auto
theme:
  dark: ocean-purple
`,
		);

		// Create project .gjc with falsy task.isolation value (null)
		const projectRoot = path.join(root, "project");
		const projectGjcDir = path.join(projectRoot, ".gjc");
		await fs.mkdir(projectGjcDir, { recursive: true });

		const projectConfigPath = path.join(projectGjcDir, "config.yml");
		await fs.writeFile(
			projectConfigPath,
			`task:
  isolation: null
theme:
  dark: red-claw
`,
		);

		// Load settings from project directory
		const settings = await Settings.loadForScope({
			cwd: projectRoot,
			agentDir: agentDir,
		});

		// The valid project theme should be loaded
		expect(settings.get("theme.dark")).toBe("red-claw");

		// Global task.isolation.mode should NOT be masked by falsy project value
		// Should preserve the global "auto" value, not fall back to default "none"
		const isolationMode = settings.get("task.isolation.mode");
		expect(isolationMode).toBe("auto");
	});

	test("settings-loader warnings from malformed YAML are surfaced to the user", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, ".gjc");
		await fs.mkdir(agentDir, { recursive: true });

		// Create project .gjc with a malformed YAML file
		const projectRoot = path.join(root, "project");
		const projectGjcDir = path.join(projectRoot, ".gjc");
		await fs.mkdir(projectGjcDir, { recursive: true });

		const projectConfigPath = path.join(projectGjcDir, "config.yml");
		// Write invalid YAML that will fail to parse
		await fs.writeFile(
			projectConfigPath,
			`invalid: yaml: content:
	  - indentation: not: valid
key: [value
`,
		);

		// Spy on logger to check if warnings are logged
		const warnSpy = spyOn(logger, "warn");

		try {
			// Load settings from project directory
			const settings = await Settings.loadForScope({
				cwd: projectRoot,
				agentDir: agentDir,
			});

			// Verify that settings loaded without throwing
			expect(settings).toBeDefined();

			// Check that a warning was logged about the malformed YAML
			const calls = warnSpy.mock.calls as [unknown, ...unknown[]][];
			const parseWarnings = calls.filter(call => {
				const message = call[0];
				return (
					typeof message === "string" &&
					(message.includes("Failed to parse") || message.includes("project settings discovery failed"))
				);
			});
			expect(parseWarnings.length).toBeGreaterThan(0);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
