import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { visibleWidth } from "@gajae-code/tui";
import { ModelRegistry } from "../src/config/model-registry";
import type {
	ScopedConfigurationMutationReceipt,
	ScopedConfigurationMutationRequest,
	ScopedConfigurationMutationService,
} from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import { CURATED_WORK_MODES } from "../src/config/work-mode-catalog";
import { WORK_MODE_EXECUTION_CASES } from "../src/config/work-mode-execution-cases";
import type { WorkModeStatusView } from "../src/config/work-mode-view";
import {
	createWorkModePaletteEntries,
	createWorkModePreviewView,
	createWorkModeScopeSelectionView,
	createWorkModeSelectorCards,
	createWorkModeStatusView,
	renderWorkModePreviewLines,
	renderWorkModeScopeLines,
	renderWorkModeStatusLines,
	WORK_MODE_PUBLIC_CASE_IDS,
	type WorkModeScopeChoiceView,
} from "../src/config/work-mode-view";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
	requests: ScopedConfigurationMutationRequest[];
}>;
type PersistentOutcome = "committed" | "committed-unconfirmed" | "conflict" | "locked" | "rejected" | "write-failure";

const fixtures: Fixture[] = [];

function mutationReceipt(scope: "project" | "user"): ScopedConfigurationMutationReceipt {
	return {
		status: "committed",
		reason: null,
		scope,
		safePath: `/scoped/${scope}/config.yml`,
		beforeRevision: "before-revision",
		afterRevision: "after-revision",
		beforeDigest: "before-digest",
		afterDigest: "after-digest",
		timing: "next_session",
		confirmation: "confirmed",
		durability: "committed",
		patches: [{ op: "set", path: "modelProfile.default" }],
	};
}

function receiptForOutcome(
	scope: "project" | "user",
	outcome: Exclude<PersistentOutcome, "write-failure">,
): ScopedConfigurationMutationReceipt {
	switch (outcome) {
		case "committed":
			return mutationReceipt(scope);
		case "committed-unconfirmed":
			return {
				...mutationReceipt(scope),
				reason: "persistent_reload_unconfirmed",
				confirmation: "unconfirmed",
				durability: "committed_unconfirmed",
			};
		case "conflict":
			return {
				...mutationReceipt(scope),
				status: "conflict",
				reason: "scope_conflict",
				confirmation: "not_applicable",
				durability: "none",
			};
		case "locked":
			return {
				...mutationReceipt(scope),
				status: "locked",
				reason: "scope_locked",
				confirmation: "not_applicable",
				durability: "none",
			};
		case "rejected":
			return {
				...mutationReceipt(scope),
				status: "rejected",
				reason: "scope_rejected",
				confirmation: "not_applicable",
				durability: "none",
			};
	}
}

async function createFixture(outcomes: readonly PersistentOutcome[] = ["committed"]): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model for the Work Mode showcase fixture");
	const requests: ScopedConfigurationMutationRequest[] = [];
	const pendingOutcomes = [...outcomes];
	const scopedMutationService: Pick<ScopedConfigurationMutationService, "read" | "mutate"> = {
		read: async () => {
			throw new Error("read is not used by this fixture");
		},
		mutate: async request => {
			requests.push(request);
			if (request.scope !== "project" && request.scope !== "user") {
				throw new Error("Expected a project or user mutation request");
			}
			const outcome = pendingOutcomes.shift() ?? "committed";
			if (outcome === "write-failure") throw new Error("persistent write failed");
			return receiptForOutcome(request.scope, outcome);
		},
	};
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "work-mode-test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
		workModeScopedMutationService: scopedMutationService,
	});
	const fixture = { authStorage, session, requests } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

function expectedAdapterRows(): string[] {
	return WORK_MODE_EXECUTION_CASES.map(candidate => `${candidate.caseId}=${candidate.phase}/${candidate.state}`);
}

afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

describe("Work Mode deterministic showcase adapter", () => {
	test("enumerates producer states, keeps IDs out of persistence, and renders safe narrow output", async () => {
		const cards = createWorkModeSelectorCards();
		expect(cards.map(card => card.modeId)).toEqual(CURATED_WORK_MODES.map(mode => mode.id));
		expect(cards.map(card => card.disabled)).toEqual([false, false, false, false, false]);
		expect(cards.map(card => card.classification)).toEqual(["curated", "curated", "curated", "curated", "curated"]);

		const palette = createWorkModePaletteEntries();
		expect(palette.map(entry => entry.id)).toEqual([
			"work-mode:quick-edit",
			"work-mode:daily-coding",
			"work-mode:deep-plan",
			"work-mode:review",
			"work-mode:autonomous",
		]);
		expect(palette.map(entry => entry.category)).toEqual([
			"Work Modes",
			"Work Modes",
			"Work Modes",
			"Work Modes",
			"Work Modes",
		]);
		expect(palette.map(entry => entry.disabled)).toEqual([false, false, false, false, false]);

		expect(WORK_MODE_PUBLIC_CASE_IDS).toEqual(WORK_MODE_EXECUTION_CASES.map(candidate => candidate.caseId));
		expect(new Set(WORK_MODE_PUBLIC_CASE_IDS).size).toBe(WORK_MODE_PUBLIC_CASE_IDS.length);
		expect(expectedAdapterRows()).toEqual([
			"session_apply.ready=session_apply/ready",
			"session_apply.degraded=session_apply/degraded",
			"session_apply.unavailable=session_apply/unavailable",
			"session_apply.drifted=session_apply/drifted",
			"persistent_apply.ready.committed=persistent_apply/ready",
			"persistent_apply.ready.committed_unconfirmed=persistent_apply/ready",
			"persistent_apply.degraded.committed=persistent_apply/degraded",
			"persistent_apply.degraded.committed_unconfirmed=persistent_apply/degraded",
			"persistent_apply.unavailable.prewrite=persistent_apply/unavailable",
			"persistent_apply.unavailable.mutation=persistent_apply/unavailable",
			"persistent_apply.drifted=persistent_apply/drifted",
			"turn_stage.ready=turn_stage/ready",
			"turn_stage.degraded=turn_stage/degraded",
			"turn_stage.unavailable=turn_stage/unavailable",
			"turn_stage.drifted=turn_stage/drifted",
			"turn_admission.ready=turn_admission/ready",
			"turn_admission.degraded=turn_admission/degraded",
			"turn_admission.unavailable.runtime.activation_failed=turn_admission/unavailable",
			"turn_admission.unavailable.runtime.rollback_failed=turn_admission/unavailable",
			"turn_admission.unavailable.pre_gate_cancelled=turn_admission/unavailable",
			"turn_admission.unavailable.pre_gate_rejected=turn_admission/unavailable",
			"turn_admission.drifted=turn_admission/drifted",
			"turn_finalize.ready=turn_finalize/ready",
			"turn_finalize.degraded=turn_finalize/degraded",
			"turn_finalize.unavailable.restore_failed=turn_finalize/unavailable",
		]);

		const fixture = await createFixture([
			"committed",
			"committed-unconfirmed",
			"conflict",
			"locked",
			"rejected",
			"write-failure",
		]);
		const preview = await fixture.session.previewWorkMode("quick-edit");
		if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
		const persistent = await fixture.session.applyWorkMode({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "project",
			operationId: "showcase-project-default",
		});
		expect(persistent.phase).toBe("persistent_apply");
		expect(persistent.state).toBe("ready");
		expect(fixture.requests).toHaveLength(1);
		const request = fixture.requests[0];
		if (!request) throw new Error("Expected one project mutation request");
		expect(request.patches).toEqual([{ op: "set", path: "modelProfile.default", value: "codex-eco" }]);
		expect(JSON.stringify(request)).not.toContain("quick-edit");
		expect(fixture.session.settings.get("modelProfile.default")).toBeUndefined();

		const persistentStatusCases: readonly Readonly<{
			outcome: PersistentOutcome;
			expected: WorkModeStatusView["status"];
		}>[] = [
			{ outcome: "committed-unconfirmed", expected: "committed-unconfirmed" },
			{ outcome: "conflict", expected: "conflict" },
			{ outcome: "locked", expected: "locked" },
			{ outcome: "rejected", expected: "rejected" },
			{ outcome: "write-failure", expected: "write-failure" },
		];
		for (const statusCase of persistentStatusCases) {
			const nextPreview = await fixture.session.previewWorkMode("quick-edit");
			if (nextPreview.state !== "ready") throw new Error(`Expected ready preview, got ${nextPreview.state}`);
			const event = await fixture.session.applyWorkMode({
				modeId: "quick-edit",
				acceptedPreview: nextPreview,
				scope: "project",
				operationId: `showcase-${statusCase.outcome}`,
			});
			if (event.phase !== "persistent_apply") throw new Error(`Expected persistent apply, got ${event.phase}`);
			const status = createWorkModeStatusView(event, {
				currentProfileId: "codex-eco",
				currentFingerprint: event.observedFingerprint,
				currentPhase: event.phase,
			});
			expect(status.status).toBe(statusCase.expected);
			expect(status.recovery.action).toBe(
				statusCase.expected === "committed-unconfirmed" ? "retry-preview" : "retry-apply",
			);
			expect(renderWorkModeStatusLines(status, 64).join("\n")).toContain(statusCase.expected);
		}
		const sessionPreview = await fixture.session.previewWorkMode("quick-edit");
		if (sessionPreview.state !== "ready")
			throw new Error(`Expected a ready session preview, got ${sessionPreview.state}`);
		const sessionApplied = await fixture.session.applyWorkMode({
			modeId: "quick-edit",
			acceptedPreview: sessionPreview,
			scope: "session",
			operationId: "showcase-session-runtime",
		});
		if (sessionApplied.phase === "preview") {
			throw new Error(
				sessionApplied.state === "unavailable"
					? `Expected a session-apply event, got preview:${sessionApplied.state}:${sessionApplied.reason}`
					: `Expected a session-apply event, got preview:${sessionApplied.state}`,
			);
		}
		if (sessionApplied.phase !== "session_apply")
			throw new Error(`Expected a session-apply event, got ${sessionApplied.phase}`);
		expect(sessionApplied.phase).toBe("session_apply");
		expect(sessionApplied.runtime).toEqual({ kind: "applied" });
		expect(fixture.requests).toHaveLength(6);
		expect(fixture.session.settings.get("modelProfile.default")).toBeUndefined();
		for (const capturedRequest of fixture.requests) {
			expect(capturedRequest.patches).toEqual([{ op: "set", path: "modelProfile.default", value: "codex-eco" }]);
			expect(JSON.stringify(capturedRequest)).not.toContain("quick-edit");
		}

		const previewView = createWorkModePreviewView("quick-edit", sessionPreview);
		const previewLines = renderWorkModePreviewLines(previewView, 28);
		for (const line of previewLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(28);
			expect(line).not.toMatch(/\x1b/u);
		}

		const unsafeChoice: WorkModeScopeChoiceView = {
			scope: "turn",
			label: "\x1b[31m界面 Work Mode\x1b[0m",
			enabled: true,
		};
		const unsafeScopeView = {
			choices: [unsafeChoice],
			selectedScope: "turn",
		} satisfies Readonly<{ choices: readonly WorkModeScopeChoiceView[]; selectedScope: "turn" }>;
		const narrowScopeLines = renderWorkModeScopeLines(unsafeScopeView, 16);
		expect(narrowScopeLines).toHaveLength(1);
		const narrowScopeLine = narrowScopeLines[0];
		if (!narrowScopeLine) throw new Error("Expected one narrow scope line");
		expect(narrowScopeLine).not.toContain("\x1b");
		expect(Bun.stripANSI(narrowScopeLine)).toContain("界面");
		expect(visibleWidth(narrowScopeLine)).toBeLessThanOrEqual(16);
		expect(createWorkModeScopeSelectionView().choices.map(choice => choice.scope)).toEqual([
			"turn",
			"session",
			"project",
			"user",
		]);
	});
});
