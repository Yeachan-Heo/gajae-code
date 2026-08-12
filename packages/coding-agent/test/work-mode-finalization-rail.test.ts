import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
}>;

type HeldPrompt = Readonly<{
	prompt: Promise<void>;
	release: { resolve: () => void };
}>;

const fixtures: Fixture[] = [];

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	vi.restoreAllMocks();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "rail-test-key");
	authStorage.setRuntimeApiKey("anthropic", "rail-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model in the finalization rail fixture");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "rail-test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	const fixture = { authStorage, session } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

async function admitAndHold(session: AgentSession): Promise<HeldPrompt> {
	const preview = await session.previewWorkMode("quick-edit");
	if (preview.state === "unavailable") throw new Error(`Expected Work Mode preview, got ${preview.reason}`);
	const staged = await session.stageWorkMode({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		confirmationAccepted: preview.state === "degraded",
		operationId: "finalization-rail-operation",
	});
	if (staged.phase !== "turn_stage" || (staged.state !== "ready" && staged.state !== "degraded")) {
		throw new Error(`Expected Work Mode stage, got ${staged.phase}:${staged.state}`);
	}
	const accepted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const prompt = session.prompt("rail test prompt", {
		onPreflightAcceptCommit: async () => {
			accepted.resolve();
			await release.promise;
		},
	});
	await accepted.promise;
	return { prompt, release };
}

function createRailContext(session: AgentSession, values: unknown[]): InteractiveModeContext {
	return {
		settings: session.settings,
		session,
		statusLine: {
			setWorkModeStatus: (value: unknown) => values.push(value),
		},
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
}

type RailStatus = Readonly<{
	status?: string;
}>;

function isRailStatus(value: unknown): value is RailStatus {
	return typeof value === "object" && value !== null && "status" in value && typeof value.status === "string";
}

describe("Work Mode finalization rail", () => {
	test("clears ready/degraded status after restore and retains restore-failure recovery", async () => {
		const successFixture = await createFixture();
		const successValues: unknown[] = [];
		new SelectorController(createRailContext(successFixture.session, successValues));
		const successHeld = await admitAndHold(successFixture.session);
		const finalized = await successFixture.session.finalizeWorkModeTurn("completed");
		if (!finalized) throw new Error("Expected a Work Mode finalization event");
		successHeld.release.resolve();
		await successHeld.prompt;
		expect(finalized.caseId).toBe("turn_finalize.ready");
		expect(successValues.at(-1)).toBeUndefined();

		const failedFixture = await createFixture();
		const failedValues: unknown[] = [];
		new SelectorController(createRailContext(failedFixture.session, failedValues));
		const failedHeld = await admitAndHold(failedFixture.session);
		vi.spyOn(failedFixture.session, "restoreTemporaryProviderSessionScope").mockImplementationOnce(() => false);
		const restoreFailed = await failedFixture.session.finalizeWorkModeTurn("cancelled");
		if (!restoreFailed) throw new Error("Expected a restore-failed Work Mode event");
		expect(restoreFailed.caseId).toBe("turn_finalize.unavailable.restore_failed");
		const immediateFailedStatus = failedValues.at(-1);
		if (!isRailStatus(immediateFailedStatus))
			throw new Error("Expected recovery status on the rail immediately after finalization");
		expect(immediateFailedStatus.status).toBe("finalization-failure");
		failedHeld.release.resolve();
		await expect(failedHeld.prompt).rejects.toThrow("Work Mode dispatch is fenced pending recovery.");
		const retainedFailedStatus = failedValues.at(-1);
		if (!isRailStatus(retainedFailedStatus)) throw new Error("Expected recovery status to remain on the rail");
		expect(retainedFailedStatus.status).toBe("finalization-failure");
	});
});
