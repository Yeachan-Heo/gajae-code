import { expect, test } from "bun:test";
import { AuthStorage } from "@gajae-code/ai";
import { BUILTIN_MODEL_PROFILES, type ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { type WorkModeSessionRuntime, WorkModeTransaction } from "../src/config/work-mode-transaction";

interface MutationCounters {
	setModelTemporary: number;
	setConfiguredModelChain: number;
	setActiveModelProfile: number;
}

interface PreviewFixture {
	authStorage: AuthStorage;
	registry: ModelRegistry;
	settings: Settings;
	session: WorkModeSessionRuntime;
	transaction: WorkModeTransaction;
	counters: MutationCounters;
	events: WorkModeOperationEvent[];
}

interface FixtureOptions {
	authenticated?: boolean;
	profileMap?: ReadonlyMap<string, ModelProfileDefinition>;
	hideLunaModels?: boolean;
}

async function createPreviewFixture(options: FixtureOptions = {}): Promise<PreviewFixture> {
	const authStorage = await AuthStorage.create(":memory:");
	if (options.authenticated !== false) authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	const registry = new ModelRegistry(authStorage);
	const originalModels = [...registry.getAll()];
	const profileMap = options.profileMap ?? registry.getModelProfiles();
	registry.getModelProfiles = () => new Map(profileMap);
	registry.getModelProfile = name => profileMap.get(name);
	if (options.hideLunaModels) {
		registry.getAll = () => originalModels.filter(model => model.id !== "gpt-5.6-luna");
	}

	const initialModel = originalModels[0];
	if (!initialModel) throw new Error("Expected at least one bundled model for the typed session fake");
	const counters: MutationCounters = {
		setModelTemporary: 0,
		setConfiguredModelChain: 0,
		setActiveModelProfile: 0,
	};
	const configuredChains = new Map<string, readonly string[]>();
	let activeProfile: string | undefined;
	const session: WorkModeSessionRuntime = {
		sessionId: "work-mode-preview-session",
		model: initialModel,
		thinkingLevel: undefined,
		setModelTemporary: async () => {
			counters.setModelTemporary += 1;
		},
		beginTemporaryProviderSessionScope: () => ({ reason: "plan-mode" }),
		restoreTemporaryProviderSessionScope: () => true,
		setActiveModelProfile: profileName => {
			counters.setActiveModelProfile += 1;
			activeProfile = profileName;
		},
		getActiveModelProfile: () => activeProfile,
		getConfiguredModelChain: role => configuredChains.get(role),
		setConfiguredModelChain: (role, entries) => {
			counters.setConfiguredModelChain += 1;
			configuredChains.set(role, [...entries]);
		},
	};
	const settings = Settings.isolated({
		modelRoles: {},
		"task.agentModelOverrides": {},
		"modelProfile.default": "before-preview",
	});
	const events: WorkModeOperationEvent[] = [];
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry: registry,
		settings,
		now: () => 1234,
		operationId: () => "work-mode-preview-operation",
		receiptId: () => "work-mode-preview-receipt",
		emit: event => events.push(event),
	});
	return { authStorage, registry, settings, session, transaction, counters, events };
}

function closeFixture(fixture: PreviewFixture): void {
	fixture.authStorage.close();
}

test("ready preview is observational: it mutates no session/settings state and emits no receipt", async () => {
	const fixture = await createPreviewFixture();
	try {
		const beforeModel = fixture.session.model;
		const beforeThinking = fixture.session.thinkingLevel;
		const beforeRoles = fixture.settings.get("modelRoles");
		const beforeOverrides = fixture.settings.get("task.agentModelOverrides");
		const beforeDefault = fixture.settings.get("modelProfile.default");

		const preview = await fixture.transaction.preview("quick-edit");

		expect(preview.state).toBe("ready");
		if (preview.state !== "ready") throw new Error("Expected a ready Work Mode preview");
		expect(preview.phase).toBe("preview");
		expect(preview.facts.profileId).toBe("codex-eco");
		expect(preview.fingerprint.schema).toBe("work-mode-fingerprint.v1");
		expect(preview.fingerprint.digest).not.toBe("");
		expect(preview.fingerprint.payload.catalog).toEqual(
			expect.objectContaining({
				presence: "present",
				value: expect.objectContaining({ modeId: "quick-edit", profileId: "codex-eco" }),
			}),
		);
		expect(preview.fingerprint.payload.bundledDefinition).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.effectiveDefinition).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.readiness).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.roles).toHaveLength(5);
		expect(preview.fingerprint.payload.roles.every(role => role.presence === "present")).toBe(true);
		expect(preview.fingerprint.payload.fallback).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.confirmation).toEqual({ required: false, roleDegradation: [] });
		expect(preview.confirmationRequired).toBe(false);
		expect("receipt" in preview).toBe(false);
		expect(fixture.counters).toEqual({ setModelTemporary: 0, setConfiguredModelChain: 0, setActiveModelProfile: 0 });
		expect(fixture.session.model).toBe(beforeModel);
		expect(fixture.session.thinkingLevel).toBe(beforeThinking);
		expect(fixture.settings.get("modelRoles")).toEqual(beforeRoles);
		expect(fixture.settings.get("task.agentModelOverrides")).toEqual(beforeOverrides);
		expect(fixture.settings.get("modelProfile.default")).toBe(beforeDefault);
		expect(fixture.events).toEqual([]);
	} finally {
		closeFixture(fixture);
	}
});

test("a configured shadow is an unavailable preflight result and still performs no mutation", async () => {
	const profiles = new Map(BUILTIN_MODEL_PROFILES.map(profile => [profile.name, profile]));
	const bundled = profiles.get("codex-medium");
	if (!bundled) throw new Error("Missing bundled codex-medium profile");
	profiles.set("codex-medium", { ...bundled, source: "user" });
	const fixture = await createPreviewFixture({ profileMap: profiles });
	try {
		const preview = await fixture.transaction.preview("daily-coding");
		expect(preview).toMatchObject({ phase: "preview", state: "unavailable", reason: "curated_profile_shadowed" });
		if (preview.state !== "unavailable") throw new Error("Expected an unavailable Work Mode preview");
		expect(preview.reason).toBe("curated_profile_shadowed");
		expect(preview.fingerprint.schema).toBe("work-mode-fingerprint.v1");
		expect(preview.fingerprint.digest).not.toBe("");
		expect(preview.fingerprint.payload.effectiveDefinition).toEqual({
			presence: "missing",
			reason: "curated_profile_shadowed",
		});
		expect("facts" in preview).toBe(false);
		expect(fixture.counters).toEqual({ setModelTemporary: 0, setConfiguredModelChain: 0, setActiveModelProfile: 0 });
		expect(fixture.events).toEqual([]);
	} finally {
		closeFixture(fixture);
	}
});

test("missing required credentials produce one stable unavailable preflight reason", async () => {
	const fixture = await createPreviewFixture({ authenticated: false });
	try {
		const preview = await fixture.transaction.preflight("quick-edit");
		expect(preview).toMatchObject({
			phase: "preview",
			state: "unavailable",
			reason: "required_provider_unauthenticated",
		});
		if (preview.state !== "unavailable") throw new Error("Expected an unavailable Work Mode preview");
		expect(preview.reason).toBe("required_provider_unauthenticated");
		expect(preview.fingerprint.schema).toBe("work-mode-fingerprint.v1");
		expect(preview.fingerprint.digest).not.toBe("");
		expect(preview.fingerprint.payload.readiness).toEqual({
			presence: "unavailable",
			reason: "provider_readiness_unavailable",
		});
		expect(fixture.counters).toEqual({ setModelTemporary: 0, setConfiguredModelChain: 0, setActiveModelProfile: 0 });
		expect(fixture.events).toEqual([]);
	} finally {
		closeFixture(fixture);
	}
});

test("an unresolved non-default role is an eligible degraded preview requiring confirmation", async () => {
	const fixture = await createPreviewFixture({ hideLunaModels: true });
	try {
		const preview = await fixture.transaction.preview("quick-edit");
		expect(preview.state).toBe("degraded");
		if (preview.state !== "degraded") throw new Error("Expected a degraded Work Mode preview");
		expect(preview.confirmationRequired).toBe(true);
		expect(preview.fingerprint.schema).toBe("work-mode-fingerprint.v1");
		expect(preview.fingerprint.digest).not.toBe("");
		expect(preview.fingerprint.payload.catalog).toEqual(
			expect.objectContaining({
				presence: "present",
				value: expect.objectContaining({ modeId: "quick-edit", profileId: "codex-eco" }),
			}),
		);
		expect(preview.fingerprint.payload.bundledDefinition).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.effectiveDefinition).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.readiness).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.roles).toHaveLength(5);
		expect(preview.fingerprint.payload.roles.every(role => role.presence === "present")).toBe(true);
		expect(preview.fingerprint.payload.fallback).toEqual(expect.objectContaining({ presence: "present" }));
		expect(preview.fingerprint.payload.confirmation).toEqual({
			required: true,
			roleDegradation: ["executor", "planner"],
		});
		expect(preview.roleReadiness.kind).toBe("degraded");
		if (preview.roleReadiness.kind !== "degraded") throw new Error("Expected a degraded role-readiness result");
		expect(preview.roleReadiness.unresolved.map(role => role.role)).toEqual(["executor", "planner"]);
		expect("reason" in preview).toBe(false);
		expect(fixture.counters).toEqual({ setModelTemporary: 0, setConfiguredModelChain: 0, setActiveModelProfile: 0 });
		expect(fixture.events).toEqual([]);
	} finally {
		closeFixture(fixture);
	}
});

test("unknown mode ids fail closed with a bounded unavailable preview", async () => {
	const fixture = await createPreviewFixture();
	try {
		const preview = await fixture.transaction.preview("not-a-curated-mode");
		expect(preview).toMatchObject({ phase: "preview", state: "unavailable", reason: "unknown_work_mode" });
		if (preview.state !== "unavailable") throw new Error("Expected an unavailable Work Mode preview");
		expect(preview.reason).toBe("unknown_work_mode");
		expect(preview.fingerprint.schema).toBe("work-mode-fingerprint.v1");
		expect(preview.fingerprint.digest).not.toBe("");
		expect(preview.fingerprint.payload.catalog).toEqual({
			presence: "missing",
			reason: "unknown_work_mode",
		});
		expect(fixture.counters).toEqual({ setModelTemporary: 0, setConfiguredModelChain: 0, setActiveModelProfile: 0 });
		expect(fixture.events).toEqual([]);
	} finally {
		closeFixture(fixture);
	}
});
