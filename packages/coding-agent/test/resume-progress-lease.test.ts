import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Container, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

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
		expect(session.switchSession).toHaveBeenCalledWith("/tmp/target.jsonl", expect.any(Object));

		ui.stop();
	});
});
