import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import type {
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationRequest,
	ScopedConfigurationMutationService,
} from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import { WorkModeTransaction } from "../src/config/work-mode-transaction";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const fixtures: Array<{ session: AgentSession; authStorage: AuthStorage }> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

function receipt(
	scope: "project" | "user",
	status: ScopedConfigurationMutationReceipt["status"],
	confirmation: ScopedConfigurationMutationReceipt["confirmation"],
	durability: ScopedConfigurationMutationReceipt["durability"],
	reason: ScopedConfigurationMutationReceipt["reason"] = null,
): ScopedConfigurationMutationReceipt {
	return {
		status,
		reason,
		scope,
		safePath: `/scoped/${scope}/config.yml`,
		beforeRevision: "before-revision",
		afterRevision: "after-revision",
		beforeDigest: "before-digest",
		afterDigest: "after-digest",
		timing: "next_session",
		confirmation,
		durability,
		patches: [{ op: "set", path: "modelProfile.default" }],
	};
}

async function createFixture(
	options: { receipt?: (scope: "project" | "user") => ScopedConfigurationMutationReceipt; withWriter?: boolean } = {},
): Promise<{
	authStorage: AuthStorage;
	session: AgentSession;
	modelRegistry: ModelRegistry;
	transaction: WorkModeTransaction;
	requests: ScopedConfigurationMutationRequest[];
}> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model in the test registry");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	fixtures.push({ session, authStorage });
	const requests: ScopedConfigurationMutationRequest[] = [];
	const scopedMutationService: Pick<ScopedConfigurationMutationService, "mutate"> | undefined =
		options.withWriter === false
			? undefined
			: {
					mutate: async request => {
						requests.push(request);
						const scope = request.scope;
						if (scope !== "project" && scope !== "user")
							throw new Error("Expected a project or user mutation request");
						return options.receipt?.(scope) ?? receipt(scope, "committed", "confirmed", "committed");
					},
				};
	let receiptIndex = 0;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings: session.settings,
		scopedMutationService,
		receiptId: () => `persistent-application-receipt-${++receiptIndex}`,
		now: () => 100,
	});
	return { authStorage, session, modelRegistry, transaction, requests };
}

async function readyPreview(transaction: WorkModeTransaction) {
	const preview = await transaction.preview("quick-edit");
	if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
	return preview;
}

describe("Work Mode persistent application", () => {
	test("project scope writes only modelProfile.default through the injected writer with owner and next-session timing", async () => {
		const fixture = await createFixture();
		const expectedOwner = { identity: "project-owner", revision: "7", digest: "project-digest" };
		const preview = await readyPreview(fixture.transaction);
		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "project",
			expectedOwner,
			operationId: "project-persistent-application",
		});

		const request = fixture.requests[0];
		if (!request) throw new Error("Expected one project mutation request");
		expect(request.scope).toBe("project");
		expect(request.patches).toEqual([{ op: "set", path: "modelProfile.default", value: "codex-eco" }]);
		expect(request.expectedOwner).toEqual(expectedOwner);
		expect(request.runtime).toBeUndefined();
		expect(request.runtimePhase).toBeUndefined();
		expect(event.caseId).toBe("persistent_apply.ready.committed");
		if (event.caseId !== "persistent_apply.ready.committed")
			throw new Error(`Unexpected Work Mode case: ${event.caseId}`);
		expect(event.durable.kind).toBe("committed");
		if (event.durable.kind !== "committed") throw new Error(`Unexpected durable status: ${event.durable.kind}`);
		expect(event.durable.scopedReceipt.timing).toBe("next_session");
		expect(event.runtime).toEqual({ kind: "not_requested" });
	});

	test("user scope writes only modelProfile.default through the injected writer with owner and next-session timing", async () => {
		const fixture = await createFixture();
		const expectedOwner = { identity: "user-owner", revision: "11", digest: "user-digest" };
		const preview = await readyPreview(fixture.transaction);
		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "user",
			expectedOwner,
			operationId: "user-persistent-application",
		});

		const request = fixture.requests[0];
		if (!request) throw new Error("Expected one user mutation request");
		expect(request.scope).toBe("user");
		expect(request.patches).toEqual([{ op: "set", path: "modelProfile.default", value: "codex-eco" }]);
		expect(request.expectedOwner).toEqual(expectedOwner);
		expect(request.patches).toHaveLength(1);
		expect(event.caseId).toBe("persistent_apply.ready.committed");
		if (event.caseId !== "persistent_apply.ready.committed")
			throw new Error(`Unexpected Work Mode case: ${event.caseId}`);
		expect(event.durable.kind).toBe("committed");
		if (event.durable.kind !== "committed") throw new Error(`Unexpected durable status: ${event.durable.kind}`);
		expect(event.durable.scopedReceipt.timing).toBe("next_session");
	});

	test("committed-unconfirmed remains distinct from committed", async () => {
		const fixture = await createFixture({
			receipt: scope =>
				receipt(scope, "committed", "unconfirmed", "committed_unconfirmed", "persistent_reload_unconfirmed"),
		});
		const preview = await readyPreview(fixture.transaction);
		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "project",
			operationId: "persistent-committed-unconfirmed",
		});

		expect(event.caseId).toBe("persistent_apply.ready.committed_unconfirmed");
		if (event.caseId !== "persistent_apply.ready.committed_unconfirmed")
			throw new Error(`Unexpected Work Mode case: ${event.caseId}`);
		expect(event.state).toBe("ready");
		expect(event.durable).toMatchObject({
			kind: "committed_unconfirmed",
			code: "persistent_reload_unconfirmed",
		});
		expect(event.durable.kind).not.toBe("committed");
		if (event.durable.kind !== "committed_unconfirmed")
			throw new Error(`Unexpected durable status: ${event.durable.kind}`);
		expect(event.durable.scopedReceipt.confirmation).toBe("unconfirmed");
		expect(event.durable.scopedReceipt.durability).toBe("committed_unconfirmed");
	});

	test("writer conflict is reported as rejected durable state without runtime activation", async () => {
		const fixture = await createFixture({
			receipt: scope => receipt(scope, "conflict", "not_applicable", "none", "scope_conflict"),
		});
		const preview = await readyPreview(fixture.transaction);
		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "project",
			operationId: "persistent-conflict",
		});

		expect(event.caseId).toBe("persistent_apply.unavailable.mutation");
		if (event.caseId !== "persistent_apply.unavailable.mutation")
			throw new Error(`Unexpected Work Mode case: ${event.caseId}`);
		expect(event.state).toBe("unavailable");
		expect(event.durable.kind).toBe("conflict");
		if (event.durable.kind !== "conflict") throw new Error(`Unexpected durable status: ${event.durable.kind}`);
		expect(event.runtime).toEqual({ kind: "not_requested" });
		expect(event.receipt.reason).toBe("scope_conflict");
	});

	test("persistent scope without the injected writer cannot fall back to Settings.flush", async () => {
		const fixture = await createFixture({ withWriter: false });
		const preview = await readyPreview(fixture.transaction);
		const flush = vi.spyOn(fixture.session.settings, "flush");
		const flushOrThrow = vi.spyOn(fixture.session.settings, "flushOrThrow");
		const event = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "user",
			operationId: "persistent-no-writer",
		});

		expect(event.caseId).toBe("persistent_apply.unavailable.mutation");
		if (event.caseId !== "persistent_apply.unavailable.mutation")
			throw new Error(`Unexpected Work Mode case: ${event.caseId}`);
		expect(event.state).toBe("unavailable");
		expect(event.receipt.reason).toBe("scope_rejected");
		expect(event.durable).toEqual({ kind: "not_requested" });
		expect(event.runtime).toEqual({ kind: "rejected", code: "scope_rejected" });
		expect(flush).not.toHaveBeenCalled();
		expect(flushOrThrow).not.toHaveBeenCalled();
	});
});
