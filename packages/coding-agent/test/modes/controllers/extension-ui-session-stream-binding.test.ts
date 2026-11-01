import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { activateModelProfile } from "@gajae-code/coding-agent/config/model-profile-activation";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Container } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import type { JobFoldEvent } from "../../../src/async/job-manager";
import type { ExtensionUIContext } from "../../../src/extensibility/extensions";
import { ExtensionRunner, loadExtensions } from "../../../src/extensibility/extensions";
import { EventController } from "../../../src/modes/controllers/event-controller";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";
import {
	AgentSession,
	type AgentSessionEvent,
	type AgentSessionEventListener,
} from "../../../src/session/agent-session";

/**
 * The SDK session host streams turn content (`message_update`, `tool_execution_*`)
 * and `bash_folded` frames from `ExtensionContext.onSessionEvent` / `onJobFold`.
 * A TUI-hosted session builds that context through `ExtensionUiController`, so
 * both must reach the live session there; otherwise a remote ACP submitter gets
 * an accepted, settled turn with no content.
 */
type SessionEmitter = {
	emit: (event: AgentSessionEvent) => void;
	fold: (event: JobFoldEvent) => void;
};

function createSession(runner: ExtensionRunner): { session: Record<string, unknown>; emitter: SessionEmitter } {
	const listeners = new Set<AgentSessionEventListener>();
	const foldListeners = new Set<(event: JobFoldEvent) => void>();
	const session = {
		extensionRunner: runner,
		isStreaming: false,
		subscribe: (listener: AgentSessionEventListener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onJobFold: (listener: (event: JobFoldEvent) => void) => {
			foldListeners.add(listener);
			return () => foldListeners.delete(listener);
		},
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		reload: vi.fn(async () => {}),
		notifySessionIdentityChanged: vi.fn(async () => undefined),
		sendCustomMessage: vi.fn(async () => undefined),
		sendUserMessage: vi.fn(async () => undefined),
	};
	return {
		session,
		emitter: {
			emit: event => {
				for (const listener of listeners) listener(event);
			},
			fold: event => {
				for (const listener of foldListeners) listener(event);
			},
		},
	};
}

function createContext(session: Record<string, unknown> | AgentSession): InteractiveModeContext {
	return {
		isBackgrounded: false,
		isStopped: () => false,
		session,
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
		refreshSlashCommandState: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
}

function required<T>(binding: T | undefined, name: string): T {
	if (binding === undefined) throw new Error(`${name} is not bound on the extension context`);
	return binding;
}

const initializers: readonly [string, (controller: ExtensionUiController) => Promise<void> | void][] = [
	["initHooksAndCustomTools", async controller => await controller.initHooksAndCustomTools()],
	["initializeHookRunner", controller => controller.initializeHookRunner({} as ExtensionUIContext, false)],
];

describe("ExtensionUiController session stream binding", () => {
	let tempDir: TempDir;
	let runner: ExtensionRunner;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;
	let realSession: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-session-stream-binding-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const loaded = await loadExtensions([], tempDir.path());
		runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir.path(), sessionManager, modelRegistry);
	});

	afterEach(async () => {
		await realSession?.dispose();
		realSession = undefined;
		authStorage.close();
		await tempDir.remove();
	});

	for (const [name, initialize] of initializers) {
		for (const sdkFirst of [true, false]) {
			it(`preserves the startup fallback notice with ${sdkFirst ? "SDK" : "TUI"} first in ${name}`, async () => {
				const fallback = getBundledModel("openai", "gpt-4o-mini");
				if (!fallback) throw new Error("Expected bundled fallback model");
				authStorage.setRuntimeApiKey("openai", "test-key");
				const skipped = "unregistered-provider/unregistered-model";
				const selected = `${fallback.provider}/${fallback.id}`;
				const modelsPath = path.join(tempDir.path(), "models.yml");
				await Bun.write(
					modelsPath,
					`profiles:\n  startup-fallback:\n    required_providers: [openai]\n    model_mapping:\n      default: [${skipped}, ${selected}]\n`,
				);
				modelRegistry = new ModelRegistry(authStorage, modelsPath);
				const settings = Settings.isolated({ "compaction.enabled": false });
				realSession = new AgentSession({
					agent: new Agent({ initialState: { model: fallback, tools: [], messages: [] } }),
					sessionManager,
					settings,
					modelRegistry,
					extensionRunner: runner,
				});
				// The real profile activation skips entry 0 before any consumer attaches.
				await activateModelProfile({
					session: realSession,
					modelRegistry,
					settings,
					profileName: "startup-fallback",
				});
				expect(realSession.model).toMatchObject({ provider: fallback.provider, id: fallback.id });
				expect(realSession.getDefaultFallbackRuntimeState().controller.activeIndex).toBe(1);

				const ctx = createContext(realSession);
				const showStatus = vi.fn<(message: string) => void>();
				Object.assign(ctx, {
					showStatus,
					isInitialized: true,
					statusLine: { invalidate: vi.fn() },
					updateEditorTopBorder: vi.fn(),
					updateEditorBorderColor: vi.fn(),
				});
				const tui = new EventController(ctx);
				await initialize(new ExtensionUiController(ctx));
				const onSessionEvent = required(runner.createContext().onSessionEvent, "onSessionEvent");
				const observed: AgentSessionEvent[] = [];
				let stopObserver: () => void;
				if (sdkFirst) {
					stopObserver = onSessionEvent(event => observed.push(event));
					tui.subscribeToAgent();
				} else {
					tui.subscribeToAgent();
					stopObserver = onSessionEvent(event => observed.push(event));
				}
				// Joining the controller's event queue makes the notification assertion deterministic.
				await tui.handleEvent({ type: "notice", level: "info", message: "queue barrier" });
				expect(ctx.showStatus).toHaveBeenCalledWith(`Fallback model: ${skipped} → ${selected}`);
				expect(observed).toEqual([]);

				// Reattaching either consumer must not replay an already displayed startup notice.
				ctx.unsubscribe?.();
				stopObserver();
				stopObserver();
				const reconnected: AgentSessionEvent[] = [];
				const stopReconnected = onSessionEvent(event => reconnected.push(event));
				tui.subscribeToAgent();
				await tui.handleEvent({ type: "notice", level: "info", message: "reconnect barrier" });
				expect(showStatus.mock.calls.filter(([message]) => message.startsWith("Fallback model:"))).toHaveLength(1);
				expect(reconnected).toEqual([]);

				// Future switches remain live events, delivered once to each active consumer.
				realSession.seedDefaultFallbackResolution(1, [{ selector: skipped, reason: "unknown_model" }]);
				await tui.handleEvent({ type: "notice", level: "info", message: "live barrier" });
				expect(reconnected).toEqual([
					expect.objectContaining({ type: "model_fallback_switched", from: skipped, to: selected }),
				]);
				expect(observed).toEqual([]);
				expect(showStatus.mock.calls.filter(([message]) => message.startsWith("Fallback model:"))).toHaveLength(2);
				stopReconnected();
				ctx.unsubscribe?.();
				tui.dispose();
			});
		}
		it(`keeps event subscriptions session-owned across a rebind in ${name}`, async () => {
			const { session, emitter } = createSession(runner);
			const ctx = createContext(session);
			await initialize(new ExtensionUiController(ctx));

			const received: AgentSessionEvent[] = [];
			const onSessionEvent = required(runner.createContext().onSessionEvent, "onSessionEvent");
			const listener = (event: AgentSessionEvent) => received.push(event);
			const dispose = onSessionEvent(listener);
			const update = { type: "message_update" } as unknown as AgentSessionEvent;
			emitter.emit(update);
			expect(received).toEqual([update]);

			const replacement = createSession(runner);
			ctx.session = replacement.session as unknown as AgentSession;
			const disposeReplacement = onSessionEvent(listener);
			dispose();
			dispose();
			const end = { type: "message_end" } as unknown as AgentSessionEvent;
			emitter.emit(end);
			expect(received).toEqual([update]);
			replacement.emitter.emit(end);
			expect(received).toEqual([update, end]);
			disposeReplacement();
			replacement.emitter.emit(update);
			expect(received).toEqual([update, end]);
		});

		it(`forwards job folds and advertises the binding in ${name}`, async () => {
			const { session, emitter } = createSession(runner);
			await initialize(new ExtensionUiController(createContext(session)));

			const context = runner.createContext();
			expect(context.sdkBindings?.()).toContain("onJobFold");
			const folds: JobFoldEvent[] = [];
			const dispose = required(context.onJobFold, "onJobFold")(event => folds.push(event));
			const fold: JobFoldEvent = { jobId: "job-1", generation: "g1", reason: "steer" };
			emitter.fold(fold);
			expect(folds).toEqual([fold]);

			dispose();
			emitter.fold({ jobId: "job-2", generation: "g2", reason: "timer" });
			expect(folds).toEqual([fold]);
		});
	}
});
