import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, AuthCredentialSelector, Model } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import type {
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationService,
} from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionResult, WorkModePreviewResult } from "../src/config/work-mode-result";
import { type WorkModeSessionRuntime, WorkModeTransaction } from "../src/config/work-mode-transaction";
import { AuthStorage } from "../src/session/auth-storage";

const MODE_ID = "quick-edit" as const;

type EffectCounters = {
	profileReads: number;
	apiKeyReads: number;
	setModelTemporary: number;
	beginProviderScope: number;
	restoreProviderScope: number;
	setActiveModelProfile: number;
	setConfiguredModelChain: number;
	mutations: number;
};

type ApplicationHarness = {
	transaction: WorkModeTransaction;
	settings: Settings;
	session: WorkModeSessionRuntime;
	counters: EffectCounters;
	setAuthDrifted: (drifted: boolean) => void;
};

function requireInitialModel(modelRegistry: ModelRegistry): Model<Api> {
	const model = modelRegistry
		.getAll()
		.find(candidate => candidate.provider === "openai-codex" && candidate.id === "gpt-5.6-terra");
	if (!model) throw new Error("The bundled openai-codex gpt-5.6-terra model is required for Work Mode tests");
	return model;
}

function createSession(model: Model<Api>, counters: EffectCounters): WorkModeSessionRuntime {
	const configuredModelChains = new Map<string, readonly string[]>();
	let activeModelProfile: string | undefined;

	return {
		sessionId: "work-mode-application-test",
		model,
		thinkingLevel: ThinkingLevel.Low,
		setModelTemporary: async () => {
			counters.setModelTemporary += 1;
		},
		beginTemporaryProviderSessionScope: reason => {
			counters.beginProviderScope += 1;
			return { reason };
		},
		restoreTemporaryProviderSessionScope: () => {
			counters.restoreProviderScope += 1;
			return true;
		},
		setActiveModelProfile: name => {
			counters.setActiveModelProfile += 1;
			activeModelProfile = name;
		},
		getActiveModelProfile: () => activeModelProfile,
		getConfiguredModelChain: role => configuredModelChains.get(role),
		setConfiguredModelChain: (role, entries) => {
			counters.setConfiguredModelChain += 1;
			configuredModelChains.set(role, [...entries]);
		},
	};
}

async function makeHarness(): Promise<ApplicationHarness> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated();
	const counters: EffectCounters = {
		profileReads: 0,
		apiKeyReads: 0,
		setModelTemporary: 0,
		beginProviderScope: 0,
		restoreProviderScope: 0,
		setActiveModelProfile: 0,
		setConfiguredModelChain: 0,
		mutations: 0,
	};
	const session = createSession(requireInitialModel(modelRegistry), counters);
	let authDrifted = false;

	const originalGetModelProfiles = modelRegistry.getModelProfiles.bind(modelRegistry);
	modelRegistry.getModelProfiles = () => {
		counters.profileReads += 1;
		return originalGetModelProfiles();
	};

	const originalGetApiKeyForProvider = modelRegistry.getApiKeyForProvider.bind(modelRegistry);
	modelRegistry.getApiKeyForProvider = async (
		provider: string,
		sessionId?: string,
		baseUrl?: string,
		options: { credentialSelector?: AuthCredentialSelector; signal?: AbortSignal } = {},
	) => {
		counters.apiKeyReads += 1;
		if (authDrifted) return undefined;
		return await originalGetApiKeyForProvider(provider, sessionId, baseUrl, options);
	};

	const scopedMutationService: Pick<ScopedConfigurationMutationService, "mutate"> = {
		mutate: async (): Promise<ScopedConfigurationMutationReceipt> => {
			counters.mutations += 1;
			throw new Error("mutation must not run during preview drift");
		},
	};
	let receiptIndex = 0;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings,
		scopedMutationService,
		now: () => 1_000,
		operationId: () => "work-mode-application-operation",
		receiptId: () => `work-mode-application-receipt-${++receiptIndex}`,
		turnLeaseId: () => "work-mode-application-lease",
	});

	return {
		transaction,
		settings,
		session,
		counters,
		setAuthDrifted: drifted => {
			authDrifted = drifted;
		},
	};
}

async function preview(harness: ApplicationHarness): Promise<WorkModePreviewResult> {
	const result = await harness.transaction.preview(MODE_ID);
	expect(result.state).toBe("ready");
	return result;
}
function expectPreviewDrift(
	event: WorkModeExecutionResult,
	phase: "session_apply" | "persistent_apply" | "turn_stage",
) {
	expect(event.phase).toBe(phase);
	expect(event.state).toBe("drifted");
	expect(event.relation.kind).toBe("changed");
	expect(event.durable).toEqual({ kind: "not_requested" });
	expect(event.runtime).toEqual({ kind: "rejected", code: "preview_drift" });
	if (!("rePreview" in event)) throw new Error("preview drift must return a re-preview");
	expect(event.rePreview.phase).toBe("preview");
	expect(event.rePreview.fingerprint.digest).not.toBe(event.acceptedFingerprint.digest);
	return event.rePreview;
}

describe("Work Mode application preflight fence", () => {
	test("session apply re-preflights and refuses activation when provider readiness drifts", async () => {
		const harness = await makeHarness();
		const acceptedPreview = await preview(harness);
		const profileReadsBeforeApply = harness.counters.profileReads;
		const apiKeyReadsBeforeApply = harness.counters.apiKeyReads;
		harness.setAuthDrifted(true);

		const event = await harness.transaction.apply({
			modeId: MODE_ID,
			acceptedPreview,
			scope: "session",
			operationId: "session-apply-drift",
		});

		expectPreviewDrift(event, "session_apply");
		expect(harness.counters.profileReads).toBeGreaterThan(profileReadsBeforeApply);
		expect(harness.counters.apiKeyReads).toBeGreaterThan(apiKeyReadsBeforeApply);
		expect(harness.counters.setModelTemporary).toBe(0);
		expect(harness.counters.beginProviderScope).toBe(0);
		expect(harness.counters.setConfiguredModelChain).toBe(0);
		expect(harness.counters.setActiveModelProfile).toBe(0);
	});

	test("project apply compares the fresh fingerprint before invoking the durable mutation seam", async () => {
		const harness = await makeHarness();
		const acceptedPreview = await preview(harness);
		const profileReadsBeforeApply = harness.counters.profileReads;
		const apiKeyReadsBeforeApply = harness.counters.apiKeyReads;
		harness.setAuthDrifted(true);

		const event = await harness.transaction.apply({
			modeId: MODE_ID,
			acceptedPreview,
			scope: "project",
			operationId: "project-apply-drift",
		});

		expectPreviewDrift(event, "persistent_apply");
		expect(harness.counters.profileReads).toBeGreaterThan(profileReadsBeforeApply);
		expect(harness.counters.apiKeyReads).toBeGreaterThan(apiKeyReadsBeforeApply);
		expect(harness.counters.mutations).toBe(0);
		expect(harness.settings.get("modelProfile.default")).toBeUndefined();
	});

	test("user apply compares the fresh fingerprint before invoking the durable mutation seam", async () => {
		const harness = await makeHarness();
		const acceptedPreview = await preview(harness);
		const profileReadsBeforeApply = harness.counters.profileReads;
		const apiKeyReadsBeforeApply = harness.counters.apiKeyReads;
		harness.setAuthDrifted(true);

		const event = await harness.transaction.apply({
			modeId: MODE_ID,
			acceptedPreview,
			scope: "user",
			operationId: "user-apply-drift",
		});

		expectPreviewDrift(event, "persistent_apply");
		expect(harness.counters.profileReads).toBeGreaterThan(profileReadsBeforeApply);
		expect(harness.counters.apiKeyReads).toBeGreaterThan(apiKeyReadsBeforeApply);
		expect(harness.counters.mutations).toBe(0);
		expect(harness.settings.get("modelProfile.default")).toBeUndefined();
	});

	test("turn staging compares the fresh fingerprint before creating a staged turn", async () => {
		const harness = await makeHarness();
		const acceptedPreview = await preview(harness);
		const profileReadsBeforeApply = harness.counters.profileReads;
		const apiKeyReadsBeforeApply = harness.counters.apiKeyReads;
		harness.setAuthDrifted(true);

		const event = await harness.transaction.stageTurn({
			modeId: MODE_ID,
			acceptedPreview,
			scope: "turn",
			operationId: "turn-stage-drift",
			targetEligibleUserAdmissionGeneration: 7,
		});

		expectPreviewDrift(event, "turn_stage");
		expect(harness.counters.profileReads).toBeGreaterThan(profileReadsBeforeApply);
		expect(harness.counters.apiKeyReads).toBeGreaterThan(apiKeyReadsBeforeApply);
		expect(harness.transaction.getStagedTurn("turn-stage-drift")).toBeUndefined();
		expect(harness.counters.mutations).toBe(0);
	});

	test("preview drift requires a new preview before a later session effect can proceed", async () => {
		const harness = await makeHarness();
		const acceptedPreview = await preview(harness);
		harness.setAuthDrifted(true);

		const drifted = await harness.transaction.apply({
			modeId: MODE_ID,
			acceptedPreview,
			scope: "session",
			operationId: "restage-after-drift",
		});
		const driftPreview = expectPreviewDrift(drifted, "session_apply");

		const staleRetry = await harness.transaction.apply({
			modeId: MODE_ID,
			acceptedPreview,
			scope: "session",
			operationId: "stale-retry-after-drift",
		});
		expectPreviewDrift(staleRetry, "session_apply");
		expect(harness.counters.setModelTemporary).toBe(0);

		harness.setAuthDrifted(false);
		const refreshedPreview = await preview(harness);
		expect(refreshedPreview.fingerprint.digest).toBe(acceptedPreview.fingerprint.digest);
		expect(driftPreview.state).toBe("unavailable");
		expect(harness.settings.get("modelProfile.default")).toBeUndefined();

		const applied = await harness.transaction.apply({
			modeId: MODE_ID,
			acceptedPreview: refreshedPreview,
			scope: "session",
			operationId: "fresh-preview-apply",
		});
		expect(applied.phase).toBe("session_apply");
		expect(applied.state).toBe("ready");
		expect(applied.runtime).toEqual({ kind: "applied" });
		expect(harness.counters.setModelTemporary).toBe(1);
		expect(harness.settings.get("modelProfile.default")).toBeUndefined();
	});
});
