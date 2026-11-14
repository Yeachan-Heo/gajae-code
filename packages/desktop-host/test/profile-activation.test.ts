import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createEmbeddedAgentSession,
	type EmbeddedAgentSessionResult,
	forkEmbeddedSession,
	listEmbeddedProjectSessions,
} from "@gajae-code/coding-agent/sdk";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length) await cleanups.pop()?.();
});

async function fixture() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedded-profile-")));
	const cwd = path.join(directory, "project");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd);
	await Bun.write(
		path.join(agentDir, "model-presets", "control.json"),
		JSON.stringify({ version: 1, disabled: true }),
	);
	await Bun.write(path.join(agentDir, "config.yml"), "startup:\n  networkPrewarm: false\n");
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: "https://example.invalid",
					apiKey: "fixture-only",
					models: [
						{ id: "base", name: "Base", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512 },
					],
				},
			},
			profiles: {
				desk: { display_name: "Desk", required_providers: ["fixture"], model_mapping: { default: "fixture/base" } },
			},
		}),
	);
	const resources: EmbeddedAgentSessionResult[] = [];
	cleanups.push(async () => {
		for (const resource of resources.reverse()) {
			await resource.session.dispose();
			await resource.releaseResources();
		}
		await fs.rm(directory, { recursive: true, force: true });
	});
	const control = await createEmbeddedAgentSession({
		cwd,
		agentDir,
		storage: { persist: false },
		controlOnly: true,
		deferOptionalModelRefresh: true,
		deferModelProfileActivation: true,
	});
	resources.push(control);
	const prototype = Object.getPrototypeOf(control.session.modelRegistry) as typeof control.session.modelRegistry;
	const original = prototype.refresh;
	const strategies: string[] = [];
	vi.spyOn(prototype, "refresh").mockImplementation(function (this: typeof prototype, strategy, credentialSessionId) {
		strategies.push(strategy ?? "default");
		// Preserve actual registry parsing while forbidding provider network discovery.
		return original.call(this, "offline", credentialSessionId);
	});
	const create = async () => {
		const resource = await createEmbeddedAgentSession({
			cwd,
			agentDir,
			authStorage: control.session.modelRegistry.authStorage,
			storage: { directory: path.join(directory, "sessions") },
			deferOptionalModelRefresh: true,
			deferModelProfileActivation: true,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMcpAutoload: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
		});
		resources.push(resource);
		return resource;
	};
	return { directory, cwd, agentDir, control, create, strategies };
}

describe("public SDK embedding initialization", () => {
	test("control-only bootstrap creates no transcript and releases the real session", async () => {
		const f = await fixture();
		expect(f.control.session.sessionManager.getSessionFile()).toBeUndefined();
		const inventory = await listEmbeddedProjectSessions({
			cwd: f.cwd,
			agentDir: f.agentDir,
			directory: path.join(f.directory, "sessions"),
		});
		expect(inventory.local).toEqual([]);
		await f.control.session.dispose();
		await f.control.releaseResources();
		await f.control.releaseResources();
		expect(f.control.session.sessionLifecycle.disposed).toBe(true);
		await expect(f.control.refreshModels("offline")).rejects.toThrow("Session changed while refreshing models");
	});

	test("a project mismatch releases the admitted local writer before factory construction", async () => {
		const f = await fixture();
		const source = await f.create();
		await source.session.sessionManager.ensureOnDisk();
		await source.session.sessionManager.flush();
		const manager = await forkEmbeddedSession({
			file: source.session.sessionManager.getSessionFile()!,
			cwd: f.cwd,
			directory: path.join(f.directory, "forks"),
		});
		const close = vi.spyOn(manager, "close");
		const createSession = vi.fn(async () => {
			throw new Error("Mismatched writer must never reach session construction");
		});
		await expect(
			createEmbeddedAgentSession({
				cwd: f.directory,
				agentDir: f.agentDir,
				storage: { directory: path.join(f.directory, "forks"), manager },
				createSession,
			}),
		).rejects.toThrow("Session project does not match catalog");
		expect(close).toHaveBeenCalledTimes(1);
		expect(createSession).not.toHaveBeenCalled();
	});

	test("warm profile selectors do not demand an online registry refresh", async () => {
		const f = await fixture();
		await Bun.write(
			path.join(f.agentDir, "config.yml"),
			"modelProfile:\n  default: desk\nmodelRoles:\n  executor: fixture/base\n",
		);
		const result = await f.create();
		expect(f.strategies).not.toContain("online");
		expect(result.session.getActiveModelProfile()).toBe("desk");
		expect(result.modelProfileWarning).toBeUndefined();
	});

	test("persisted role selectors missing from the offline catalog request SDK discovery", async () => {
		const f = await fixture();
		await Bun.write(path.join(f.agentDir, "config.yml"), "modelRoles:\n  executor: fixture/missing:high\n");
		await f.create();
		expect(f.strategies).toContain("online");
	});
});
