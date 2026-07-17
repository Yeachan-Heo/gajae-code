import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SelectList } from "@gajae-code/tui/components/select-list";
import { SettingsList } from "@gajae-code/tui/components/settings-list";
import {
	setKeybindings,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@gajae-code/tui/keybindings";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { inspectConfigFile } from "../src/cli/config-cli";
import { parseNotifyArgs } from "../src/cli/notify-cli";
import { KeybindingsManager } from "../src/config/keybindings";
import { resetSettingsForTest } from "../src/config/settings";
import { SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { addApiCompatibleProvider } from "../src/setup/provider-onboarding";

let root = "";
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const theme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};
const selectTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		hrChar: "-",
		quoteBorder: "|",
		boxRound: {},
		boxSharp: {},
		table: {},
		spinnerFrames: ["|"],
	},
} as never;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ux-adversarial-"));
	setAgentDir(path.join(root, "agent"));
	resetSettingsForTest();
	setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
});

afterEach(async () => {
	resetSettingsForTest();
	setAgentDir(fallbackAgentDir);
	await fs.rm(root, { recursive: true, force: true });
});

describe("UX change-set adversarial probes", () => {
	it("rejects swallowed setup values and leaves optional Slack authorization unset", () => {
		expect(parseNotifyArgs(["notify", "setup", "slack", "--slack-bot-token", "--redact"])).toBeUndefined();
		expect(
			parseNotifyArgs([
				"notify",
				"setup",
				"slack",
				"--slack-bot-token",
				"b",
				"--slack-app-token",
				"a",
				"--slack-workspace-id",
				"w",
				"--slack-channel-id",
				"c",
			])?.slackAuthorizedUserId,
		).toBeUndefined();
	});

	it("does not write malformed keybindings and preserves backup through a resumed migration", async () => {
		const file = path.join(root, "keybindings.json");
		await fs.writeFile(file, "{ broken");
		KeybindingsManager.create(root);
		expect(await fs.readFile(file, "utf8")).toBe("{ broken");
		expect(await Bun.file(`${file}.bak`).exists()).toBe(false);

		const legacy = '{"interrupt":"escape"}\n';
		await fs.writeFile(file, legacy);
		KeybindingsManager.create(root);
		await fs.rm(`${file}.migration-v1`);
		KeybindingsManager.create(root);
		expect(await fs.readFile(`${file}.bak`, "utf8")).toBe(legacy);
	});

	it("stores a literal key in canonical AuthStorage with a custom models path", async () => {
		const modelsPath = path.join(root, "custom", "models.yml");
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "qa-provider",
			baseUrl: "https://api.example.test/v1",
			apiKey: "literal-secret",
			models: ["m"],
			modelsPath,
		});
		expect(await Bun.file(modelsPath).text()).not.toContain("literal-secret");
		const store = await SqliteAuthCredentialStore.open(path.join(root, "agent", "agent.db"));
		try {
			expect(store.listAuthCredentials("qa-provider")[0]?.credential).toEqual({
				type: "api_key",
				key: "literal-secret",
			});
		} finally {
			store.close();
		}
	});

	it("renders a 30-column settings list and refuses absent or disabled selections", () => {
		const settingsList = new SettingsList(
			[{ id: "x", label: "a setting label wider than narrow terminals", currentValue: "a long value" }],
			5,
			theme,
			() => {},
			() => {},
		);
		expect(() => settingsList.render(30)).not.toThrow();
		const selectList = new SelectList([{ value: "disabled", label: "disabled", disabled: true }], 5, selectTheme);
		selectList.setSelectedIndex(99);
		selectList.handleInput("\n");
		expect(selectList.getSelectedItem()).toBeNull();
	});

	it("reports unknown and redacts secret-shaped invalid values", async () => {
		const configPath = path.join(root, "doctor.yml");
		await fs.writeFile(configPath, "typoed: true\nnotifications:\n  telegram:\n    botToken: [super-secret]\n");
		const report = await inspectConfigFile(configPath);
		expect(report.unknownKeys).toEqual(["typoed"]);
		expect(report.invalidValues).toContainEqual({ path: "notifications.telegram.botToken", value: "<redacted>" });
	});

	it("returns exit 1 for an unknown notify action after command parsing", () => {
		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
		const result = Bun.spawnSync(["bun", cliEntry, "notify", "unknown-action"], {
			cwd: repoRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Unknown notify action: unknown-action");
	});

	it("reports a string stored for a numeric setting without custom validation", async () => {
		const configPath = path.join(root, "doctor.yml");
		await fs.writeFile(configPath, "compaction:\n  idleThresholdTokens: not-a-number\n");
		const report = await inspectConfigFile(configPath);
		expect(report.invalidValues).toContainEqual({ path: "compaction.idleThresholdTokens", value: "not-a-number" });
	});
});
