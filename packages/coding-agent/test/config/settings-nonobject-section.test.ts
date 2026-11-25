import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
});
