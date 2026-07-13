import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initializeExtensions } from "../src/modes/runtime-init";
import { createAgentSession } from "../src/sdk";
import { createNotificationsExtension } from "../src/sdk/bus";
import { SdkClient } from "../src/sdk/client";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

let tempDir: string | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	delete process.env.GJC_NOTIFICATIONS;
	resetSettingsForTest();
	authStorage?.close();
	authStorage = undefined;
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

test("model.set atomically promotes an explicit thinking level for the active and future sessions", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-default-model-"));
	const agentDir = path.join(tempDir, "agent");
	authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	modelRegistry.registerProvider("runtime-provider", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		models: [
			{
				id: "initial-model",
				name: "Initial Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
			{
				id: "reasoning-model",
				name: "Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
				thinking: {
					minLevel: Effort.Minimal,
					maxLevel: Effort.High,
					mode: "effort",
					defaultLevel: Effort.Low,
				},
			},
		],
	});
	const settings = await Settings.init({ cwd: tempDir, agentDir });
	const initialModel = modelRegistry.find("runtime-provider", "initial-model");
	if (!initialModel) throw new Error("Expected initial model fixture");

	process.env.GJC_NOTIFICATIONS = "1";
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		model: initialModel,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		extensions: [api => createNotificationsExtension(api, { settings })],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });

	const endpointFile = path.join(tempDir, ".gjc", "state", "sdk", `${session.sessionId}.json`);
	const deadline = Date.now() + 4_000;
	while (!(await Bun.file(endpointFile).exists())) {
		if (Date.now() > deadline) throw new Error("Timed out starting SDK host");
		await Bun.sleep(10);
	}
	const endpoint = (await Bun.file(endpointFile).json()) as { url: string; token: string };
	const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 4_000, reconnectAttempts: 0 });

	try {
		type SdkModelCatalogItem = {
			provider: string;
			id: string;
			name: string;
			contextWindow: number;
			maxTokens: number;
			reasoning: boolean;
			thinking?: {
				minLevel: Effort;
				maxLevel: Effort;
				levels?: Effort[];
				defaultLevel?: Effort;
				mode: string;
			};
		};
		const modelsFrame = (await client.query("models.list/current")) as {
			page?: { items?: SdkModelCatalogItem[] };
		};
		const catalog = modelsFrame.page?.items ?? [];
		expect(catalog.find(model => model.id === "initial-model")).toMatchObject({
			provider: "runtime-provider",
			id: "initial-model",
			name: "Initial Model",
			contextWindow: 128_000,
			maxTokens: 8_192,
			reasoning: false,
		});
		expect(catalog.find(model => model.id === "reasoning-model")).toMatchObject({
			provider: "runtime-provider",
			id: "reasoning-model",
			name: "Reasoning Model",
			contextWindow: 128_000,
			maxTokens: 8_192,
			reasoning: true,
			thinking: {
				minLevel: Effort.Minimal,
				maxLevel: Effort.High,
				defaultLevel: Effort.Low,
				mode: "effort",
			},
		});
		await expect(
			client.control("model.set", {
				id: "runtime-provider/initial-model",
			}),
		).resolves.toMatchObject({ ok: true, result: { changed: true } });
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "runtime-provider/initial-model",
		});

		await expect(
			client.control("model.set", {
				id: "runtime-provider/reasoning-model",
				thinkingLevel: "inherit",
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(session.model?.id).toBe("initial-model");
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "runtime-provider/initial-model",
		});

		await expect(
			client.control("model.set", {
				id: "runtime-provider/reasoning-model",
				thinkingLevel: "high",
			}),
		).resolves.toMatchObject({
			ok: true,
			result: { provider: "runtime-provider", modelId: "reasoning-model", thinkingLevel: "high" },
		});
		expect(session.model?.id).toBe("reasoning-model");
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "runtime-provider/reasoning-model:high",
		});
	} finally {
		client.close();
		await session.extensionRunner?.emit({ type: "session_shutdown" });
		await session.dispose();
	}

	const { session: freshSession } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		sessionManager: SessionManager.inMemory(tempDir),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	try {
		expect(freshSession.model?.id).toBe("reasoning-model");
		expect(freshSession.thinkingLevel).toBe(Effort.High);
	} finally {
		await freshSession.dispose();
	}
});
