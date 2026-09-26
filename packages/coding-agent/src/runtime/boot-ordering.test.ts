import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledModel } from "@gajae-code/ai/core";
import { readDurableModelProfileOwnership } from "../config/model-profile-ownership";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { offBackend } from "../memory-backend/off-backend";
import type { MemoryBackend } from "../memory-backend/types";
import type { SttModeController } from "../modes/controllers/stt-controller";
import { ensureSttControllerForToggle } from "../modes/interactive-mode";
import { createAgentSession } from "../sdk/session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import type { LazyService } from "./lazy-service";
import { createLazyService } from "./lazy-service";
import { createOptionalRuntimeServices } from "./optional-runtime-services";

function markerMemoryService(markers: string[], startFailure?: Error): LazyService<MemoryBackend> {
	const service = createLazyService<MemoryBackend>({
		id: "memory.backend",
		initialize: async () => {
			markers.push("memory-backend-initialization");
			return {
				value: {
					...offBackend,
					async start() {
						markers.push("memory-backend-start");
						if (startFailure) throw startFailure;
					},
					async buildDeveloperInstructions() {
						markers.push("build-developer-instructions");
						return undefined;
					},
				},
			};
		},
	});
	return {
		...service,
		async get(trigger: string): Promise<MemoryBackend> {
			markers.push(`get:${trigger}`);
			return service.get(trigger);
		},
		async prewarm(trigger = "prewarm"): Promise<void> {
			markers.push(`prewarm:${trigger}`);
			await service.prewarm(trigger);
		},
	};
}

describe("legacy memory startup ordering", () => {
	test("SDK startup applies the durable ownership profile without persisting a transition marker", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-profile-sdk-startup-"));
		const authStorage = await AuthStorage.create(join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const settings = Settings.isolated({ "modelProfile.default": "codex-medium", "compaction.enabled": false });
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), settings);
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const result = await createAgentSession({
				cwd: process.cwd(),
				agentDir,
				settings,
				authStorage,
				modelRegistry,
				disableExtensionDiscovery: true,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				hasUI: false,
			});
			session = result.session;

			expect(session.getActiveModelProfile()).toBe("codex-medium");
			expect(session.getModelProfileOwnershipMarker()).toBeUndefined();
			expect(readDurableModelProfileOwnership(settings)).toEqual({
				schemaVersion: 1,
				version: 0,
				marker: { kind: "profile", profile: "codex-medium" },
			});
		} finally {
			await session?.dispose();
			authStorage.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("SDK resume keeps a saved clear above a durable profile baseline", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-profile-sdk-clear-"));
		const authStorage = await AuthStorage.create(join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({
			"modelProfile.default": "codex-medium",
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": false,
		});
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), settings);
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!sonnet) throw new Error("Expected bundled Sonnet model");
		let manager: SessionManager | undefined;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const originalManager = SessionManager.create(agentDir, agentDir);
			originalManager.appendModelChange(`${sonnet.provider}/${sonnet.id}`);
			originalManager.appendModelProfileOwnershipMarker({ kind: "cleared" });
			await originalManager.ensureOnDisk();
			await originalManager.flush();
			const sessionFile = originalManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted resume session");
			await originalManager.close();
			manager = await SessionManager.open(sessionFile);

			const result = await createAgentSession({
				cwd: process.cwd(),
				agentDir,
				settings,
				authStorage,
				modelRegistry,
				sessionManager: manager,
				disableExtensionDiscovery: true,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				hasUI: false,
			});
			session = result.session;

			expect(session.model?.provider).toBe("anthropic");
			expect(session.model?.id).toBe(sonnet.id);
			expect(session.getModelProfileOwnershipMarker()).toEqual({ kind: "cleared" });
			expect(session.getEffectiveModelProfileName()).toBeUndefined();
			expect(settings.getGlobal("modelProfile.default")).toBe("codex-medium");
			expect(readDurableModelProfileOwnership(settings).version).toBe(0);
		} finally {
			await session?.dispose();
			if (!session) await manager?.close();
			authStorage.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("SDK resume persists an explicit inherit over a saved clear tombstone", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-profile-sdk-inherit-"));
		const authStorage = await AuthStorage.create(join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const settings = Settings.isolated({
			"modelProfile.default": "codex-medium",
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": false,
		});
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), settings);
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!sonnet) throw new Error("Expected bundled Sonnet model");
		let manager: SessionManager | undefined;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const originalManager = SessionManager.create(agentDir, agentDir);
			originalManager.appendModelChange(`${sonnet.provider}/${sonnet.id}`);
			originalManager.appendModelProfileOwnershipMarker({ kind: "cleared" });
			await originalManager.ensureOnDisk();
			await originalManager.flush();
			const sessionFile = originalManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted resume session");
			await originalManager.close();
			manager = await SessionManager.open(sessionFile);

			const result = await createAgentSession({
				cwd: process.cwd(),
				agentDir,
				settings,
				authStorage,
				modelRegistry,
				sessionManager: manager,
				modelProfileOwnershipMarker: { kind: "inherit" },
				disableExtensionDiscovery: true,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				hasUI: false,
			});
			session = result.session;

			expect(session.model?.provider).toBe("anthropic");
			expect(session.model?.id).toBe(sonnet.id);
			expect(session.getModelProfileOwnershipMarker()).toEqual({ kind: "inherit" });
			expect(session.getEffectiveModelProfileName()).toBe("codex-medium");
			expect(session.getActiveModelProfile()).toBe("codex-medium");
			expect(manager.getModelProfileOwnershipMarker()).toEqual({ kind: "inherit" });
			expect(settings.getGlobal("modelProfile.default")).toBe("codex-medium");
			expect(readDurableModelProfileOwnership(settings).version).toBe(0);
		} finally {
			await session?.dispose();
			if (!session) await manager?.close();
			authStorage.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("refuses explicit SDK inheritance when the durable profile is unresolved", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-profile-sdk-inherit-unresolved-"));
		const authStorage = await AuthStorage.create(join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({
			"modelProfile.default": "deleted-profile",
			"compaction.enabled": false,
		});
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), settings);
		let manager: SessionManager | undefined;
		try {
			const originalManager = SessionManager.create(agentDir, agentDir);
			originalManager.appendModelChange("anthropic/claude-sonnet-4-5");
			originalManager.appendModelProfileOwnershipMarker({ kind: "cleared" });
			await originalManager.ensureOnDisk();
			await originalManager.flush();
			expect(originalManager.getModelProfileOwnershipMarker()).toEqual({ kind: "cleared" });
			const sessionFile = originalManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted resume session");
			await originalManager.close();
			manager = await SessionManager.open(sessionFile);

			await expect(
				createAgentSession({
					cwd: process.cwd(),
					agentDir,
					settings,
					authStorage,
					modelRegistry,
					sessionManager: manager,
					modelProfileOwnershipMarker: { kind: "inherit" },
					disableExtensionDiscovery: true,
					enableLsp: false,
					skipPythonPreflight: true,
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					hasUI: false,
				}),
			).rejects.toThrow('Model profile "deleted-profile"');

			await manager.close();
			manager = await SessionManager.open(sessionFile);
			expect(manager.getModelProfileOwnershipMarker()).toEqual({ kind: "cleared" });
			expect(settings.getGlobal("modelProfile.default")).toBe("deleted-profile");
			expect(settings.getGlobal("modelProfile.ownership")).toBeUndefined();
		} finally {
			await manager?.close();
			authStorage.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("SDK resume preserves an explicit concrete model while applying durable role bindings", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-profile-sdk-concrete-"));
		const authStorage = await AuthStorage.create(join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({
			"modelProfile.default": "codex-medium",
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": false,
		});
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), settings);
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!sonnet) throw new Error("Expected bundled Sonnet model");
		let manager: SessionManager | undefined;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const originalManager = SessionManager.create(agentDir, agentDir);
			originalManager.appendModelChange(`${sonnet.provider}/${sonnet.id}`);
			originalManager.appendConfiguredModelChain({
				role: "default",
				entries: [`${sonnet.provider}/${sonnet.id}`],
				origin: "model_selection",
				explicitHead: true,
			});
			await originalManager.ensureOnDisk();
			await originalManager.flush();
			const sessionFile = originalManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted resume session");
			await originalManager.close();
			manager = await SessionManager.open(sessionFile);

			const result = await createAgentSession({
				cwd: process.cwd(),
				agentDir,
				settings,
				authStorage,
				modelRegistry,
				sessionManager: manager,
				disableExtensionDiscovery: true,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				hasUI: false,
			});
			session = result.session;

			expect(session.model?.provider).toBe("anthropic");
			expect(session.model?.id).toBe(sonnet.id);
			expect(session.getActiveModelProfile()).toBe("codex-medium");
			expect(session.getModelProfileOwnershipMarker()).toBeUndefined();
			expect(session.getConfiguredModelChainState("default")).toMatchObject({
				entries: [`${sonnet.provider}/${sonnet.id}`],
				origin: "model_selection",
				explicitHead: true,
			});
		} finally {
			await session?.dispose();
			if (!session) await manager?.close();
			authStorage.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("SDK resume resolves a saved profile-owned chain from the current profile definition", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-profile-sdk-current-chain-"));
		const authStorage = await AuthStorage.create(join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({
			"modelProfile.default": "codex-medium",
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			"compaction.enabled": false,
		});
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), settings);
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!sonnet) throw new Error("Expected bundled Sonnet model");
		let manager: SessionManager | undefined;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const originalManager = SessionManager.create(agentDir, agentDir);
			originalManager.appendModelChange(`${sonnet.provider}/${sonnet.id}`);
			originalManager.appendConfiguredModelChain({
				role: "default",
				entries: ["removed-provider/old-profile-default"],
				origin: "profile-activation",
				identity: "codex-medium",
				explicitHead: true,
			});
			await originalManager.ensureOnDisk();
			await originalManager.flush();
			const sessionFile = originalManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted resume session");
			await originalManager.close();
			manager = await SessionManager.open(sessionFile);

			const result = await createAgentSession({
				cwd: process.cwd(),
				agentDir,
				settings,
				authStorage,
				modelRegistry,
				sessionManager: manager,
				disableExtensionDiscovery: true,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				hasUI: false,
			});
			session = result.session;

			expect(session.model?.provider).toBe("openai-codex");
			expect(session.model?.id).toBe("gpt-5.6-sol");
			expect(session.getActiveModelProfile()).toBe("codex-medium");
			expect(session.getModelProfileOwnershipMarker()).toBeUndefined();
			expect(session.getConfiguredModelChainState("default")).toMatchObject({
				entries: ["removed-provider/old-profile-default"],
				origin: "profile-activation",
				identity: "codex-medium",
			});
		} finally {
			await session?.dispose();
			if (!session) await manager?.close();
			authStorage.close();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("real createAgentSession prewarms memory at the legacy startup boundary", async () => {
		const markers: string[] = [];
		const settings = Settings.isolated({ "memory.backend": "off" });
		const injected = markerMemoryService(markers);
		const runtimeServices = createOptionalRuntimeServices(settings, { memoryBackend: injected });
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-vb001-boot-"));
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const result = await createAgentSession({
				cwd: process.cwd(),
				agentDir,
				settings,
				runtimeServices,
				disableExtensionDiscovery: true,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				hasUI: false,
			});
			session = result.session;

			const prewarmIndex = markers.indexOf("prewarm:legacy-startup");
			const initializationIndex = markers.indexOf("memory-backend-initialization");
			const startIndex = markers.indexOf("memory-backend-start");
			expect(prewarmIndex).toBeGreaterThanOrEqual(0);
			expect(initializationIndex).toBeGreaterThan(prewarmIndex);
			expect(startIndex).toBeGreaterThan(initializationIndex);
			expect(markers.slice(0, prewarmIndex)).not.toContain("memory-backend-initialization");
			expect(markers).not.toContain("get:build-developer-instructions");
			expect(markers).not.toContain("get:legacy-startup");
			expect(markers.filter(marker => marker === "memory-backend-initialization")).toHaveLength(1);
		} finally {
			await session?.dispose();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("memory startup rejection is joined by createAgentSession", async () => {
		const markers: string[] = [];
		const startFailure = new Error("memory startup failed");
		const settings = Settings.isolated({ "memory.backend": "off" });
		const injected = markerMemoryService(markers, startFailure);
		const runtimeServices = createOptionalRuntimeServices(settings, { memoryBackend: injected });
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-vb001-start-failure-"));
		try {
			await expect(
				createAgentSession({
					cwd: process.cwd(),
					agentDir,
					settings,
					runtimeServices,
					disableExtensionDiscovery: true,
					enableLsp: false,
					skipPythonPreflight: true,
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					hasUI: false,
				}),
			).rejects.toBe(startFailure);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	test("concurrent STT toggles keep one controller identity after the async load", async () => {
		let current: SttModeController | undefined;
		let loadCount = 0;
		let createCount = 0;
		const gate = Promise.withResolvers<void>();
		const load = async (): Promise<() => SttModeController> => {
			loadCount += 1;
			await gate.promise;
			return () => {
				createCount += 1;
				return {} as SttModeController;
			};
		};
		const first = ensureSttControllerForToggle(
			() => current,
			value => (current = value),
			load,
		);
		const second = ensureSttControllerForToggle(
			() => current,
			value => (current = value),
			load,
		);
		gate.resolve();
		const [firstController, secondController] = await Promise.all([first, second]);

		expect(loadCount).toBe(2);
		expect(createCount).toBe(1);
		expect(firstController).toBe(secondController);
		expect(current).toBe(firstController);
	});
});
