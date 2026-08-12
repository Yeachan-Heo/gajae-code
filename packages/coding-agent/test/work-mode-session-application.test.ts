import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import type {
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationService,
} from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
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

async function createFixture(): Promise<{
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model in the test registry");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	fixtures.push({ session, authStorage });
	return { session, authStorage, modelRegistry };
}

async function readyPreview(session: AgentSession) {
	const preview = await session.previewWorkMode("quick-edit");
	if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
	return preview;
}
type WorkModeExecutionEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;

function requireExecutionEvent(event: WorkModeOperationEvent, context: string): WorkModeExecutionEvent {
	if (event.phase === "preview") throw new Error(`Expected an execution Work Mode event for ${context}`);
	return event;
}

describe("Work Mode session application", () => {
	test("applies the selected profile to session runtime without durable flush or Work Mode ID persistence", async () => {
		const { session } = await createFixture();
		const preview = await readyPreview(session);
		const flush = vi.spyOn(session.settings, "flush");
		const flushOrThrow = vi.spyOn(session.settings, "flushOrThrow");

		const event = requireExecutionEvent(
			await session.applyWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "session",
				operationId: "session-runtime-only",
			}),
			"session runtime apply",
		);

		expect(event.caseId).toBe("session_apply.ready");
		if (event.caseId !== "session_apply.ready")
			throw new Error(`Expected session_apply.ready event, got ${event.caseId}`);
		expect(event.durable).toEqual({ kind: "not_requested" });
		expect(event.runtime).toEqual({ kind: "applied" });
		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe("gpt-5.6-terra");
		expect(session.settings.get("modelProfile.default")).toBeUndefined();
		expect(flush).not.toHaveBeenCalled();
		expect(flushOrThrow).not.toHaveBeenCalled();
	});

	test("retains the profile fallback chain and active profile only in session runtime", async () => {
		const { session } = await createFixture();
		const preview = await readyPreview(session);

		const event = requireExecutionEvent(
			await session.applyWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "session",
				operationId: "session-runtime-state",
			}),
			"session runtime state",
		);

		expect(event.caseId).toBe("session_apply.ready");
		if (event.caseId !== "session_apply.ready")
			throw new Error(`Expected session_apply.ready event, got ${event.caseId}`);
		expect(event.receipt.phase).toBe("session_apply");
		expect(event.receipt.scope).toBe("session");
		expect(event.receipt.relation.kind).toBe("equal");
		expect(session.getActiveModelProfile()).toBe("codex-eco");
		expect(session.getConfiguredModelChain("default")).toEqual(["openai-codex/gpt-5.6-terra:low"]);
		expect(session.settings.get("modelRoles")).toEqual({});
		expect(session.settings.get("task.agentModelOverrides")).toMatchObject({
			executor: "openai-codex/gpt-5.6-luna:low",
			planner: "openai-codex/gpt-5.6-luna:high",
		});
		expect(session.settings.get("modelProfile.default")).toBeUndefined();
	});

	test("rolls back runtime preparation when session activation fails without invoking durable persistence", async () => {
		const { session } = await createFixture();
		const preview = await readyPreview(session);
		const initialModel = session.model;
		const flush = vi.spyOn(session.settings, "flush");
		const flushOrThrow = vi.spyOn(session.settings, "flushOrThrow");
		vi.spyOn(session, "setModelTemporary").mockImplementationOnce(async () => {
			throw new Error("runtime activation failed");
		});

		const event = requireExecutionEvent(
			await session.applyWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "session",
				operationId: "session-runtime-failure",
			}),
			"session runtime failure",
		);

		expect(event.caseId).toBe("session_apply.unavailable");
		if (event.caseId !== "session_apply.unavailable")
			throw new Error(`Expected session_apply.unavailable event, got ${event.caseId}`);
		expect(event.receipt.reason).toBe("session_activation_failed");
		expect(event.durable).toEqual({ kind: "not_requested" });
		expect(event.runtime).toEqual({ kind: "rejected", code: "session_activation_failed" });
		expect(session.model).toBe(initialModel);
		expect(session.getConfiguredModelChain("default") ?? []).toEqual([]);
		expect(session.getActiveModelProfile()).toBeUndefined();
		expect(session.settings.get("modelProfile.default")).toBeUndefined();
		expect(flush).not.toHaveBeenCalled();
		expect(flushOrThrow).not.toHaveBeenCalled();
	});

	test("requires explicit confirmation for a degraded session profile and applies it only after confirmation", async () => {
		const { session, modelRegistry } = await createFixture();
		const availableModels = modelRegistry.getAll().filter(model => model.id !== "gpt-5.6-luna");
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(availableModels);
		const preview = await session.previewWorkMode("quick-edit");
		expect(preview.state).toBe("degraded");
		if (preview.state !== "degraded") throw new Error("Expected degraded Work Mode preview");

		const rejected = requireExecutionEvent(
			await session.applyWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "session",
				operationId: "session-degraded-unconfirmed",
			}),
			"session degraded rejection",
		);
		expect(rejected.caseId).toBe("session_apply.unavailable");
		if (rejected.caseId !== "session_apply.unavailable")
			throw new Error(`Expected session_apply.unavailable event, got ${rejected.caseId}`);
		expect(rejected.runtime).toEqual({ kind: "rejected", code: "session_activation_failed" });
		expect(session.getActiveModelProfile()).toBeUndefined();

		const applied = requireExecutionEvent(
			await session.applyWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "session",
				confirmationAccepted: true,
				operationId: "session-degraded-confirmed",
			}),
			"session degraded confirmation",
		);
		expect(applied.caseId).toBe("session_apply.degraded");
		if (applied.caseId !== "session_apply.degraded")
			throw new Error(`Expected session_apply.degraded event, got ${applied.caseId}`);
		expect(applied.confirmation).toEqual({ required: true, accepted: true });
		expect(applied.runtime).toEqual({ kind: "applied" });
		expect(session.getActiveModelProfile()).toBe("codex-eco");
	});

	test("session scope never calls an injected scoped mutation service", async () => {
		const { session, modelRegistry } = await createFixture();
		const counters = { mutations: 0 };
		const scopedMutationService: Pick<ScopedConfigurationMutationService, "mutate"> = {
			mutate: async (): Promise<ScopedConfigurationMutationReceipt> => {
				counters.mutations += 1;
				throw new Error("session scope must not use durable writer");
			},
		};
		const transaction = new WorkModeTransaction({
			session,
			modelRegistry,
			settings: session.settings,
			scopedMutationService,
		});
		const preview = await transaction.preview("quick-edit");
		if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
		const event = await transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "session",
			operationId: "session-injected-writer-fence",
		});

		expect(event.caseId).toBe("session_apply.ready");
		if (event.caseId !== "session_apply.ready")
			throw new Error(`Expected session_apply.ready event, got ${event.caseId}`);
		expect(event.durable).toEqual({ kind: "not_requested" });
		expect(event.runtime).toEqual({ kind: "applied" });
		expect(counters.mutations).toBe(0);
	});
});
