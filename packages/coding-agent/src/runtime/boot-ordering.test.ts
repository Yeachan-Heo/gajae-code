import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../config/settings";
import { offBackend } from "../memory-backend/off-backend";
import type { MemoryBackend } from "../memory-backend/types";
import type { SttModeController } from "../modes/controllers/stt-controller";
import { ensureSttControllerForToggle } from "../modes/interactive-mode";
import { createAgentSession } from "../sdk/session";
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
