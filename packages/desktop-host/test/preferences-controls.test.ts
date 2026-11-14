import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai/core";
import {
	type CreateAgentSessionResult,
	createAgentSession,
	SdkPreferenceControls,
	SdkPreferenceError,
	Settings,
} from "@gajae-code/coding-agent/sdk";
import { createDesktopPreferencesController } from "../src/preferences-controls";

const provider = "desktop-preferences-fixture";
const selector = (id: string) => `${provider}/${id}`;
const model: Model = {
	id: "base",
	name: "Base",
	provider,
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length) await cleanups.pop()?.();
});

/** Public factory and SDK controls; all configuration files are isolated fixture input. */
async function fixture(durable = false) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-sdk-preferences-"));
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(agentDir);
	await Bun.write(
		path.join(agentDir, "model-presets", "control.json"),
		JSON.stringify({ version: 1, disabled: true }),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				[provider]: {
					api: model.api,
					baseUrl: model.baseUrl,
					apiKey: "fixture-key",
					models: [
						{ id: "base", name: "Base", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 },
						{
							id: "nested/next",
							name: "Next",
							reasoning: false,
							input: ["text"],
							contextWindow: 4096,
							maxTokens: 1024,
						},
					],
				},
			},
			profiles: {
				"desk-a": {
					display_name: "Desktop A",
					required_providers: [provider],
					model_mapping: { default: selector("base") },
				},
				"desk-b": {
					display_name: "Desktop B",
					required_providers: [provider],
					model_mapping: { default: selector("nested/next"), executor: selector("base") },
				},
			},
		}),
	);
	const settings = durable
		? await Settings.loadForScope({ cwd: directory, agentDir })
		: Settings.isolated({ "compaction.enabled": false });
	let result: CreateAgentSessionResult | undefined;
	cleanups.push(async () => {
		await result?.session.dispose();
		await settings.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	result = await createAgentSession({
		cwd: directory,
		agentDir,
		settings,
		model,
		providerSessionId: crypto.randomUUID(),
		agentId: `preferences-${crypto.randomUUID()}`,
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: directory, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMcpAutoload: false,
		enableLsp: false,
		toolNames: [],
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
		deferModelProfileActivation: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
	});
	const controller = createDesktopPreferencesController(result.session);
	cleanups.push(async () => {
		controller.dispose();
	});
	return { directory, agentDir, settings, session: result.session, controller };
}

describe("desktop SDK preferences delegation", () => {
	test("maps session/default profile scopes and reads the canonical SDK result", async () => {
		const { controller, session, settings } = await fixture(true);
		const select = vi.spyOn(SdkPreferenceControls.prototype, "selectProfile");
		expect(await controller.apply({ type: "profile.select", name: "desk-b", scope: "session" })).toMatchObject({
			applied: "profile.select",
			profileId: "desk-b",
			scope: "session",
			durability: "session",
		});
		expect(select).toHaveBeenLastCalledWith({ name: "desk-b", scope: "session" });
		expect(session.getActiveModelProfile()).toBe("desk-b");
		expect(controller.read().profiles.find(item => item.id === "desk-b")).toMatchObject({
			name: "Desktop B",
			active: true,
			groupRank: null,
		});
		expect(await controller.apply({ type: "profile.select", name: "desk-a", scope: "default" })).toMatchObject({
			profileId: "desk-a",
			scope: "default",
			durability: "persisted",
		});
		expect(select).toHaveBeenLastCalledWith({ name: "desk-a", scope: "global" });
		expect(settings.getGlobal("modelProfile.default")).toBe("desk-a");
		expect(controller.read().profiles.find(item => item.id === "desk-a")?.default).toBe(true);
	});

	test("delegates nested default model identities and task-role ownership/clear", async () => {
		const { controller, session } = await fixture(true);
		const select = vi.spyOn(SdkPreferenceControls.prototype, "selectModel");
		const role = vi.spyOn(SdkPreferenceControls.prototype, "setRole");
		await controller.apply({ type: "role.set", role: "default", modelId: selector("nested/next") });
		expect(select).toHaveBeenCalledWith({ provider, modelId: "nested/next", scope: "global" });
		expect(session.model?.id).toBe("nested/next");
		await controller.apply({ type: "role.set", role: "planner", modelId: selector("base") });
		expect(role).toHaveBeenLastCalledWith({ role: "planner", modelId: selector("base") });
		expect(controller.read().roles.find(item => item.id === "planner")).toMatchObject({
			configured: true,
			model: { id: "base", provider },
			scope: "session",
			canClear: { available: true },
		});
		await controller.apply({ type: "role.set", role: "planner", modelId: null });
		expect(role).toHaveBeenLastCalledWith({ role: "planner", modelId: null });
		expect(controller.read().roles.find(item => item.id === "planner")?.canClear.available).toBe(false);
	});

	test("SDK role readback is authoritative, not a reconstructed settings override", async () => {
		const { controller } = await fixture();
		const readRoles = vi.spyOn(SdkPreferenceControls.prototype, "readRoles");
		// A real role write exercises both SDK-owned source and effective-resolution mapping.
		await controller.apply({ type: "role.set", role: "architect", modelId: selector("nested/next") });
		const dto = controller.read();
		expect(readRoles).toHaveBeenCalled();
		expect(dto.roles.find(item => item.id === "architect")).toMatchObject({
			configured: true,
			model: { id: "nested/next", provider, name: "Next" },
			canClear: { available: true },
		});
		dto.profiles[0]!.name = "caller mutation";
		expect(controller.read().profiles[0]!.name).not.toBe("caller mutation");
		expect(JSON.stringify(dto)).not.toContain("fixture-key");
		expect(JSON.stringify(dto)).not.toContain("example.invalid");
	});

	test("malformed and unsupported wire actions never enter SDK mutation", async () => {
		const { controller } = await fixture();
		const profile = vi.spyOn(SdkPreferenceControls.prototype, "selectProfile");
		const select = vi.spyOn(SdkPreferenceControls.prototype, "selectModel");
		const role = vi.spyOn(SdkPreferenceControls.prototype, "setRole");
		const patch = vi.spyOn(SdkPreferenceControls.prototype, "patchConfig");
		for (const action of [
			null,
			[],
			{},
			{ type: "profile.select", name: "desk-a", scope: "global" },
			{ type: "profile.select", name: "desk-a", scope: "session", owner: "caller" },
			{ type: "role.set", role: "executor", modelId: false },
			{ type: "role.set", role: "default", modelId: "unqualified" },
			{ type: "sampling.set", parameter: "temperature", value: Number.NaN, scope: "session" },
		])
			await expect(controller.apply(action)).rejects.toMatchObject({ code: "invalid_input" });
		for (const action of [
			{ type: "role.set", role: "image", modelId: selector("base") },
			{ type: "role.set", role: "default", modelId: null },
			{ type: "sampling.set", parameter: "temperature", value: 0.5, scope: "session" },
		])
			await expect(controller.apply(action)).rejects.toMatchObject({ code: "unsupported_preference" });
		expect(profile).not.toHaveBeenCalled();
		expect(select).not.toHaveBeenCalled();
		expect(role).not.toHaveBeenCalled();
		expect(patch).not.toHaveBeenCalled();
	});

	test("accessor input is rejected without evaluating caller code", async () => {
		const { controller } = await fixture();
		const read = vi.fn(() => "desk-a");
		const action = { type: "profile.select", scope: "session" };
		Object.defineProperty(action, "name", { enumerable: true, get: read });
		await expect(controller.apply(action)).rejects.toMatchObject({ code: "invalid_input" });
		expect(read).not.toHaveBeenCalled();
	});

	test("SDK validation, persistence, busy and stale failures remain refusals", async () => {
		const { controller } = await fixture();
		await expect(
			controller.apply({ type: "profile.select", name: "missing", scope: "session" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			controller.apply({ type: "profile.select", name: "desk-a", scope: "default" }),
		).rejects.toMatchObject({ code: "unsupported_preference" });
		const select = vi.spyOn(SdkPreferenceControls.prototype, "selectProfile");
		for (const code of ["preference_busy", "stale_preferences", "preference_failed"] as const) {
			select.mockRejectedValueOnce(new SdkPreferenceError(code, "SDK refusal"));
			await expect(
				controller.apply({ type: "profile.select", name: "desk-a", scope: "session" }),
			).rejects.toMatchObject({ code });
		}
		controller.dispose();
		await expect(
			controller.apply({ type: "profile.select", name: "desk-a", scope: "session" }),
		).rejects.toMatchObject({ code: "stale_preferences" });
	});

	test("SDK admission rejects overlapping preference operations without desktop reservations", async () => {
		const { controller, session } = await fixture();
		const available = vi.spyOn(session, "getAvailableModels");
		const pending = controller.apply({ type: "role.set", role: "executor", modelId: selector("base") });
		// SDK admission is synchronous; its real model preflight yields before mutation.
		expect(available).toHaveBeenCalled();
		await expect(
			controller.apply({ type: "profile.select", name: "desk-b", scope: "session" }),
		).rejects.toMatchObject({ code: "preference_busy" });
		await expect(pending).resolves.toMatchObject({ applied: "role.set", role: "executor" });
	});

	test("disposing during SDK preflight fences late mutation", async () => {
		const { controller, session } = await fixture();
		const available = vi.spyOn(session, "getAvailableModels");
		const pending = controller.apply({ type: "role.set", role: "planner", modelId: selector("base") });
		expect(available).toHaveBeenCalled();
		controller.dispose();
		await expect(pending).rejects.toMatchObject({ code: "stale_preferences" });
		expect(session.hasSessionAgentModelOverride("planner")).toBe(false);
	});

	test("committed-unapplied and uncertain outcomes are not fabricated success", async () => {
		const { controller } = await fixture();
		const select = vi.spyOn(SdkPreferenceControls.prototype, "selectProfile");
		for (const outcome of [
			{
				scope: "global",
				durability: "persisted",
				applied: false,
				application: "committed-unapplied",
				committedVersion: 7,
			},
			{ scope: "global", durability: "unknown", applied: false, application: "recovery-required" },
		] as const) {
			select.mockResolvedValueOnce({ ...outcome, profileId: "desk-a" });
			await expect(
				controller.apply({ type: "profile.select", name: "desk-a", scope: "default" }),
			).rejects.toMatchObject({ code: "preference_failed", outcome });
		}
	});

	test("global/project config scopes retain SDK settings versus next-session outcomes", async () => {
		const { controller, settings } = await fixture(true);
		const patch = vi.spyOn(SdkPreferenceControls.prototype, "patchConfig");
		const global = await controller.writeConfig({ scope: "global", patch: { "compaction.enabled": true } });
		expect(patch).toHaveBeenLastCalledWith({ scope: "global", patch: { "compaction.enabled": true } });
		expect(global).toMatchObject({
			scope: "global",
			durability: "persisted",
			applied: true,
			application: "settings",
		});
		expect(settings.getGlobal("compaction.enabled")).toBe(true);
		const project = await controller.writeConfig({ scope: "project", patch: { "compaction.enabled": false } });
		expect(patch).toHaveBeenLastCalledWith({ scope: "project", patch: { "compaction.enabled": false } });
		expect(project).toMatchObject({
			scope: "project",
			durability: "persisted",
			applied: false,
			application: "next-session",
		});
		expect(settings.get("compaction.enabled")).toBe(true);
	});

	test("scoped SDK config writes stay session-owned and restore on disposal", async () => {
		const { controller, settings } = await fixture();
		const before = settings.get("compaction.enabled");
		const patch = vi.spyOn(SdkPreferenceControls.prototype, "patchConfig");
		const result = await controller.writeConfig({ scope: "session", patch: { "compaction.enabled": !before } });
		expect(patch).toHaveBeenCalledWith({ scope: "session", patch: { "compaction.enabled": !before } });
		expect(result).toMatchObject({ applied: true, durability: "session", scope: "session", application: "settings" });
		expect(settings.get("compaction.enabled")).toBe(!before);
		await expect(
			controller.writeConfig({ scope: "session", patch: { "modelProfile.default": "desk-a" } }),
		).rejects.toMatchObject({ code: "invalid_input" });
		controller.dispose();
		expect(settings.get("compaction.enabled")).toBe(before);
	});
});
