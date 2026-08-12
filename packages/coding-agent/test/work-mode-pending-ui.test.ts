import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent, WorkModePreviewResult } from "../src/config/work-mode-result";
import {
	createPendingWorkModeStatusView,
	createWorkModePreviewView,
	createWorkModeSelectorCards,
	type WorkModePreviewView,
} from "../src/config/work-mode-view";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
	type ModelSelectorWorkModeAdapter,
} from "../src/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

let testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

beforeAll(async () => {
	testTheme = await getThemeByName("red-claw");
	installTestTheme();
});

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
	modelRegistry: ModelRegistry;
}>;

type Deferred<T> = Readonly<{
	promise: Promise<T>;
	resolve: (value: T) => void;
}>;

const fixtures: Fixture[] = [];

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolver => {
		resolve = resolver;
	});
	return { promise, resolve };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Bun.sleep(0);
}

async function createFixture(): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model for the Work Mode UI fixture");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "work-mode-test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	const fixture = { authStorage, session, modelRegistry } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

async function createSelector(
	fixture: Fixture,
	adapter: ModelSelectorWorkModeAdapter,
	selections: ModelSelectorSelection[],
): Promise<Readonly<{ selector: ModelSelectorComponent; tui: TUI }>> {
	installTestTheme();
	const tui = new TUI(new VirtualTerminal(120, 40), false, { widthSettleMs: 0 });
	const selector = new ModelSelectorComponent(
		tui,
		fixture.session.model,
		fixture.session.settings,
		fixture.modelRegistry,
		[],
		selection => {
			selections.push(selection);
		},
		() => {},
		{ workModeAdapter: adapter },
	);
	await Bun.sleep(20);
	return { selector, tui };
}

function previewAdapterResult(
	modeId: string,
	result: WorkModePreviewResult,
): Readonly<{
	result: WorkModePreviewResult;
	view: WorkModePreviewView;
}> {
	return { result, view: createWorkModePreviewView(modeId, result) };
}

describe("Work Mode pending selector UI", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await fixture.session.dispose();
			fixture.authStorage.close();
		}
	});

	test("serializes double submit, preserves degraded confirmation, and suppresses disposed late completion", async () => {
		const fixture = await createFixture();
		const availableModels = fixture.modelRegistry.getAll().filter(model => model.id !== "gpt-5.6-luna");
		vi.spyOn(fixture.modelRegistry, "getAll").mockReturnValue(availableModels);
		const degradedPreview = await fixture.session.previewWorkMode("quick-edit");
		expect(degradedPreview.state).toBe("degraded");
		if (degradedPreview.state !== "degraded") throw new Error("Expected a degraded Work Mode preview");

		const previewGate = deferred<Readonly<{ result: WorkModePreviewResult; view: WorkModePreviewView }>>();
		const applyGate = deferred<WorkModeOperationEvent>();
		let previewCalls = 0;
		let applyCalls = 0;
		const adapter: ModelSelectorWorkModeAdapter = {
			cards: createWorkModeSelectorCards(),
			preview: async () => {
				previewCalls += 1;
				return previewGate.promise;
			},
			apply: async () => {
				applyCalls += 1;
				return applyGate.promise;
			},
		};
		const selections: ModelSelectorSelection[] = [];
		const { selector, tui } = await createSelector(fixture, adapter, selections);
		try {
			expect(selector.__testSelectedPresetRowIdentity()).toBe("workMode:quick-edit");
			selector.handleInput("\n");
			await Promise.resolve();
			selector.handleInput("\n");
			expect(previewCalls).toBe(1);

			previewGate.resolve(previewAdapterResult("quick-edit", degradedPreview));
			await settle();
			const confirmation = Bun.stripANSI(selector.render(120).join("\n"));
			expect(confirmation).toContain("confirmation required");
			expect(confirmation).toContain("Confirm degraded Work Mode");

			selector.handleInput("\n");
			await Promise.resolve();
			selector.handleInput("\n");
			expect(applyCalls).toBe(1);
			const applied = await fixture.session.applyWorkMode({
				modeId: "quick-edit",
				acceptedPreview: degradedPreview,
				scope: "turn",
				confirmationAccepted: true,
				operationId: "pending-ui-apply",
			});
			applyGate.resolve(applied);
			await settle();
			expect(selections).toHaveLength(1);
			const selection = selections[0];
			if (selection?.kind !== "workMode") throw new Error("Expected one Work Mode selection");
			expect(selection.modeId).toBe("quick-edit");
			expect(selection.preview.confirmationRequired).toBe(true);
			if (selection.event.phase === "preview") {
				throw new Error(
					selection.event.state === "unavailable"
						? `Expected a staged Work Mode event, got preview:${selection.event.state}:${selection.event.reason}`
						: `Expected a staged Work Mode event, got preview:${selection.event.state}`,
				);
			}
			if (selection.event.phase !== "turn_stage")
				throw new Error(`Expected a staged Work Mode event, got ${selection.event.phase}`);
			expect(selection.event.caseId).toBe("turn_stage.degraded");
			expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("Work Mode preview:");

			const pending = createPendingWorkModeStatusView("quick-edit");
			expect(pending.status).toBe("pending");
			expect(pending.modeId).toBe("quick-edit");
			expect(pending.detail).toContain("pending");
		} finally {
			tui.stop();
			selector.dispose();
			tui.dispose();
		}

		const latePreviewGate = deferred<Readonly<{ result: WorkModePreviewResult; view: WorkModePreviewView }>>();
		const lateSelections: ModelSelectorSelection[] = [];
		const lateAdapter: ModelSelectorWorkModeAdapter = {
			cards: createWorkModeSelectorCards(),
			preview: async () => {
				return latePreviewGate.promise;
			},
		};
		const late = await createSelector(fixture, lateAdapter, lateSelections);
		late.selector.handleInput("\n");
		await Promise.resolve();
		late.selector.dispose();
		latePreviewGate.resolve(previewAdapterResult("quick-edit", degradedPreview));
		await settle();
		expect(lateSelections).toHaveLength(0);
		expect(Bun.stripANSI(late.selector.render(120).join("\n"))).not.toContain("Work Mode preview:");

		const lateApplyGate = deferred<WorkModeOperationEvent>();
		const lateApplySelections: ModelSelectorSelection[] = [];
		const lateApplyAdapter: ModelSelectorWorkModeAdapter = {
			cards: createWorkModeSelectorCards(),
			preview: async () => previewAdapterResult("quick-edit", degradedPreview),
			apply: async () => lateApplyGate.promise,
		};
		const lateApply = await createSelector(fixture, lateApplyAdapter, lateApplySelections);
		lateApply.selector.handleInput("\n");
		await settle();
		expect(Bun.stripANSI(lateApply.selector.render(120).join("\n"))).toContain("confirmation required");
		lateApply.selector.handleInput("\n");
		await Promise.resolve();
		lateApply.selector.dispose();
		const lateApplied = await fixture.session.applyWorkMode({
			modeId: "quick-edit",
			acceptedPreview: degradedPreview,
			scope: "turn",
			confirmationAccepted: true,
			operationId: "pending-ui-late-apply",
		});
		lateApplyGate.resolve(lateApplied);
		await settle();
		expect(lateApplySelections).toHaveLength(0);
		expect(Bun.stripANSI(lateApply.selector.render(120).join("\n"))).not.toContain("Work Mode preview:");
		lateApply.tui.stop();
		lateApply.tui.dispose();
		late.tui.stop();
		late.tui.dispose();
	});
});
