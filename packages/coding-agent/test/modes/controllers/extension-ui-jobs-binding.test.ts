import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Container } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import type { AsyncJobDeliveryState } from "../../../src/async/job-manager";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../../../src/extensibility/extensions";
import { ExtensionRunner, loadExtensions } from "../../../src/extensibility/extensions";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";
import type { QueryResponse } from "../../../src/sdk/host/query/handlers";
import { CursorRegistry, QueryHandlers, RevisionStore } from "../../../src/sdk/host/query/index.js";
import type { AsyncJobSnapshot, AsyncJobSnapshotItem } from "../../../src/session/agent-session";

type SnapshotSource = () => AsyncJobSnapshot | null;

type Fixture = {
	controller: ExtensionUiController;
	ctx: InteractiveModeContext;
	getContextActions: () => ExtensionContextActions;
	setSnapshot: (source: SnapshotSource) => void;
	rebindSession: (source: SnapshotSource) => void;
	snapshotCalls: () => number;
};

function emptySnapshot(): AsyncJobSnapshot {
	return {
		running: [],
		recent: [],
		delivery: { queued: 0, delivering: false, pendingJobIds: [], deadLettered: 0 },
	};
}

async function dispatchJobsQuery(getJobs: () => unknown): Promise<QueryResponse> {
	const store = new RevisionStore("s1");
	const cursors = new CursorRegistry("token", store);
	const surface = {
		getTranscriptEntries: () => [],
		getContextSnapshot: () => ({}),
		getGoalState: () => [],
		getTodoState: () => [],
		getDiff: () => [],
		getUsage: () => ({}),
		getModels: () => [],
		getSkillState: () => [],
		getActiveProviders: () => [],
		getGates: () => [],
		getConfigItems: () => [],
		getSessionMetadata: () => ({}),
		getStats: () => ({}),
		getBranchCandidates: () => [],
		getLastAssistant: () => ({}),
		getCapabilities: () => ({}),
		getAuthProviders: () => [],
		getTools: () => [],
		getQueueMessages: () => [],
		getExtensions: () => [],
		getArtifact: () => undefined,
		getJobs,
	};
	const queries = new QueryHandlers(surface, "s1", store, cursors);
	return await queries.dispatch({ query: "runtime.jobs.list", id: "q25", connectionId: "c" });
}

function runningItem(id: string): AsyncJobSnapshotItem {
	return {
		id,
		type: "bash",
		status: "running",
		label: "build",
		startTime: 1,
		endTime: undefined,
		metadata: undefined,
	} as AsyncJobSnapshotItem;
}

function createFixture(): Fixture {
	let contextActions: ExtensionContextActions | undefined;
	let source: SnapshotSource = () => emptySnapshot();
	let calls = 0;
	const extensionRunner = {
		initialize(
			_actions: ExtensionActions,
			capturedContextActions: ExtensionContextActions,
			_commandActions?: ExtensionCommandContextActions,
			_uiContext?: ExtensionUIContext,
		): void {
			contextActions = capturedContextActions;
		},
		onError: () => () => {},
		emit: vi.fn(async () => undefined),
	};
	const makeSession = (): Record<string, unknown> => ({
		extensionRunner,
		isStreaming: false,
		getAsyncJobSnapshot: (): AsyncJobSnapshot | null => {
			calls += 1;
			return source();
		},
		sendCustomMessage: vi.fn(async () => undefined),
		sendUserMessage: vi.fn(async () => undefined),
	});
	const ctx = {
		isBackgrounded: false,
		isStopped: () => false,
		session: makeSession(),
		sessionManager: {
			getSessionId: () => "session-a",
			getSessionName: () => "Session",
			getCwd: () => "/tmp/project",
		},
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		ui: { requestRender: vi.fn() },
		editor: { setText: vi.fn(), handleInput: vi.fn(), getText: () => "" },
		setToolUIContext: vi.fn(),
		setWorkingMessage: vi.fn(),
		setEditorComponent: vi.fn(),
		toolOutputExpanded: false,
		setToolsExpanded: vi.fn(),
		rebuildInitialMessages: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		resetIrcSidebarSession: vi.fn(),
		reloadTodos: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(ctx);
	return {
		controller,
		ctx,
		getContextActions: () => {
			if (!contextActions) throw new Error("Extension context actions were not initialized");
			return contextActions;
		},
		setSnapshot: next => {
			source = next;
		},
		rebindSession: next => {
			source = next;
			(ctx as unknown as { session: unknown }).session = makeSession();
		},
		snapshotCalls: () => calls,
	};
}

const initializers: readonly [string, (fixture: Fixture) => Promise<void> | void][] = [
	["initHooksAndCustomTools", async fixture => await fixture.controller.initHooksAndCustomTools()],
	["initializeHookRunner", fixture => fixture.controller.initializeHookRunner({} as ExtensionUIContext, false)],
];

describe("ExtensionUiController async-job binding", () => {
	for (const [name, initialize] of initializers) {
		it(`binds getJobs to the session snapshot in ${name}`, async () => {
			const fixture = createFixture();
			const snapshot = emptySnapshot();
			fixture.setSnapshot(() => snapshot);

			await initialize(fixture);

			const getJobs = fixture.getContextActions().getJobs;
			expect(typeof getJobs).toBe("function");
			expect(getJobs?.()).toBe(snapshot);
			expect(fixture.snapshotCalls()).toBe(1);
		});

		it(`reads the current snapshot on every call in ${name}`, async () => {
			const fixture = createFixture();
			await initialize(fixture);
			const getJobs = fixture.getContextActions().getJobs;

			const first = emptySnapshot();
			fixture.setSnapshot(() => first);
			expect(getJobs?.()).toBe(first);

			const second: AsyncJobSnapshot = {
				...emptySnapshot(),
				running: [runningItem("job-1")],
				recent: [runningItem("job-1")],
			};
			fixture.setSnapshot(() => second);
			expect(getJobs?.()).toBe(second);
			expect(getJobs?.()).toBe(second);
		});

		it(`follows session rebinding in ${name}`, async () => {
			const fixture = createFixture();
			await initialize(fixture);
			const getJobs = fixture.getContextActions().getJobs;

			const rebound = emptySnapshot();
			fixture.rebindSession(() => rebound);

			expect(getJobs?.()).toBe(rebound);
			expect(fixture.ctx.session.getAsyncJobSnapshot()).toBe(rebound);
		});

		it(`preserves a null manager-absent snapshot in ${name}`, async () => {
			const fixture = createFixture();
			fixture.setSnapshot(() => null);
			await initialize(fixture);

			expect(fixture.getContextActions().getJobs?.()).toBeNull();
		});

		it(`preserves available-empty running, recent and pending delivery in ${name}`, async () => {
			const fixture = createFixture();
			const delivery: AsyncJobDeliveryState = {
				queued: 2,
				delivering: false,
				pendingJobIds: ["job-parked"],
				deadLettered: 1,
			};
			const snapshot: AsyncJobSnapshot = { running: [], recent: [], delivery };
			fixture.setSnapshot(() => snapshot);
			await initialize(fixture);

			const observed = fixture.getContextActions().getJobs?.() as AsyncJobSnapshot;
			expect(observed.running).toEqual([]);
			expect(observed.recent).toEqual([]);
			expect(observed.delivery).toBe(delivery);
		});
	}
});

describe("ExtensionUiController jobs binding through the real extension runner", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-jobs-binding-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(() => {
		tempDir.remove();
	});

	async function createRunner(): Promise<ExtensionRunner> {
		const loaded = await loadExtensions([], tempDir.path());
		return new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	async function bindRunner(source: SnapshotSource): Promise<ExtensionRunner> {
		const fixture = createFixture();
		const runner = await createRunner();
		(fixture.ctx.session as unknown as { extensionRunner: ExtensionRunner }).extensionRunner = runner;
		fixture.setSnapshot(source);
		fixture.controller.initializeHookRunner({} as ExtensionUIContext, false);
		return runner;
	}

	it("publishes the session snapshot through the extension context and advertises the binding", async () => {
		const snapshot = emptySnapshot();
		const runner = await bindRunner(() => snapshot);

		const context = runner.createContext();
		expect(context.getJobs()).toBe(snapshot);
		expect(context.sdkBindings?.()).toContain("getJobs");
	});

	it("answers Q25 from the bound session snapshot instead of resource_gone", async () => {
		const delivery: AsyncJobDeliveryState = {
			queued: 1,
			delivering: false,
			pendingJobIds: ["job-parked"],
			deadLettered: 0,
		};
		const snapshot: AsyncJobSnapshot = { running: [runningItem("job-1")], recent: [runningItem("job-1")], delivery };
		const runner = await bindRunner(() => snapshot);
		const context = runner.createContext();

		const response = await dispatchJobsQuery(() => context.getJobs());

		expect(response.ok).toBe(true);
		expect(response.page?.items).toEqual([snapshot]);
		expect(response.page?.complete).toBe(true);
	});

	it("keeps available-empty, null and unbound Q25 envelopes distinct", async () => {
		const empty = emptySnapshot();
		const emptyRunner = await bindRunner(() => empty);
		const emptyResponse = await dispatchJobsQuery(() => emptyRunner.createContext().getJobs());
		expect(emptyResponse.ok).toBe(true);
		expect(emptyResponse.page?.items).toEqual([empty]);

		const nullRunner = await bindRunner(() => null);
		const nullResponse = await dispatchJobsQuery(() => nullRunner.createContext().getJobs());
		expect(nullResponse.ok).toBe(true);
		expect(nullResponse.page?.items).toEqual([null]);

		const unbound = await createRunner();
		const unboundResponse = await dispatchJobsQuery(() => unbound.createContext().getJobs());
		expect(unboundResponse.ok).toBe(false);
		expect(unboundResponse.error?.code).toBe("resource_gone");
	});
});
