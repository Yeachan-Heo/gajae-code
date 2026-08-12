import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import { runAgenticCommit } from "../src/commit/agentic";
import { ModelRegistry } from "../src/config/model-registry";
import { RetiredImageSecretGateError, type RetiredImageSecretSource } from "../src/config/retired-image-secret-gate";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<{ root: string; cwd: string; agentDir: string; dbPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-image-secret-order-"));
	tempDirs.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { root, cwd, agentDir, dbPath: getAgentDbPath(agentDir) };
}

async function expectBlocked(
	action: Promise<unknown>,
	source: RetiredImageSecretSource,
	secret = "project-order-secret",
): Promise<void> {
	let caught: unknown;
	try {
		await action;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RetiredImageSecretGateError);
	if (!(caught instanceof RetiredImageSecretGateError)) return;
	expect(caught.source).toBe(source);
	expect(caught.message).not.toContain(secret);
}

afterEach(async () => {
	for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("retired image credential gate ordering", () => {
	it("blocks before project settings discovery or storage/session materialization", async () => {
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		const projectConfigPath = path.join(cwd, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			projectConfigPath,
			[
				"providers:",
				"  image: custom",
				"  imageCustomUrl: https://images.example.invalid/v1",
				"  imageCredentialReference: project-order-secret",
				"",
			].join("\n"),
		);

		await expectBlocked(Settings.loadForScope({ cwd, agentDir }), "project-config");
		expect(await fs.stat(projectConfigPath)).toBeTruthy();
		expect(await Bun.file(dbPath).exists()).toBe(false);
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(false);
		expect(await Bun.file(path.join(agentDir, "data", "agent.db")).exists()).toBe(false);
	});

	it("runs the gate before createAgentSession touches the supplied session manager", async () => {
		const { root, cwd, agentDir } = await makeWorkspace();
		const projectConfigPath = path.join(cwd, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			projectConfigPath,
			["providers:", "  image: custom", "  imageCredentialReference: session-order-secret", ""].join("\n"),
		);
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const sessionManager = SessionManager.inMemory(cwd);
		const getSessionId = vi.spyOn(sessionManager, "getSessionId");
		const settingsInit = vi
			.spyOn(Settings, "init")
			.mockImplementation(options =>
				Settings.loadForScope({ cwd: options?.cwd ?? cwd, agentDir: options?.agentDir ?? agentDir }),
			);
		try {
			await expectBlocked(
				createAgentSession({
					cwd,
					agentDir,
					modelRegistry,
					authStorage,
					sessionManager,
					disableExtensionDiscovery: true,
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				}),
				"project-config",
				"session-order-secret",
			);
			expect(getSessionId).not.toHaveBeenCalled();
		} finally {
			settingsInit.mockRestore();
			getSessionId.mockRestore();
			try {
				await sessionManager.close();
			} finally {
				authStorage.close();
			}
		}
	});
	it("gates default createAgentSession before local auth DB, broker, or model bootstrap", async () => {
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		const projectConfigPath = path.join(cwd, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			projectConfigPath,
			["providers:", "  image: custom", "  imageCredentialReference: default-order-secret", ""].join("\n"),
		);
		const originalBrokerUrl = Bun.env.GJC_AUTH_BROKER_URL;
		const originalBrokerToken = Bun.env.GJC_AUTH_BROKER_TOKEN;
		const originalFetch = global.fetch;
		const authStorageCreate = vi.spyOn(AuthStorage, "create");
		const modelRefresh = vi.spyOn(ModelRegistry.prototype, "refreshInBackground");

		const fetchMock: typeof fetch = vi.fn(async () => {
			throw new Error("broker bootstrap reached");
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;
		Bun.env.GJC_AUTH_BROKER_URL = "https://broker.example.invalid";
		Bun.env.GJC_AUTH_BROKER_TOKEN = "broker-test-token";
		try {
			await expectBlocked(
				createAgentSession({ cwd, agentDir, disableExtensionDiscovery: true }),
				"project-config",
				"default-order-secret",
			);
			expect(await Bun.file(dbPath).exists()).toBe(false);
			expect(authStorageCreate).not.toHaveBeenCalled();
			expect(modelRefresh).not.toHaveBeenCalled();

			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			authStorageCreate.mockRestore();
			modelRefresh.mockRestore();
			global.fetch = originalFetch;
			if (originalBrokerUrl === undefined) delete Bun.env.GJC_AUTH_BROKER_URL;
			else Bun.env.GJC_AUTH_BROKER_URL = originalBrokerUrl;
			if (originalBrokerToken === undefined) delete Bun.env.GJC_AUTH_BROKER_TOKEN;
			else Bun.env.GJC_AUTH_BROKER_TOKEN = originalBrokerToken;
		}
	});

	it("gates the agentic commit entry before auth storage, broker, or DB bootstrap", async () => {
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		const projectConfigPath = path.join(cwd, ".gjc", "config.yml");
		await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
		await fs.writeFile(
			projectConfigPath,
			["providers:", "  image: custom", "  imageCredentialReference: agentic-order-secret", ""].join("\n"),
		);

		const originalProjectDir = getProjectDir();
		const originalAgentDir = getAgentDir();
		const originalAgentDirOverride = Bun.env.GJC_CODING_AGENT_DIR;
		const originalBrokerUrl = Bun.env.GJC_AUTH_BROKER_URL;
		const originalBrokerToken = Bun.env.GJC_AUTH_BROKER_TOKEN;
		const originalFetch = global.fetch;
		const authStorageCreate = vi.spyOn(AuthStorage, "create");
		const modelRefresh = vi.spyOn(ModelRegistry.prototype, "refresh");
		const fetchMock: typeof fetch = vi.fn(async () => {
			throw new Error("broker bootstrap reached");
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;

		resetSettingsForTest();
		setProjectDir(cwd);
		setAgentDir(agentDir);
		Bun.env.GJC_AUTH_BROKER_URL = "https://broker.example.invalid";
		Bun.env.GJC_AUTH_BROKER_TOKEN = "broker-test-token";
		global.fetch = fetchMock;
		try {
			await expectBlocked(
				runAgenticCommit({ push: false, dryRun: true, noChangelog: true }),
				"project-config",
				"agentic-order-secret",
			);
			expect(await Bun.file(dbPath).exists()).toBe(false);
			expect(authStorageCreate).not.toHaveBeenCalled();
			expect(modelRefresh).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			authStorageCreate.mockRestore();
			modelRefresh.mockRestore();
			global.fetch = originalFetch;
			if (originalBrokerUrl === undefined) delete Bun.env.GJC_AUTH_BROKER_URL;
			else Bun.env.GJC_AUTH_BROKER_URL = originalBrokerUrl;
			if (originalBrokerToken === undefined) delete Bun.env.GJC_AUTH_BROKER_TOKEN;
			else Bun.env.GJC_AUTH_BROKER_TOKEN = originalBrokerToken;
			resetSettingsForTest();
			setProjectDir(originalProjectDir);
			setAgentDir(originalAgentDir);
			if (originalAgentDirOverride === undefined) delete Bun.env.GJC_CODING_AGENT_DIR;
			else Bun.env.GJC_CODING_AGENT_DIR = originalAgentDirOverride;
		}
	});
	it("scrubs legacy settings before migration so retired values never reach new config.yml", async () => {
		expect(SETTINGS_SCHEMA).not.toHaveProperty("imageCustomKey");
		expect(SETTINGS_SCHEMA).not.toHaveProperty("imageCustomKeyEnv");
		expect(SETTINGS_SCHEMA).not.toHaveProperty("providers.imageCustomKey");
		expect(SETTINGS_SCHEMA).not.toHaveProperty("providers.imageCustomKeyEnv");
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		const secrets = ["json-order-secret", "json-order-env-secret", "db-order-secret", "db-order-env-secret"];
		const settingsJsonPath = path.join(agentDir, "settings.json");
		await fs.writeFile(
			settingsJsonPath,
			JSON.stringify(
				{
					imageCustomKey: secrets[0],
					imageCustomKeyEnv: secrets[1],
					keepFromJson: "json-safe",
				},
				null,
				2,
			) + "\n",
		);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const database = new Database(dbPath);
		database.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);");
		database.prepare("INSERT INTO settings (id, data) VALUES (1, ?)").run(
			JSON.stringify({
				providers: { imageCustomKey: secrets[2], imageCustomKeyEnv: secrets[3] },
				keepFromDb: "db-safe",
			}),
		);
		database.close();

		const settings = await Settings.loadForScope({ cwd, agentDir });
		try {
			const configPath = path.join(agentDir, "config.yml");
			const configText = await fs.readFile(configPath, "utf8");
			for (const secret of secrets) expect(configText).not.toContain(secret);
			for (const key of ["imageCustomKey", "imageCustomKeyEnv"]) expect(configText).not.toContain(key);
			expect(configText).toContain("keepFromJson");
			expect(configText).toContain("keepFromDb");

			const migratedBackup = path.join(agentDir, "settings.json.bak");
			expect(await Bun.file(migratedBackup).exists()).toBe(true);
			const backupText = await fs.readFile(migratedBackup, "utf8");
			for (const secret of secrets) expect(backupText).not.toContain(secret);
			for (const key of ["imageCustomKey", "imageCustomKeyEnv"]) expect(backupText).not.toContain(key);

			const reopened = new Database(dbPath, { readonly: true });
			try {
				const rows = reopened.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{
					key: string;
					value: string;
				}>;
				const serialized = JSON.stringify(rows);
				for (const secret of secrets) expect(serialized).not.toContain(secret);
				for (const key of ["imageCustomKey", "imageCustomKeyEnv"]) expect(serialized).not.toContain(key);
			} finally {
				reopened.close();
			}
		} finally {
			settings.getStorage()?.close();
		}
	});
});
