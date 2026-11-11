import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import { YAML } from "bun";
import { readDurableModelProfileOwnership } from "../src/config/model-profile-ownership";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	createSdkPreferenceControls,
	isSdkPreferenceControlOperation,
	isSdkPreferenceOperation,
	isSdkPreferenceQueryOperation,
	SDK_PREFERENCE_CONTROL_OPERATIONS,
	SdkPreferenceControls,
	SdkPreferenceError,
} from "../src/sdk/preference-controls";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const first: Model = {
	id: "first",
	name: "First",
	provider: "fixture",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};
const second: Model = { ...first, id: "nested/second", name: "Second" };
const profile: ModelProfileDefinition = {
	name: "custom/profile !",
	source: "user",
	requiredProviders: ["fixture"],
	modelMapping: {
		default: "fixture/nested/second:high",
		executor: "fixture/first:low",
		planner: "fixture/nested/second:high",
	},
};

interface Fixture {
	root: string;
	cwd: string;
	agentDir: string;
	auth: AuthStorage;
	registry: ModelRegistry;
	settings: Settings;
	session: AgentSession;
	controls: SdkPreferenceControls;
	sessions: AgentSession[];
}
const fixtures: Fixture[] = [];
const openedSettings: Settings[] = [];

afterEach(async () => {
	for (const settings of openedSettings.splice(0)) await settings.close();
	for (const fixture of fixtures.splice(0).reverse()) {
		fixture.controls.dispose();
		for (const session of fixture.sessions) await session.dispose();
		await fixture.registry.dispose();
		await fixture.settings.close();
		fixture.auth.close();
		await fs.rm(fixture.root, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

async function fixture(durable = false, fixedProviderSessionId = true): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-preferences-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"));
	vi.spyOn(registry, "getAvailable").mockReturnValue([first, second]);
	vi.spyOn(registry, "getAll").mockReturnValue([first, second]);
	vi.spyOn(registry, "getApiKey").mockResolvedValue("fixture-key");
	vi.spyOn(registry, "getApiKeyForProvider").mockResolvedValue("fixture-key");
	vi.spyOn(registry, "isKnownProvider").mockReturnValue(true);
	vi.spyOn(registry, "getModelProfiles").mockReturnValue(new Map([[profile.name, profile]]));
	vi.spyOn(registry, "getModelProfile").mockImplementation(name => (name === profile.name ? profile : undefined));
	vi.spyOn(registry, "getError").mockReturnValue(undefined);
	if (durable)
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				compaction: { enabled: true },
				task: { agentModelOverrides: { executor: ["fixture/first:low"] } },
			}),
		);
	const settings = durable
		? await Settings.loadForScope({ cwd, agentDir })
		: Settings.isolated({
				"compaction.enabled": true,
				"task.agentModelOverrides": { executor: ["fixture/first:low"] },
			});
	const manager = durable ? SessionManager.create(cwd, path.join(root, "sessions")) : SessionManager.inMemory(cwd);
	manager.appendMessage({ role: "user", content: "fixture transcript", timestamp: 1 });
	if (durable) await manager.ensureOnDisk();
	const session = createSession(settings, registry, manager, fixedProviderSessionId);
	const result: Fixture = {
		root,
		cwd,
		agentDir,
		auth,
		registry,
		settings,
		session,
		controls: createSdkPreferenceControls(session),
		sessions: [session],
	};
	fixtures.push(result);
	return result;
}

function createSession(
	settings: Settings,
	registry: ModelRegistry,
	manager: SessionManager,
	fixedProviderSessionId = true,
): AgentSession {
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "fixture-key",
			initialState: { model: first, systemPrompt: ["Test"], tools: [] },
		}),
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		thinkingLevel: Effort.Low,
		providerSessionId: fixedProviderSessionId ? "stable-sdk-fixture-id" : undefined,
	});
}

async function globalConfig(f: Fixture): Promise<Record<string, unknown>> {
	return YAML.parse(await Bun.file(path.join(f.agentDir, "config.yml")).text()) as Record<string, unknown>;
}

describe("SDK preference controls", () => {
	it("publishes a closed query/control allowlist without changing model.set", async () => {
		const f = await fixture();
		expect(isSdkPreferenceOperation("model.roles.get")).toBe(true);
		expect(isSdkPreferenceQueryOperation("model.roles.get")).toBe(true);
		expect(isSdkPreferenceControlOperation("model.roles.get")).toBe(false);
		expect(SDK_PREFERENCE_CONTROL_OPERATIONS.every(isSdkPreferenceControlOperation)).toBe(true);
		for (const operation of ["model.set", "config.patch", "model.role.delete", "toString"])
			expect(isSdkPreferenceOperation(operation)).toBe(false);
		await expect(f.controls.handle("model.roles.get", { extra: true })).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(f.controls.handle("model.set" as "model.select", {})).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(await f.controls.handle("model.roles.get", {})).toEqual(f.controls.readRoles());
	});

	it("delegates every task-role selection and clear to the private session-owned layer", async () => {
		const f = await fixture();
		const sibling = createSession(f.settings, f.registry, SessionManager.inMemory(f.cwd));
		f.sessions.push(sibling);
		const setRole = vi.spyOn(f.session, "setSessionAgentModelSelection");
		const readOverrides = vi.spyOn(f.session, "getAgentModelOverrides");
		const global = structuredClone(f.settings.getGlobal("task.agentModelOverrides"));
		const before = f.controls.readRoles().roles.find(role => role.role === "executor");
		expect(before).toMatchObject({
			configured: ["fixture/first:low"],
			source: "global",
			canClear: false,
			effective: { provider: "fixture", modelId: "first", thinkingLevel: Effort.Low },
		});
		for (const role of ["executor", "planner", "critic", "architect"] as const) {
			const selected = await f.controls.setRole({ role, modelId: "fixture/nested/second" });
			expect(setRole).toHaveBeenLastCalledWith(role, second);
			expect(selected).toMatchObject({ role, scope: "session", durability: "session", applied: true });
			expect(selected.roles.find(item => item.role === role)).toMatchObject({
				source: "session",
				canClear: true,
				configured: "fixture/nested/second",
				effective: { modelId: "nested/second" },
			});
		}
		expect(readOverrides).toHaveBeenCalled();
		expect(f.settings.getGlobal("task.agentModelOverrides")).toEqual(global);
		expect(sibling.resolveRoleModel("executor")?.id).toBe("first");
		expect(f.session.model).toBe(first);
		f.settings.override("task.agentModelOverrides", { executor: "fixture/first:high" });
		const cleared = await f.controls.setRole({ role: "executor", modelId: null });
		expect(setRole).toHaveBeenLastCalledWith("executor", null);
		expect(cleared.roles.find(role => role.role === "executor")).toMatchObject({
			configured: "fixture/first:high",
			source: "runtime",
			canClear: false,
			effective: { modelId: "first", thinkingLevel: Effort.High },
		});
		cleared.roles[0].configured = "changed";
		expect(f.controls.readRoles().roles[0].configured).toBe("fixture/first:high");
	});

	it("validates exact fields, role/model identities, JSON boundaries and secrets before mutation", async () => {
		const f = await fixture();
		const mutate = vi.spyOn(f.session, "withSdkControlMutation");
		for (const input of [
			{ role: "image", modelId: null },
			{ role: "default", modelId: "fixture/first" },
			{ role: "executor", modelId: "first" },
			{ role: "executor", modelId: "fixture/missing" },
			{ role: "executor", modelId: null, scope: "global" },
		])
			await expect(f.controls.handle("model.role.set", input)).rejects.toMatchObject({ code: "invalid_input" });
		for (const input of [
			{ provider: "fixture", modelId: "first" },
			{ provider: "fixture", modelId: "first", scope: "project" },
			{ provider: "fixture", modelId: "first", scope: "session", ownerId: "forged" },
		])
			await expect(f.controls.handle("model.select", input)).rejects.toMatchObject({ code: "invalid_input" });
		for (const patch of [
			{ unknown: true },
			{ "compaction.enabled": "no" },
			{ temperature: Number.NaN },
			{ "modelProfile.default": profile.name },
			{ "modelProfile.ownership": { version: 1 } },
			{ modelRoles: { default: "fixture/first" } },
			{ "task.agentModelOverrides": { critic: "fixture/first" } },
			{ "notifications.telegram.enabled": true },
			JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
		])
			await expect(f.controls.patchConfig({ scope: "session", patch })).rejects.toBeInstanceOf(SdkPreferenceError);
		for (const patch of [
			{ "auth.apiKey": "hidden" },
			{ modelTags: { tag: { authorization: "hidden" } } },
			{ shellPath: "https://user:password@example.invalid/shell" },
		])
			await expect(f.controls.patchConfig({ scope: "session", patch })).rejects.toMatchObject({
				code: "secret_field_forbidden",
			});
		const accessor = Object.defineProperty({}, "scope", {
			enumerable: true,
			get: () => {
				throw new Error("must not execute");
			},
		});
		await expect(f.controls.handle("config.write", accessor)).rejects.toMatchObject({ code: "invalid_input" });
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(f.controls.patchConfig({ scope: "session", patch: cyclic })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(mutate).not.toHaveBeenCalled();
		expect(f.session.hasSessionAgentModelOverride("executor")).toBe(false);
	});

	it("requires writable durable storage only for explicit durable selections/writes", async () => {
		const f = await fixture();
		await expect(
			f.controls.selectModel({ provider: "fixture", modelId: "first", scope: "global" }),
		).rejects.toMatchObject({ code: "persistence_unavailable" });
		await expect(f.controls.selectProfile({ name: profile.name, scope: "global" })).rejects.toMatchObject({
			code: "persistence_unavailable",
		});
		for (const scope of ["global", "project"] as const)
			await expect(f.controls.patchConfig({ scope, patch: { "compaction.enabled": false } })).rejects.toMatchObject({
				code: "persistence_unavailable",
			});
		const outcome = await f.controls.patchConfig({ scope: "session", patch: { "compaction.enabled": false } });
		expect(outcome).toMatchObject({
			scope: "session",
			durability: "session",
			applied: true,
			application: "settings",
		});
		expect(f.settings.get("compaction.enabled")).toBe(false);
		expect(f.settings.getGlobal("compaction.enabled")).toBe(true);
	});

	for (const durable of [false, true])
		it(`retires session config before initializing a new identity (${durable ? "durable" : "memory"})`, async () => {
			const f = await fixture(durable, false);
			const originalId = f.session.sessionId;
			expect(originalId).toBe(f.session.sessionManager.getSessionId());
			const originalTemperature = f.settings.get("temperature");
			const before = durable ? await globalConfig(f) : undefined;
			await f.controls.patchConfig({
				scope: "session",
				patch: { temperature: 0.9, "compaction.enabled": false },
			});
			let cleanupTemperature: number | undefined;
			const unregister = f.session.registerToolSessionTransitionCleanup(() => {
				cleanupTemperature = f.settings.get("temperature");
			});
			try {
				expect(await f.session.newSession()).toBe(true);
			} finally {
				unregister();
			}
			expect(f.session.sessionId).not.toBe(originalId);
			expect(f.session.sessionId).toBe(f.session.sessionManager.getSessionId());
			expect(cleanupTemperature).toBe(originalTemperature);
			expect(f.settings.hasOverride("temperature")).toBe(false);
			expect(f.settings.hasOverride("compaction.enabled")).toBe(false);
			expect(f.settings.get("temperature")).toBe(originalTemperature);
			expect(f.settings.get("compaction.enabled")).toBe(true);
			expect(() => f.controls.readRoles()).toThrow(expect.objectContaining({ code: "stale_preferences" }));
			if (durable) {
				if (before === undefined) throw new Error("Durable fixture did not capture its original configuration.");
				expect(await globalConfig(f)).toEqual(before);
			}
			const successor = createSdkPreferenceControls(f.session);
			try {
				await successor.patchConfig({ scope: "session", patch: { temperature: 0.6 } });
				expect(f.settings.getOverride("temperature")).toBe(0.6);
			} finally {
				successor.dispose();
			}
			expect(f.settings.hasOverride("temperature")).toBe(false);
		});

	it("restores prior overrides across a real fork transition", async () => {
		const f = await fixture(true, false);
		const originalId = f.session.sessionId;
		expect(originalId).toBe(f.session.sessionManager.getSessionId());
		f.settings.override("temperature", 0.2);
		await f.controls.patchConfig({
			scope: "session",
			patch: { temperature: 0.9, "compaction.enabled": false },
		});
		expect(await f.session.fork()).toBe(true);
		expect(f.session.sessionId).not.toBe(originalId);
		expect(f.session.sessionId).toBe(f.session.sessionManager.getSessionId());
		expect(f.settings.getOverride("temperature")).toBe(0.2);
		expect(f.settings.hasOverride("compaction.enabled")).toBe(false);
		expect(() => f.controls.readRoles()).toThrow(expect.objectContaining({ code: "stale_preferences" }));
	});

	it("restores session overrides when the real AgentSession is disposed", async () => {
		const f = await fixture();
		f.settings.override("temperature", 0.2);
		await f.controls.patchConfig({
			scope: "session",
			patch: { temperature: 0.8, "compaction.enabled": false },
		});
		await f.session.dispose();
		expect(f.settings.getOverride("temperature")).toBe(0.2);
		expect(f.settings.hasOverride("compaction.enabled")).toBe(false);
	});

	it("restores the first prior override after repeated owned writes, not the last SDK value", async () => {
		const f = await fixture();
		f.settings.override("temperature", 0.2);
		f.settings.override("compaction.enabled", true);
		await f.controls.patchConfig({
			scope: "session",
			patch: { temperature: 0.7, "compaction.enabled": false },
		});
		await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.9 } });
		f.settings.override("topP", 0.4);
		f.controls.dispose();
		f.controls.dispose();
		expect(f.settings.getOverride("temperature")).toBe(0.2);
		expect(f.settings.hasOverride("compaction.enabled")).toBe(true);
		expect(f.settings.getOverride("compaction.enabled")).toBe(true);
		expect(f.settings.getOverride("topP")).toBe(0.4);
	});

	it("preserves an explicitly present undefined runtime override", async () => {
		const f = await fixture();
		f.settings.override("browser.screenshotDir", undefined);
		await f.controls.patchConfig({
			scope: "session",
			patch: { "browser.screenshotDir": path.join(f.root, "screenshots") },
		});
		f.controls.dispose();
		expect(f.settings.hasOverride("browser.screenshotDir")).toBe(true);
		expect(f.settings.getOverride("browser.screenshotDir")).toBeUndefined();
	});

	for (const foreign of ["different-value", "same-value", "remove"] as const)
		it(`preserves a newer foreign ${foreign} mutation while restoring other owned paths`, async () => {
			const f = await fixture();
			f.settings.override("temperature", 0.2);
			await f.controls.patchConfig({
				scope: "session",
				patch: { temperature: 0.8, "compaction.enabled": false },
			});
			const ownedRevision = f.settings.getOverrideRevision("temperature");
			if (foreign === "remove") f.settings.clearOverride("temperature");
			else f.settings.override("temperature", foreign === "same-value" ? 0.8 : 0.4);
			const foreignRevision = f.settings.getOverrideRevision("temperature");
			expect(foreignRevision).not.toBe(ownedRevision);
			await f.session.newSession();
			expect(f.settings.getOverrideRevision("temperature")).toBe(foreignRevision);
			expect(f.settings.hasOverride("temperature")).toBe(foreign !== "remove");
			expect(f.settings.getOverride("temperature")).toBe(
				foreign === "remove" ? undefined : foreign === "same-value" ? 0.8 : 0.4,
			);
			expect(f.settings.hasOverride("compaction.enabled")).toBe(false);
		});

	it("transfers an intact path baseline to recreated controls without resurrecting retired writes", async () => {
		const f = await fixture();
		f.settings.override("temperature", 0.2);
		await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.7 } });
		const replacement = createSdkPreferenceControls(f.session);
		try {
			await replacement.patchConfig({ scope: "session", patch: { temperature: 0.9 } });
			f.controls.dispose();
			expect(f.settings.getOverride("temperature")).toBe(0.9);
		} finally {
			replacement.dispose();
		}
		expect(f.settings.getOverride("temperature")).toBe(0.2);
	});

	it("shares path ownership across live sessions using the same Settings instance", async () => {
		const f = await fixture();
		f.settings.override("temperature", 0.2);
		await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.7 } });
		const sibling = createSession(f.settings, f.registry, SessionManager.inMemory(f.cwd));
		f.sessions.push(sibling);
		const siblingControls = createSdkPreferenceControls(sibling);
		try {
			await siblingControls.patchConfig({ scope: "session", patch: { temperature: 0.9 } });
			await f.session.newSession();
			expect(f.settings.getOverride("temperature")).toBe(0.9);
		} finally {
			siblingControls.dispose();
		}
		expect(f.settings.getOverride("temperature")).toBe(0.2);
	});

	for (const foreign of ["same-value", "remove"] as const)
		it(`captures a new baseline after foreign ${foreign} intent breaks shared ownership`, async () => {
			const f = await fixture();
			f.settings.override("temperature", 0.2);
			await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.7 } });
			if (foreign === "remove") f.settings.clearOverride("temperature");
			else f.settings.override("temperature", 0.7);
			const replacement = createSdkPreferenceControls(f.session);
			try {
				await replacement.patchConfig({ scope: "session", patch: { temperature: 0.9 } });
				f.controls.dispose();
				expect(f.settings.getOverride("temperature")).toBe(0.9);
			} finally {
				replacement.dispose();
			}
			expect(f.settings.hasOverride("temperature")).toBe(foreign !== "remove");
			expect(f.settings.getOverride("temperature")).toBe(foreign === "remove" ? undefined : 0.7);
		});

	it("restores an installed override when a settings listener synchronously retires its service", async () => {
		const f = await fixture();
		f.settings.override("temperature", 0.2);
		const cleanup = f.settings.onChanged(settingPath => {
			if (settingPath === "temperature") f.controls.dispose();
		});
		try {
			const outcome = await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.8 } });
			expect(outcome).toMatchObject({ applied: false, application: "committed-unapplied", settings: [] });
			expect(f.settings.getOverride("temperature")).toBe(0.2);
		} finally {
			cleanup();
		}
	});

	it("preserves a same-value foreign write made reentrantly during SDK publication", async () => {
		const f = await fixture();
		f.settings.override("temperature", 0.2);
		let changed = false;
		let foreignRevision: symbol | undefined;
		const cleanup = f.settings.onChanged(settingPath => {
			if (settingPath !== "temperature" || changed) return;
			changed = true;
			f.settings.override("temperature", 0.8);
			foreignRevision = f.settings.getOverrideRevision("temperature");
			f.controls.dispose();
		});
		try {
			await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.8 } });
			expect(changed).toBe(true);
			expect(f.settings.getOverride("temperature")).toBe(0.8);
			expect(f.settings.getOverrideRevision("temperature")).toBe(foreignRevision);
		} finally {
			cleanup();
		}
	});

	for (const rollback of ["failed-commit", "explicit"] as const)
		for (const foreign of ["none", "different-value", "same-value", "remove"] as const)
			it(`restores ownership after ${rollback} reload rollback and respects ${foreign} later intent`, async () => {
				const f = await fixture(true);
				f.settings.override("temperature", 0.2);
				await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.8 } });
				const ownedRevision = f.settings.getOverrideRevision("temperature");
				const configPath = path.join(f.agentDir, "config.yml");
				const text = YAML.stringify({ ...(await globalConfig(f)), compaction: { enabled: false } });
				await Bun.write(configPath, text);
				const candidate = await f.settings.stageGlobalConfigReload({ path: configPath, text, identity: text });
				let tentativeRevision: symbol | undefined;
				const commit = () => {
					expect(f.settings.get("compaction.enabled")).toBe(false);
					f.settings.override("temperature", 0.4);
					tentativeRevision = f.settings.getOverrideRevision("temperature");
					expect(tentativeRevision).not.toBe(ownedRevision);
					if (rollback === "failed-commit") throw new Error("reload commit rejected");
				};
				if (rollback === "failed-commit")
					expect(() => f.settings.publishGlobalConfigReload(candidate, commit)).toThrow("reload commit rejected");
				else {
					const publication = f.settings.publishGlobalConfigReload(candidate, commit);
					expect(f.settings.getOverride("temperature")).toBe(0.4);
					publication.rollback();
					publication.finalize();
				}
				expect(f.settings.get("compaction.enabled")).toBe(true);
				expect(f.settings.getOverride("temperature")).toBe(0.8);
				expect(f.settings.getOverrideRevision("temperature")).toBe(ownedRevision);
				if (foreign === "remove") f.settings.clearOverride("temperature");
				else if (foreign !== "none") f.settings.override("temperature", foreign === "same-value" ? 0.8 : 0.6);
				const foreignRevision = f.settings.getOverrideRevision("temperature");
				if (foreign !== "none") {
					expect(foreignRevision).not.toBe(ownedRevision);
					expect(foreignRevision).not.toBe(tentativeRevision);
				}
				f.controls.dispose();
				expect(f.settings.hasOverride("temperature")).toBe(foreign !== "remove");
				expect(f.settings.getOverride("temperature")).toBe(
					foreign === "none" ? 0.2 : foreign === "remove" ? undefined : foreign === "same-value" ? 0.8 : 0.6,
				);
				if (foreign !== "none") expect(f.settings.getOverrideRevision("temperature")).toBe(foreignRevision);
				expect(await Bun.file(configPath).text()).toBe(text);
			});

	it("retirement leaves newer global and project writes intact", async () => {
		const f = await fixture(true);
		await f.controls.patchConfig({ scope: "session", patch: { temperature: 0.9 } });
		await f.controls.patchConfig({ scope: "global", patch: { temperature: 0.4 } });
		await f.controls.patchConfig({ scope: "project", patch: { temperature: 0.6 } });
		const before = await globalConfig(f);
		const projectPath = path.join(f.cwd, ".gjc", "config.yml");
		const projectBefore = await Bun.file(projectPath).text();
		f.controls.dispose();
		expect(f.settings.hasOverride("temperature")).toBe(false);
		expect(f.settings.get("temperature")).toBe(0.4);
		expect(await globalConfig(f)).toEqual(before);
		expect(await Bun.file(projectPath).text()).toBe(projectBefore);
		const next = await Settings.loadForScope({ cwd: f.cwd, agentDir: f.agentDir });
		openedSettings.push(next);
		expect(next.get("temperature")).toBe(0.6);
	});

	it("uses canonical session and global model transactions with real persistence", async () => {
		const f = await fixture(true);
		const temporary = vi.spyOn(f.session, "setModelTemporary");
		const durable = vi.spyOn(f.session, "setDefaultModelSelection");
		const before = await globalConfig(f);
		const sessionPick = await f.controls.selectModel({
			provider: "fixture",
			modelId: "nested/second",
			scope: "session",
		});
		expect(sessionPick).toMatchObject({ scope: "session", durability: "session", applied: true });
		expect(temporary).toHaveBeenCalledWith(
			second,
			undefined,
			expect.objectContaining({ persistAsSessionDefault: true, cause: "user-selection" }),
		);
		expect(durable).not.toHaveBeenCalled();
		expect(f.session.model).toBe(second);
		expect(await globalConfig(f)).toEqual(before);
		const globalPick = await f.controls.selectModel({ provider: "fixture", modelId: "first", scope: "global" });
		expect(globalPick).toMatchObject({ scope: "global", durability: "persisted", applied: true });
		expect(durable).toHaveBeenCalledWith(
			first,
			undefined,
			expect.objectContaining({ onBeforeMutation: expect.any(Function) }),
		);
		expect((await globalConfig(f)).modelRoles).toMatchObject({ default: expect.stringContaining("fixture/first") });
		expect(f.session.model).toBe(first);
		expect(f.session.getConfiguredModelChain("default")?.[0]).toContain("fixture/first");
	});

	it("activates exact profile identities session-locally, then persists through native ownership", async () => {
		const f = await fixture(true);
		const activate = vi.spyOn(f.session, "setDefaultModelProfileForControl");
		await f.controls.setRole({ role: "critic", modelId: "fixture/nested/second" });
		const sessionPick = await f.controls.selectProfile({ name: profile.name, scope: "session" });
		expect(sessionPick).toMatchObject({
			profileId: profile.name,
			scope: "session",
			durability: "session",
			applied: true,
		});
		expect(activate).toHaveBeenLastCalledWith(profile.name, expect.objectContaining({ persistDefault: false }));
		expect(f.session.hasSessionAgentModelOverride("critic")).toBe(false);
		expect(f.controls.readRoles().roles.find(role => role.role === "planner")).toMatchObject({
			source: "profile",
			configured: "fixture/nested/second:high",
			effective: { modelId: "nested/second", thinkingLevel: Effort.High },
		});
		expect(f.settings.getGlobal("modelProfile.default")).toBeUndefined();
		const globalPick = await f.controls.selectProfile({ name: profile.name, scope: "global" });
		expect(globalPick).toMatchObject({ scope: "global", durability: "persisted", applied: true });
		expect(activate).toHaveBeenLastCalledWith(profile.name, expect.objectContaining({ persistDefault: true }));
		expect((await globalConfig(f)).modelProfile).toMatchObject({
			default: profile.name,
			ownership: { version: 1, marker: { kind: "profile", profile: profile.name } },
		});
		const concrete = await f.controls.selectModel({ provider: "fixture", modelId: "first", scope: "session" });
		expect(concrete).toMatchObject({ scope: "session", durability: "persisted", applied: true, committedVersion: 2 });
		expect(readDurableModelProfileOwnership(f.settings).marker).toEqual({ kind: "cleared" });
	});

	it("refreshes a missing qualified profile catalog once and rejects newer selection intent", async () => {
		const f = await fixture();
		vi.spyOn(f.registry, "getAll").mockReturnValue([first]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refresh = vi.spyOn(f.registry, "refresh").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const activate = vi.spyOn(f.session, "setDefaultModelProfileForControl");
		const pending = f.controls.selectProfile({ name: profile.name, scope: "session" });
		await entered.promise;
		f.session.markUserModelSelection();
		release.resolve();
		await expect(pending).rejects.toMatchObject({ code: "preference_busy" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(activate).not.toHaveBeenCalled();
		expect(f.session.getActiveModelProfile()).toBeUndefined();
	});

	it("persists global config atomically and project config without simulating live application", async () => {
		const f = await fixture(true);
		const commit = vi.spyOn(f.settings, "commitAtomicBatchWithCurrent");
		const global = await f.controls.patchConfig({
			scope: "global",
			patch: { "compaction.enabled": false, temperature: 0.4 },
		});
		expect(commit).toHaveBeenCalledTimes(1);
		expect(global).toMatchObject({
			scope: "global",
			durability: "persisted",
			applied: true,
			application: "settings",
		});
		expect(await globalConfig(f)).toMatchObject({ compaction: { enabled: false }, temperature: 0.4 });
		expect(f.settings.get("temperature")).toBe(0.4);
		const project = await f.controls.patchConfig({ scope: "project", patch: { temperature: 0.8 } });
		expect(project).toMatchObject({
			scope: "project",
			durability: "persisted",
			applied: false,
			application: "next-session",
		});
		expect(YAML.parse(await Bun.file(path.join(f.cwd, ".gjc", "config.yml")).text())).toEqual({ temperature: 0.8 });
		expect(f.settings.get("temperature")).toBe(0.4);
		expect(f.settings.getOverride("temperature")).toBeUndefined();
		const next = await Settings.loadForScope({ cwd: f.cwd, agentDir: f.agentDir });
		openedSettings.push(next);
		expect(next.get("temperature")).toBe(0.8);
		expect(next.getResolutionSnapshot().temperature.origin).toBe("project");
		expect(global.settings.map(item => item.path)).toEqual(
			expect.arrayContaining(["compaction.enabled", "temperature"]),
		);
	});

	it("refuses scopes ignored by Settings and project targets that alias global storage", async () => {
		const f = await fixture(true);
		await expect(
			f.controls.patchConfig({ scope: "project", patch: { "crashReport.upstream": false } }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await fs.rm(path.join(f.cwd, ".gjc"), { recursive: true, force: true });
		await fs.symlink(f.agentDir, path.join(f.cwd, ".gjc"), "dir");
		const before = await globalConfig(f);
		await expect(f.controls.patchConfig({ scope: "project", patch: { temperature: 0.9 } })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(await globalConfig(f)).toEqual(before);
	});

	it("snapshots inputs and serializes service calls through existing session admission", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.session, "waitForIdle").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const input = { scope: "session" as const, patch: { "compaction.enabled": false } };
		const pending = f.controls.patchConfig(input);
		await entered.promise;
		input.patch["compaction.enabled"] = true;
		await expect(f.controls.setRole({ role: "critic", modelId: null })).rejects.toMatchObject({
			code: "preference_busy",
		});
		expect(f.settings.get("compaction.enabled")).toBe(true);
		release.resolve();
		await pending;
		expect(f.settings.get("compaction.enabled")).toBe(false);
	});

	it("fences queued mutations when a successor commits and permanently retires A-B-A identities", async () => {
		const f = await fixture(true);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.session, "waitForIdle").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
		});
		const pending = f.controls.patchConfig({ scope: "global", patch: { "compaction.enabled": false } });
		await entered.promise;
		await f.session.newSession();
		release.resolve();
		await expect(pending).rejects.toBeInstanceOf(SdkPreferenceError);
		expect((await globalConfig(f)).compaction).toEqual({ enabled: true });
		expect(() => f.controls.readRoles()).toThrow(expect.objectContaining({ code: "stale_preferences" }));
		f.session.sessionManager.appendMessage({ role: "user", content: "successor", timestamp: 2 });
		await f.session.sessionManager.ensureOnDisk();
		const current = new SdkPreferenceControls(f.session);
		try {
			const original = f.session.sessionFile!;
			await f.session.sessionManager.flush();
			const copy = path.join(f.root, "copy.jsonl");
			await fs.copyFile(original, copy);
			await f.session.sessionManager.setSessionFile(copy);
			await f.session.sessionManager.setSessionFile(original);
			expect(() => current.readRoles()).toThrow(expect.objectContaining({ code: "stale_preferences" }));
		} finally {
			current.dispose();
		}
	});

	it("rejects transient transition reads without permanently retiring an unchanged identity", async () => {
		const f = await fixture();
		const lifecycle = f.session.sessionLifecycle;
		await f.session.withMcpControlAdmission(lifecycle.generation, async () => {
			expect(f.session.sessionLifecycle.transitioning).toBe(true);
			expect(() => f.controls.readRoles()).toThrow(expect.objectContaining({ code: "preference_busy" }));
			await expect(
				f.controls.patchConfig({ scope: "session", patch: { "compaction.enabled": false } }),
			).rejects.toMatchObject({ code: "preference_busy" });
		});
		expect(f.session.sessionLifecycle).toMatchObject({ generation: lifecycle.generation, transitioning: false });
		expect(f.settings.get("compaction.enabled")).toBe(true);
		expect(f.controls.readRoles().roles.find(role => role.role === "executor")?.source).toBe("global");
	});

	it("does not resume stale role intent after a newer selection during model resolution", async () => {
		const f = await fixture();
		const select = vi.spyOn(f.session, "setSessionAgentModelSelection");
		const pending = f.controls.setRole({ role: "critic", modelId: "fixture/nested/second" });
		f.session.markUserModelSelection();
		await expect(pending).rejects.toMatchObject({ code: "preference_busy" });
		expect(select).not.toHaveBeenCalled();
	});

	it("retains committed profile outcomes and redacts the failed application cause", async () => {
		const f = await fixture(true);
		const activate = f.session.setDefaultModelProfileForControl.bind(f.session);
		vi.spyOn(f.session, "setDefaultModelProfileForControl").mockImplementation((name, options) =>
			activate(name, {
				...options,
				onAfterActivation: () => {
					throw new Error("secret failed endpoint https://user:password@example.invalid");
				},
			}),
		);
		const result = await f.controls.selectProfile({ name: profile.name, scope: "global" });
		expect(result).toMatchObject({
			scope: "global",
			durability: "persisted",
			applied: false,
			application: "committed-unapplied",
			committedVersion: 1,
		});
		expect((await globalConfig(f)).modelProfile).toMatchObject({ default: profile.name });
		expect(JSON.stringify(result)).not.toContain("password");
		expect(JSON.stringify(result)).not.toContain("endpoint");
	});

	it("returns the native default-selection recovery outcome rather than claiming rollback or success", async () => {
		const f = await fixture(true);
		vi.spyOn(f.session.sessionManager, "promoteDefaultModelSelection").mockReturnValue({
			kind: "not_promoted",
			error: new Error("private storage failure"),
		});
		const result = await f.controls.selectModel({ provider: "fixture", modelId: "nested/second", scope: "global" });
		expect(result).toMatchObject({
			applied: false,
			application: "recovery-required",
			recovery: { rollback: { disposition: "restored" } },
		});
		expect(JSON.stringify(result)).not.toContain("private storage");
		expect(f.session.model).toBe(first);
	});

	it("reports a config commit as persisted-but-unapplied when publication retires its requester", async () => {
		const f = await fixture(true);
		const cleanup = f.settings.onChanged(settingPath => {
			if (settingPath === "compaction.enabled") f.controls.dispose();
		});
		try {
			const result = await f.controls.patchConfig({ scope: "global", patch: { "compaction.enabled": false } });
			expect(result).toMatchObject({
				durability: "persisted",
				applied: false,
				application: "committed-unapplied",
				settings: [],
			});
			expect((await globalConfig(f)).compaction).toEqual({ enabled: false });
		} finally {
			cleanup();
		}
	});

	it("does not mistake an unconfirmed post-commit failure for an uncommitted write", async () => {
		const f = await fixture(true);
		const commit = f.settings.commitAtomicBatchWithCurrent.bind(f.settings);
		vi.spyOn(f.settings, "commitAtomicBatchWithCurrent").mockImplementationOnce(async build => {
			const receipt = await commit(build);
			receipt.discard();
			throw new Error("private post-commit publication failure");
		});
		const result = await f.controls.patchConfig({ scope: "global", patch: { temperature: 0.6 } });
		expect(result).toMatchObject({ durability: "unknown", applied: false, application: "recovery-required" });
		expect((await globalConfig(f)).temperature).toBe(0.6);
		expect(JSON.stringify(result)).not.toContain("private post-commit");
	});

	it("does not expose arbitrary persistence failures", async () => {
		const f = await fixture(true);
		vi.spyOn(f.settings, "commitAtomicBatchWithCurrent").mockRejectedValueOnce(
			new Error("/private/path credential=hidden"),
		);
		const result = await f.controls.patchConfig({ scope: "global", patch: { temperature: 0.5 } });
		expect(result).toMatchObject({
			durability: "unknown",
			applied: false,
			application: "recovery-required",
			failure: { code: "preference_failed", message: "The preference write outcome could not be confirmed." },
		});
		expect(JSON.stringify(result)).not.toContain("private/path");
		expect(JSON.stringify(result)).not.toContain("hidden");
		expect((await globalConfig(f)).temperature).toBeUndefined();
	});
});
