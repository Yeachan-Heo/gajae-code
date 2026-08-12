import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import type { ScopedConfigurationMutationService } from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent, WorkModePreviewResult } from "../src/config/work-mode-result";
import { type WorkModeSessionRuntime, WorkModeTransaction } from "../src/config/work-mode-transaction";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	registry: ModelRegistry;
	transaction: WorkModeTransaction;
	events: WorkModeOperationEvent[];
}>;

type FixtureOptions = Readonly<{
	hideLunaModels?: boolean;
	withScopedMutation?: boolean;
}>;

const fixtures: Fixture[] = [];

afterEach(() => {
	while (fixtures.length > 0) fixtures.pop()?.authStorage.close();
});

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-receipt-test-key");
	const registry = new ModelRegistry(authStorage);
	const originalModels = [...registry.getAll()];
	if (options.hideLunaModels) registry.getAll = () => originalModels.filter(model => model.id !== "gpt-5.6-luna");
	const initialModel = originalModels[0];
	if (!initialModel) throw new Error("Expected a bundled model for the Work Mode receipt fixture");

	const settings = Settings.isolated({
		modelRoles: {},
		"task.agentModelOverrides": {},
		"modelProfile.default": "before-work-mode",
	});
	const configuredChains = new Map<string, readonly string[]>();
	let activeProfile: string | undefined;
	const session: WorkModeSessionRuntime = {
		sessionId: "work-mode-receipt-session",
		model: initialModel,
		thinkingLevel: undefined,
		setModelTemporary: async () => {},
		beginTemporaryProviderSessionScope: () => ({ reason: "work-mode-turn" }),
		restoreTemporaryProviderSessionScope: () => true,
		setActiveModelProfile: profileName => {
			activeProfile = profileName;
		},
		getActiveModelProfile: () => activeProfile,
		getConfiguredModelChain: role => configuredChains.get(role),
		setConfiguredModelChain: (role, entries) => {
			configuredChains.set(role, [...entries]);
		},
	};
	const events: WorkModeOperationEvent[] = [];
	const scopedMutationService: Pick<ScopedConfigurationMutationService, "mutate"> | undefined =
		options.withScopedMutation
			? {
					mutate: async request => ({
						status: "committed",
						reason: null,
						scope: request.scope,
						safePath: null,
						beforeRevision: null,
						afterRevision: "1",
						beforeDigest: null,
						afterDigest: "digest",
						timing: "current_runtime",
						confirmation: "confirmed",
						durability: "committed",
						patches: [{ op: "set", path: "modelProfile.default" }],
					}),
				}
			: undefined;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry: registry,
		settings,
		scopedMutationService,
		now: () => 1234,
		operationId: () => "work-mode-receipt-operation",
		receiptId: (() => {
			let sequence = 0;
			return () => `work-mode-receipt-${++sequence}`;
		})(),
		turnLeaseId: () => "work-mode-receipt-lease",
		emit: event => events.push(event),
	});
	const fixture = { authStorage, registry, transaction, events } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

function requireDegradedPreview(preview: WorkModePreviewResult): Extract<WorkModePreviewResult, { state: "degraded" }> {
	expect(preview.state).toBe("degraded");
	if (preview.state !== "degraded") throw new Error("Expected a degraded Work Mode preview");
	return preview;
}

describe("Work Mode operation receipt confirmation", () => {
	test("records rejected degraded confirmation as false", async () => {
		const fixture = await createFixture({ hideLunaModels: true });
		const preview = requireDegradedPreview(await fixture.transaction.preview("quick-edit"));

		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "session",
			confirmationAccepted: false,
			operationId: "receipt-rejected-degraded",
		});

		expect(event.state).toBe("unavailable");
		expect(event.receipt.confirmation).toEqual({ required: true, accepted: false });
	});

	test("records accepted degraded confirmation only for an accepted session request", async () => {
		const fixture = await createFixture({ hideLunaModels: true });
		const preview = requireDegradedPreview(await fixture.transaction.preview("quick-edit"));

		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "session",
			confirmationAccepted: true,
			operationId: "receipt-accepted-session",
		});

		expect(event.state).toBe("degraded");
		expect(event.receipt.confirmation).toEqual({ required: true, accepted: true });
	});

	test("records accepted degraded confirmation for persistent, staged, and admitted turn requests", async () => {
		const persistentFixture = await createFixture({ hideLunaModels: true, withScopedMutation: true });
		const persistentPreview = requireDegradedPreview(await persistentFixture.transaction.preview("quick-edit"));
		const persistent = await persistentFixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: persistentPreview,
			scope: "project",
			confirmationAccepted: true,
			operationId: "receipt-accepted-persistent",
		});
		expect(persistent.state).toBe("degraded");
		expect(persistent.receipt.confirmation).toEqual({ required: true, accepted: true });

		const turnFixture = await createFixture({ hideLunaModels: true });
		const turnPreview = requireDegradedPreview(await turnFixture.transaction.preview("quick-edit"));
		const staged = await turnFixture.transaction.stageTurn({
			modeId: "quick-edit",
			acceptedPreview: turnPreview,
			scope: "turn",
			confirmationAccepted: true,
			operationId: "receipt-accepted-turn",
		});
		expect(staged.state).toBe("degraded");
		expect(staged.receipt.confirmation).toEqual({ required: true, accepted: true });
		const stagedTurn = turnFixture.transaction.getStagedTurn("receipt-accepted-turn");
		if (!stagedTurn) throw new Error("Expected a staged turn");
		const admission = await turnFixture.transaction.admitTurn(stagedTurn, {
			admissionTokenId: "receipt-accepted-token",
			rootLogicalRunId: "receipt-accepted-root",
			targetGeneration: 0,
		});
		expect(admission.state).toBe("degraded");
		expect(admission.receipt.confirmation).toEqual({ required: true, accepted: true });
		await turnFixture.transaction.finalizeTurn("receipt-accepted-turn", "completed");
	});

	test("keeps nondegraded receipt confirmation accepted without a request flag", async () => {
		const fixture = await createFixture();
		const preview = await fixture.transaction.preview("quick-edit");
		expect(preview.state).toBe("ready");
		if (preview.state !== "ready") throw new Error("Expected a ready Work Mode preview");

		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "session",
			operationId: "receipt-ready-session",
		});

		expect(event.receipt.confirmation).toEqual({ required: false, accepted: true });
	});
});
