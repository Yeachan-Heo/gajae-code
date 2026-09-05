import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Container, Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "../src/modes/types";

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

/** Mirrors what `#beginSessionTransition` throws while another transition owns the session. */
function busyTransitionError(): Error {
	return Object.assign(new Error("Cannot start switch-session while a compact transition is in progress."), {
		code: "busy",
	});
}

function createContext(session: { switchSession: (path: string, options?: unknown) => Promise<boolean> }): {
	context: InteractiveModeContext;
	statusContainer: Container;
	pendingMessagesContainer: Container;
	ui: TUI;
} {
	const terminal = new VirtualTerminal(80, 12);
	const ui = new TUI(terminal);
	const statusContainer = new Container();
	const pendingMessagesContainer = new Container();
	ui.addChild(statusContainer);
	ui.start();

	const context = {
		ui,
		statusContainer,
		loadingAnimation: undefined,
		pendingMessagesContainer,
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		session,
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

	return { context, statusContainer, pendingMessagesContainer, ui };
}

describe("resume session re-entrancy", () => {
	it("ignores an overlapping resume instead of starting a second transition", async () => {
		const switchStarted = deferred<void>();
		const switchResult = deferred<boolean>();
		const switchSession = vi.fn(async () => {
			switchStarted.resolve();
			return await switchResult.promise;
		});
		const { context, statusContainer, ui } = createContext({ switchSession });
		const controller = new SelectorController(context);

		const first = controller.handleResumeSession("/tmp/first.jsonl");
		await switchStarted.promise;

		// A second picker selection (or /resume) while the first switch is still
		// awaiting must not open a concurrent transition.
		await controller.handleResumeSession("/tmp/second.jsonl");
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith("Resume already in progress");
		// Asserted while the first resume is still in flight: the rejected overlap must
		// not tear down the running resume's spinner.
		expect(statusContainer.children).toHaveLength(1);

		switchResult.resolve(true);
		await first;
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith("Resumed session");
		expect(statusContainer.children).toHaveLength(0);

		ui.stop();
	});

	it("accepts a later resume once the in-flight one settles", async () => {
		const switchSession = vi.fn(async () => true);
		const { context, ui } = createContext({ switchSession });
		const controller = new SelectorController(context);

		await controller.handleResumeSession("/tmp/first.jsonl");
		await controller.handleResumeSession("/tmp/second.jsonl");

		expect(switchSession).toHaveBeenCalledTimes(2);
		expect(switchSession).toHaveBeenLastCalledWith("/tmp/second.jsonl", expect.any(Object));

		ui.stop();
	});

	it("clears the guard when a resume fails so the next attempt still runs", async () => {
		const switchSession = vi
			.fn<(path: string, options?: unknown) => Promise<boolean>>()
			.mockRejectedValueOnce(new Error("switch exploded"))
			.mockResolvedValueOnce(true);
		const { context, ui } = createContext({ switchSession });
		const controller = new SelectorController(context);

		// Non-busy failures keep propagating to the caller.
		await expect(controller.handleResumeSession("/tmp/first.jsonl")).rejects.toThrow("switch exploded");

		await controller.handleResumeSession("/tmp/second.jsonl");
		expect(switchSession).toHaveBeenCalledTimes(2);
		expect(context.showStatus).toHaveBeenCalledWith("Resumed session");

		ui.stop();
	});

	it("reports a busy session transition as status instead of rejecting", async () => {
		const switchSession = vi.fn(async () => {
			throw busyTransitionError();
		});
		const { context, statusContainer, ui } = createContext({ switchSession });
		const controller = new SelectorController(context);

		await expect(controller.handleResumeSession("/tmp/target.jsonl")).resolves.toBeUndefined();
		expect(context.showStatus).toHaveBeenCalledWith("Another session operation is already in progress");
		expect(context.showStatus).not.toHaveBeenCalledWith("Resumed session");
		// The progress lease is still released on the busy path.
		expect(statusContainer.children).toHaveLength(0);

		ui.stop();
	});

	it("does not swallow busy-looking values that are not session-transition errors", async () => {
		const switchSession = vi.fn(async () => {
			throw new Error("busy");
		});
		const { context, ui } = createContext({ switchSession });
		const controller = new SelectorController(context);

		// Only the typed `code: "busy"` contract is absorbed; a message that merely
		// says "busy" is still a real failure.
		await expect(controller.handleResumeSession("/tmp/target.jsonl")).rejects.toThrow("busy");
		expect(context.showStatus).not.toHaveBeenCalledWith("Another session operation is already in progress");

		ui.stop();
	});

	it("preserves work queued by the transition that owns the session", async () => {
		const switchSession = vi.fn(async () => {
			throw busyTransitionError();
		});
		const { context, pendingMessagesContainer, ui } = createContext({ switchSession });
		const controller = new SelectorController(context);

		// State owned by the in-flight transition: input typed during compaction is
		// parked in `compactionQueuedMessages` and replayed when compaction ends.
		const queued: CompactionQueuedMessage[] = [{ text: "typed while compacting", mode: "steer" }];
		context.compactionQueuedMessages = queued;
		context.pendingTools.set("tool-1", {} as never);
		pendingMessagesContainer.addChild(new Text("queued", 0, 0));
		const loadingAnimation = { stop: vi.fn() };
		context.loadingAnimation = loadingAnimation as unknown as InteractiveModeContext["loadingAnimation"];

		await expect(controller.handleResumeSession("/tmp/target.jsonl")).resolves.toBeUndefined();

		// A rejected resume must not destroy the running transition's queued work or UI.
		expect(context.compactionQueuedMessages).toBe(queued);
		expect(context.compactionQueuedMessages).toHaveLength(1);
		expect(context.pendingTools.size).toBe(1);
		expect(pendingMessagesContainer.children).toHaveLength(1);
		expect(loadingAnimation.stop).not.toHaveBeenCalled();

		ui.stop();
	});

	it("clears transient session UI once the switch is committed", async () => {
		const switchSession = vi.fn(async () => true);
		const { context, pendingMessagesContainer, ui } = createContext({ switchSession });
		const controller = new SelectorController(context);

		context.compactionQueuedMessages = [{ text: "stale", mode: "steer" }];
		context.pendingTools.set("tool-1", {} as never);
		pendingMessagesContainer.addChild(new Text("stale", 0, 0));
		const loadingAnimation = { stop: vi.fn() };
		context.loadingAnimation = loadingAnimation as unknown as InteractiveModeContext["loadingAnimation"];

		await controller.handleResumeSession("/tmp/target.jsonl");

		expect(context.compactionQueuedMessages).toHaveLength(0);
		expect(context.pendingTools.size).toBe(0);
		expect(pendingMessagesContainer.children).toHaveLength(0);
		expect(loadingAnimation.stop).toHaveBeenCalled();
		expect(context.loadingAnimation).toBeUndefined();
		expect(context.showStatus).toHaveBeenCalledWith("Resumed session");

		ui.stop();
	});
});
