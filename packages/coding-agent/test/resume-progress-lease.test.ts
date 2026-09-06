import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Container, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { acquireResumeProgressLease } from "../src/modes/utils/ui-helpers";

beforeAll(() => initTheme());
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

describe("resume progress lease", () => {
	it("commits the status loader before a blocked session switch", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const ui = new TUI(terminal);
		const statusContainer = new Container();
		ui.addChild(statusContainer);
		ui.start();

		let currentSessionId = "before";
		let progressCommittedBeforeSwitch = false;
		const switchStarted = deferred<void>();
		const switchResult = deferred<boolean>();
		const session = {
			switchSession: vi.fn(async () => {
				progressCommittedBeforeSwitch = terminal.getWriteLog().join("").includes("Resuming session");
				switchStarted.resolve();
				return await switchResult.promise;
			}),
		};
		const context = {
			ui,
			statusContainer,
			loadingAnimation: undefined,
			pendingMessagesContainer: new Container(),
			compactionQueuedMessages: [],
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			session,
			settings: { get: () => undefined },
			sessionManager: {
				getSessionId: () => currentSessionId,
				isManagedDestination: () => false,
				getSessionName: () => undefined,
				getCwd: () => "/tmp",
			},
			resetIrcSidebarSession: vi.fn(),
			resetAssistantTextPresentation: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			rebuildInitialMessages: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(context);

		const resume = controller.handleResumeSession("/tmp/target.jsonl");
		await switchStarted.promise;
		expect(progressCommittedBeforeSwitch).toBe(true);
		expect(statusContainer.children).toHaveLength(1);

		currentSessionId = "after";
		switchResult.resolve(true);
		await resume;
		expect(statusContainer.children).toHaveLength(0);
		expect(context.showStatus).toHaveBeenCalledWith("Resumed session");
		expect(context.resetAssistantTextPresentation).toHaveBeenCalledTimes(1);
		expect(session.switchSession).toHaveBeenCalledWith("/tmp/target.jsonl", expect.any(Object));

		ui.stop();
	});

	it("fails open when statusContainer lacks child mutation surface", async () => {
		const switchSession = vi.fn(async () => true);
		const statusContainer = {
			clear: vi.fn(),
			// Intentionally omit addChild/removeChild/children — legacy/minimal fixtures.
		};
		const ui = {
			requestRender: vi.fn(),
			requestRenderWithGeneration: vi.fn(() => 1),
			waitForRenderCommit: vi.fn(async () => true),
		};
		const lease = acquireResumeProgressLease({
			ui,
			statusContainer,
		} as unknown as Pick<InteractiveModeContext, "ui" | "statusContainer">);

		expect(await lease.committed).toBe(false);
		expect(ui.requestRenderWithGeneration).not.toHaveBeenCalled();
		lease.clear();
		expect(statusContainer.clear).not.toHaveBeenCalled();

		const context = {
			ui,
			statusContainer,
			loadingAnimation: undefined,
			pendingMessagesContainer: { clear: vi.fn() },
			compactionQueuedMessages: [],
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			session: { switchSession },
			settings: { get: () => undefined },
			sessionManager: {
				getSessionId: () => "before",
				isManagedDestination: () => false,
				getSessionName: () => undefined,
				getCwd: () => "/tmp",
			},
			resetIrcSidebarSession: vi.fn(),
			resetAssistantTextPresentation: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			rebuildInitialMessages: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(context);

		await expect(controller.handleResumeSession("/tmp/target.jsonl")).resolves.toBeUndefined();
		expect(switchSession).toHaveBeenCalledWith("/tmp/target.jsonl", expect.any(Object));
		expect(context.showStatus).toHaveBeenCalledWith("Resumed session");
		expect(ui.requestRenderWithGeneration).not.toHaveBeenCalled();
	});

	it("fails open when statusContainer is only partially implemented", async () => {
		const children: unknown[] = [];
		const statusContainer = {
			children,
			addChild: vi.fn((child: unknown) => {
				children.push(child);
			}),
			// Missing removeChild — partial surface must not mount either.
			clear: vi.fn(),
		};
		const ui = {
			requestRender: vi.fn(),
			requestRenderWithGeneration: vi.fn(() => 1),
			waitForRenderCommit: vi.fn(async () => true),
		};

		const lease = acquireResumeProgressLease({
			ui,
			statusContainer,
		} as unknown as Pick<InteractiveModeContext, "ui" | "statusContainer">);

		expect(await lease.committed).toBe(false);
		expect(statusContainer.addChild).not.toHaveBeenCalled();
		expect(ui.requestRenderWithGeneration).not.toHaveBeenCalled();
		lease.clear();
		expect(children).toHaveLength(0);
	});

	it("fails open when UI lacks render-commit surface", async () => {
		const children: unknown[] = [];
		const statusContainer = {
			children,
			addChild: vi.fn((child: unknown) => {
				children.push(child);
			}),
			removeChild: vi.fn((child: unknown) => {
				const index = children.indexOf(child);
				if (index >= 0) children.splice(index, 1);
			}),
		};
		const ui = {
			// Legacy fixtures often only expose requestRender.
			requestRender: vi.fn(),
		};

		const lease = acquireResumeProgressLease({
			ui,
			statusContainer,
		} as unknown as Pick<InteractiveModeContext, "ui" | "statusContainer">);

		expect(await lease.committed).toBe(false);
		expect(statusContainer.addChild).not.toHaveBeenCalled();
		lease.clear();
		expect(children).toHaveLength(0);
	});
});
