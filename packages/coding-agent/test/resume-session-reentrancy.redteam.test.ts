import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { Container, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { SessionManager } from "../src/session/session-manager";

beforeAll(() => initTheme());
afterEach(() => vi.restoreAllMocks());

type SwitchSession = (path: string, options?: unknown) => Promise<boolean>;

type ResumeHarnessOptions = {
	switchSession?: SwitchSession;
	getSessionId?: () => string;
	isManagedDestination?: () => boolean;
	prepareManagedCandidateForStrictAdoption?: (
		path: string,
		migrationPolicy: string,
		identity: unknown,
	) => Promise<string>;
	settingsGet?: (key: string) => unknown;
	rebuildInitialMessages?: () => void;
	reloadTodos?: () => Promise<void>;
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}

function busyTransitionError(): Error {
	return Object.assign(new Error("Cannot start switch-session while another transition owns the session."), {
		code: "busy",
	});
}

/** Opaque stand-ins for the transient handles the controller only stores and drops. */
type PendingToolHandle = NonNullable<ReturnType<InteractiveModeContext["pendingTools"]["get"]>>;
type LoadingAnimationStub = NonNullable<InteractiveModeContext["loadingAnimation"]> & { stop: Mock<() => void> };

type TransientSessionUiState = {
	compactionQueuedMessages: InteractiveModeContext["compactionQueuedMessages"];
	pendingMessage: Container;
	pendingTool: PendingToolHandle;
	streamingComponent: NonNullable<InteractiveModeContext["streamingComponent"]>;
	streamingMessage: NonNullable<InteractiveModeContext["streamingMessage"]>;
	loadingAnimation: LoadingAnimationStub;
};

function seedTransientSessionUi(context: InteractiveModeContext): TransientSessionUiState {
	const state: TransientSessionUiState = {
		compactionQueuedMessages: [{ text: "typed while compacting", mode: "steer" }],
		pendingMessage: new Container(),
		pendingTool: {} as unknown as PendingToolHandle,
		streamingComponent: {} as unknown as NonNullable<InteractiveModeContext["streamingComponent"]>,
		streamingMessage: {} as unknown as NonNullable<InteractiveModeContext["streamingMessage"]>,
		loadingAnimation: { stop: vi.fn() } as unknown as LoadingAnimationStub,
	};
	context.compactionQueuedMessages = state.compactionQueuedMessages;
	context.pendingMessagesContainer.addChild(state.pendingMessage);
	context.pendingTools.set("queued-tool", state.pendingTool);
	context.streamingComponent = state.streamingComponent;
	context.streamingMessage = state.streamingMessage;
	context.loadingAnimation = state.loadingAnimation;
	return state;
}

function expectTransientSessionUiPreserved(context: InteractiveModeContext, state: TransientSessionUiState): void {
	expect(context.compactionQueuedMessages).toBe(state.compactionQueuedMessages);
	expect(context.compactionQueuedMessages).toHaveLength(1);
	expect(context.pendingMessagesContainer.children).toContain(state.pendingMessage);
	expect(context.pendingTools.get("queued-tool")).toBe(state.pendingTool);
	expect(context.streamingComponent).toBe(state.streamingComponent);
	expect(context.streamingMessage).toBe(state.streamingMessage);
	expect(context.loadingAnimation).toBe(state.loadingAnimation);
	expect(state.loadingAnimation.stop).not.toHaveBeenCalled();
}

function createResumeHarness(options: ResumeHarnessOptions = {}): {
	context: InteractiveModeContext;
	statusContainer: Container;
	ui: TUI;
	switchSession: SwitchSession;
	showStatus: Mock<(message: string) => void>;
	dispose(): void;
} {
	const terminal = new VirtualTerminal(80, 12);
	const ui = new TUI(terminal);
	const statusContainer = new Container();
	ui.addChild(statusContainer);
	ui.start();

	const switchSession = options.switchSession ?? vi.fn(async () => true);
	const showStatus = vi.fn<(message: string) => void>();
	const context = {
		ui,
		statusContainer,
		loadingAnimation: undefined,
		pendingMessagesContainer: new Container(),
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		session: { switchSession },
		settings: { get: options.settingsGet ?? (() => undefined) },
		sessionManager: {
			getSessionId: options.getSessionId ?? (() => "before"),
			isManagedDestination: options.isManagedDestination ?? (() => false),
			prepareManagedCandidateForStrictAdoption:
				options.prepareManagedCandidateForStrictAdoption ?? (async (path: string) => path),
			getSessionName: () => undefined,
			getCwd: () => "/tmp",
		},
		resetIrcSidebarSession: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		rebuildInitialMessages: options.rebuildInitialMessages ?? vi.fn(),
		reloadTodos: options.reloadTodos ?? vi.fn(async () => undefined),
		showStatus,
	} as unknown as InteractiveModeContext;

	return {
		context,
		statusContainer,
		ui,
		switchSession,
		showStatus,
		dispose() {
			ui.stop();
		},
	};
}

describe("handleResumeSession adversarial re-entrancy", () => {
	it("serializes a storm of six resume requests without rejecting callers", async () => {
		const switchStarted = deferred<void>();
		const switchResult = deferred<boolean>();
		const switchSession = vi.fn(async () => {
			switchStarted.resolve();
			return await switchResult.promise;
		});
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const resumes = Array.from({ length: 6 }, (_, index) =>
				controller.handleResumeSession(`/tmp/storm-${index}.jsonl`),
			);

			await switchStarted.promise;
			await expect(Promise.all(resumes.slice(1))).resolves.toEqual([
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
			]);
			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).toHaveBeenCalledTimes(5);
			expect(harness.showStatus).toHaveBeenLastCalledWith("Resume already in progress");

			switchResult.resolve(true);
			await expect(Promise.all(resumes)).resolves.toHaveLength(6);
			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("releases its guard after a typed busy session-transition rejection", async () => {
		const switchSession = vi
			.fn<SwitchSession>()
			.mockRejectedValueOnce(busyTransitionError())
			.mockResolvedValueOnce(true);
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/busy.jsonl")).resolves.toBeUndefined();
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();

			expect(switchSession).toHaveBeenCalledTimes(2);
			expect(harness.showStatus).toHaveBeenCalledWith("Another session operation is already in progress");
			expect(harness.showStatus).toHaveBeenCalledWith("Resumed session");
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("propagates a synchronous managed-destination failure without stranding later resumes", async () => {
		const synchronousFailure = new Error("managed destination probe exploded");
		let throwOnProbe = true;
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({
			switchSession,
			isManagedDestination: () => {
				if (throwOnProbe) throw synchronousFailure;
				return false;
			},
		});
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/sync-failure.jsonl")).rejects.toBe(synchronousFailure);
			throwOnProbe = false;
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();

			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("propagates a typed busy rejection from managed-candidate preparation", async () => {
		const selectedPath = "/tmp/legacy.jsonl";
		const identity = {
			canonicalPath: selectedPath,
			sessionId: "legacy",
			dev: 1n,
			ino: 1n,
			size: 1,
			mtimeMs: 1,
			mtimeNs: 1n,
			sha256: "legacy",
		};
		const prepare = vi.fn(async () => {
			throw busyTransitionError();
		});
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({
			switchSession,
			isManagedDestination: () => true,
			prepareManagedCandidateForStrictAdoption: prepare,
		});
		vi.spyOn(SessionManager, "inspectSessionTailReadOnly").mockResolvedValue({ kind: "resumable", identity });
		try {
			const controller = new SelectorController(harness.context);

			// Busy translation is scoped to the switch call, so a typed busy raised by
			// preparation is a real failure and must reach the caller instead of being
			// reported as a blocked transition.
			await expect(controller.handleResumeSession(selectedPath)).rejects.toMatchObject({ code: "busy" });

			expect(prepare).toHaveBeenCalledWith(selectedPath, "copy-retain", identity);
			expect(switchSession).not.toHaveBeenCalled();
			expect(harness.showStatus).not.toHaveBeenCalledWith("Another session operation is already in progress");
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("does not mistake busy-looking errors for the typed busy contract", async () => {
		const values: Array<{ label: string; thrown: unknown }> = [
			{ label: "Error message", thrown: new Error("busy") },
			{ label: "string", thrown: "busy" },
			{ label: "uppercase code", thrown: { code: "BUSY" } },
			{ label: "numeric code", thrown: { code: 42 } },
		];

		for (const { label, thrown } of values) {
			const switchSession = vi.fn<SwitchSession>(async () => {
				throw thrown;
			});
			const harness = createResumeHarness({ switchSession });
			try {
				const controller = new SelectorController(harness.context);

				await expect(controller.handleResumeSession(`/tmp/${label}.jsonl`)).rejects.toBe(thrown);
				expect(harness.showStatus).not.toHaveBeenCalledWith("Another session operation is already in progress");
				expect(harness.statusContainer.children).toHaveLength(0);
			} finally {
				harness.dispose();
			}
		}
	});

	it("cleans up a cancelled switch and accepts the next resume", async () => {
		const switchSession = vi.fn<SwitchSession>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/cancelled.jsonl")).resolves.toBeUndefined();
			expect(harness.showStatus).not.toHaveBeenCalledWith("Resumed session");
			expect(harness.statusContainer.children).toHaveLength(0);

			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(2);
			expect(harness.showStatus).toHaveBeenCalledWith("Resumed session");
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("rejects resume re-entrancy from reloadTodos without corrupting the outer resume", async () => {
		let controller: SelectorController;
		let nestedResume: Promise<void> | undefined;
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({
			switchSession,
			reloadTodos: async () => {
				nestedResume = controller.handleResumeSession("/tmp/nested.jsonl");
				await nestedResume;
			},
		});
		try {
			controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/outer.jsonl")).resolves.toBeUndefined();

			expect(nestedResume).toBeDefined();
			await expect(nestedResume).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).toHaveBeenCalledWith("Resume already in progress");
			expect(harness.showStatus).toHaveBeenCalledWith("Resumed session");
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("does not strand its guard when setup throws before the progress lease exists", async () => {
		const synchronousFailure = new Error("session id lookup exploded");
		let throwOnLookup = true;
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({
			switchSession,
			getSessionId: () => {
				if (throwOnLookup) throw synchronousFailure;
				return "before";
			},
		});
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/setup-failure.jsonl")).rejects.toBe(synchronousFailure);
			throwOnLookup = false;
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();

			expect(switchSession).toHaveBeenCalledTimes(1);
		} finally {
			harness.dispose();
		}
	});
	it("RT-9 preserves previous-session transient state on the paths that never held the lease", async () => {
		const selectedPath = "/tmp/managed.jsonl";
		const identity = {
			canonicalPath: selectedPath,
			sessionId: "managed",
			dev: 1n,
			ino: 1n,
			size: 1,
			mtimeMs: 1,
			mtimeNs: 1n,
			sha256: "managed",
		};
		// Only admission-busy and managed-candidate preparation run without the
		// session-transition lease, so only they must leave the owner's state intact. A
		// `false` switch already held the lease and may be a post-abort rollback, so it
		// clears instead, matching `dev` (RT-15).
		const scenarios = ["typed busy", "preparation failure"] as const;

		for (const scenario of scenarios) {
			const preparationFailure = new Error("managed-candidate preparation exploded");
			const switchSession = vi.fn<SwitchSession>(async () => {
				if (scenario === "typed busy") throw busyTransitionError();
				return true;
			});
			const harness = createResumeHarness({
				switchSession,
				isManagedDestination: () => scenario === "preparation failure",
				prepareManagedCandidateForStrictAdoption: async path => {
					if (scenario === "preparation failure") throw preparationFailure;
					return path;
				},
			});
			if (scenario === "preparation failure") {
				vi.spyOn(SessionManager, "inspectSessionTailReadOnly").mockResolvedValue({ kind: "resumable", identity });
			}
			try {
				const controller = new SelectorController(harness.context);
				const state = seedTransientSessionUi(harness.context);

				if (scenario === "preparation failure") {
					await expect(controller.handleResumeSession(selectedPath)).rejects.toBe(preparationFailure);
					expect(switchSession).not.toHaveBeenCalled();
				} else {
					await expect(controller.handleResumeSession(`/tmp/${scenario}.jsonl`)).resolves.toBeUndefined();
					expect(switchSession).toHaveBeenCalledTimes(1);
					expect(harness.showStatus).toHaveBeenCalledWith("Another session operation is already in progress");
				}

				expectTransientSessionUiPreserved(harness.context, state);
				expect(harness.statusContainer.children).toHaveLength(0);
			} finally {
				harness.dispose();
			}
		}
	});

	it("RT-10 clears all previous-session transient state once the switch is admitted", async () => {
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const state = seedTransientSessionUi(harness.context);

			await expect(controller.handleResumeSession("/tmp/committed.jsonl")).resolves.toBeUndefined();

			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.context.compactionQueuedMessages).toHaveLength(0);
			expect(harness.context.pendingMessagesContainer.children).toHaveLength(0);
			expect(harness.context.pendingTools.size).toBe(0);
			expect(harness.context.streamingComponent).toBeUndefined();
			expect(harness.context.streamingMessage).toBeUndefined();
			expect(harness.context.loadingAnimation).toBeUndefined();
			expect(state.loadingAnimation.stop).toHaveBeenCalledTimes(1);
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("RT-15 distinguishes pre-mutation cancellation from post-mutation rollback", async () => {
		let attempt = 0;
		const switchSession = vi.fn<SwitchSession>(async (_path, options) => {
			attempt++;
			if (attempt === 1) return false;
			if (attempt === 2) {
				(options as { onTransitionMutationStarted?: () => void } | undefined)?.onTransitionMutationStarted?.();
				return false;
			}
			return true;
		});
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const state = seedTransientSessionUi(harness.context);

			await expect(controller.handleResumeSession("/tmp/pre-hook-cancelled.jsonl")).resolves.toBeUndefined();

			expectTransientSessionUiPreserved(harness.context, state);
			expect(harness.showStatus).not.toHaveBeenCalledWith("Resumed session");
			expect(harness.context.rebuildInitialMessages).not.toHaveBeenCalled();
			expect(harness.statusContainer.children).toHaveLength(0);

			await expect(controller.handleResumeSession("/tmp/rolled-back.jsonl")).resolves.toBeUndefined();

			expect(harness.context.streamingComponent).toBeUndefined();
			expect(harness.context.streamingMessage).toBeUndefined();
			expect(harness.context.pendingTools.size).toBe(0);
			expect(harness.context.pendingMessagesContainer.children).toHaveLength(0);
			expect(harness.context.compactionQueuedMessages).toHaveLength(0);
			expect(harness.context.loadingAnimation).toBeUndefined();
			expect(state.loadingAnimation.stop).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).not.toHaveBeenCalledWith("Resumed session");
			expect(harness.context.rebuildInitialMessages).not.toHaveBeenCalled();
			expect(harness.statusContainer.children).toHaveLength(0);

			// Both cancellation paths release the guard, so a later resume proceeds normally.
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(3);
			expect(harness.showStatus).toHaveBeenCalledWith("Resumed session");
		} finally {
			harness.dispose();
		}
	});

	it("RT-17 preserves transient state before rethrowing a pre-mutation switch rejection", async () => {
		const hookFailure = new Error("session_before_switch rejected");
		const switchSession = vi.fn<SwitchSession>().mockRejectedValueOnce(hookFailure).mockResolvedValueOnce(true);
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const state = seedTransientSessionUi(harness.context);

			await expect(controller.handleResumeSession("/tmp/rejected-before-switch.jsonl")).rejects.toBe(hookFailure);

			expectTransientSessionUiPreserved(harness.context, state);
			expect(harness.showStatus).not.toHaveBeenCalledWith("Another session operation is already in progress");
			expect(harness.statusContainer.children).toHaveLength(0);

			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(2);
		} finally {
			harness.dispose();
		}
	});

	it("RT-18 clears transient state before rethrowing a post-mutation switch rejection", async () => {
		const rollbackFailure = new Error("session restore exploded after abort");
		let rejectAfterMutation = true;
		const switchSession = vi.fn<SwitchSession>(async (_path, options) => {
			if (rejectAfterMutation) {
				rejectAfterMutation = false;
				(options as { onTransitionMutationStarted?: () => void } | undefined)?.onTransitionMutationStarted?.();
				throw rollbackFailure;
			}
			return true;
		});
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const state = seedTransientSessionUi(harness.context);

			await expect(controller.handleResumeSession("/tmp/rejected-rollback.jsonl")).rejects.toBe(rollbackFailure);

			expect(harness.context.streamingComponent).toBeUndefined();
			expect(harness.context.streamingMessage).toBeUndefined();
			expect(harness.context.pendingTools.size).toBe(0);
			expect(harness.context.pendingMessagesContainer.children).toHaveLength(0);
			expect(harness.context.compactionQueuedMessages).toHaveLength(0);
			expect(harness.context.loadingAnimation).toBeUndefined();
			expect(state.loadingAnimation.stop).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).not.toHaveBeenCalledWith("Another session operation is already in progress");
			expect(harness.statusContainer.children).toHaveLength(0);

			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(2);
		} finally {
			harness.dispose();
		}
	});

	it("RT-16 releases the guard when the post-switch model-choice prompt throws", async () => {
		// `#maybePromptResumeModelChoice` runs after the success status. A throw there must
		// still propagate and must not strand the guard for later resumes.
		const promptFailure = new Error("model choice prompt exploded");
		let throwOnPrompt = true;
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({
			switchSession,
			settingsGet: key => {
				if (key !== "session.resumeModelBehavior") return undefined;
				if (throwOnPrompt) throw promptFailure;
				return undefined;
			},
		});
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/prompt-throw.jsonl")).rejects.toBe(promptFailure);
			expect(harness.showStatus).toHaveBeenCalledWith("Resumed session");

			throwOnPrompt = false;
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(2);
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("RT-11 clears the committed progress lease idempotently and mounts a fresh lease on retry", async () => {
		let statusContainer: Container | undefined;
		const activeLoaderCounts: number[] = [];
		const mountedLoaders: unknown[] = [];
		const switchSession = vi.fn<SwitchSession>(async () => {
			activeLoaderCounts.push(statusContainer?.children.length ?? -1);
			mountedLoaders.push(statusContainer?.children[0]);
			return true;
		});
		const harness = createResumeHarness({ switchSession });
		statusContainer = harness.statusContainer;
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/first.jsonl")).resolves.toBeUndefined();
			expect(activeLoaderCounts).toEqual([1]);
			expect(mountedLoaders[0]).toBeDefined();
			expect(harness.statusContainer.children).toHaveLength(0);

			await expect(controller.handleResumeSession("/tmp/second.jsonl")).resolves.toBeUndefined();
			expect(activeLoaderCounts).toEqual([1, 1]);
			expect(mountedLoaders[1]).toBeDefined();
			expect(mountedLoaders[1]).not.toBe(mountedLoaders[0]);
			expect(harness.statusContainer.children).toHaveLength(0);
			expect(switchSession).toHaveBeenCalledTimes(2);
		} finally {
			harness.dispose();
		}
	});

	it("RT-12 releases the guard when progress-lease acquisition throws from the status rail", async () => {
		const leaseFailure = new Error("status rail rejected progress loader");
		let rejectLeaseMount = true;
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({ switchSession });
		const originalAddChild = harness.statusContainer.addChild.bind(harness.statusContainer);
		vi.spyOn(harness.statusContainer, "addChild").mockImplementation(child => {
			if (rejectLeaseMount) throw leaseFailure;
			originalAddChild(child);
		});
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/lease-failure.jsonl")).rejects.toBe(leaseFailure);
			rejectLeaseMount = false;
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();

			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("RT-13 propagates a typed busy failure after a committed switch and releases the guard", async () => {
		const reloadFailure = busyTransitionError();
		let rejectReload = true;
		const switchSession = vi.fn<SwitchSession>(async () => true);
		const harness = createResumeHarness({
			switchSession,
			reloadTodos: async () => {
				if (rejectReload) throw reloadFailure;
			},
		});
		try {
			const controller = new SelectorController(harness.context);

			await expect(controller.handleResumeSession("/tmp/reload-failure.jsonl")).rejects.toBe(reloadFailure);
			expect(harness.showStatus).not.toHaveBeenCalledWith("Another session operation is already in progress");
			rejectReload = false;
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();

			expect(switchSession).toHaveBeenCalledTimes(2);
			expect(harness.showStatus).toHaveBeenCalledWith("Resumed session");
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});

	it("RT-14 suppresses an overlapping resume while the owning switch later reports busy", async () => {
		const switchStarted = deferred<void>();
		const switchResult = deferred<boolean>();
		const switchSession = vi.fn<SwitchSession>(async () => {
			switchStarted.resolve();
			return await switchResult.promise;
		});
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const firstResume = controller.handleResumeSession("/tmp/first.jsonl");

			await switchStarted.promise;
			await expect(controller.handleResumeSession("/tmp/overlap.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).toHaveBeenLastCalledWith("Resume already in progress");

			switchResult.reject(busyTransitionError());
			await expect(firstResume).resolves.toBeUndefined();

			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).toHaveBeenCalledTimes(2);
			expect(harness.showStatus).toHaveBeenNthCalledWith(1, "Resume already in progress");
			expect(harness.showStatus).toHaveBeenNthCalledWith(2, "Another session operation is already in progress");
			expect(harness.statusContainer.children).toHaveLength(0);
		} finally {
			harness.dispose();
		}
	});
	it("RT-18 absorbs a frozen null-prototype busy rejection without touching the foreign transition UI", async () => {
		const frozenBusyError = Object.freeze(Object.assign(Object.create(null), { code: "busy" as const }));
		const switchSession = vi.fn<SwitchSession>().mockRejectedValueOnce(frozenBusyError).mockResolvedValueOnce(true);
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const state = seedTransientSessionUi(harness.context);

			await expect(controller.handleResumeSession("/tmp/frozen-busy.jsonl")).resolves.toBeUndefined();

			expect(harness.showStatus).toHaveBeenCalledWith("Another session operation is already in progress");
			expectTransientSessionUiPreserved(harness.context, state);
			expect(harness.statusContainer.children).toHaveLength(0);

			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(2);
		} finally {
			harness.dispose();
		}
	});

	it("RT-19 rethrows the original switch rejection when transient UI cleanup fails", async () => {
		const switchFailure = new Error("switch rejected after abort");
		const cleanupFailure = new Error("pending message cleanup exploded");
		let rejectAfterMutation = true;
		const switchSession = vi.fn<SwitchSession>(async (_path, options) => {
			if (rejectAfterMutation) {
				rejectAfterMutation = false;
				(options as { onTransitionMutationStarted?: () => void } | undefined)?.onTransitionMutationStarted?.();
				throw switchFailure;
			}
			return true;
		});
		const harness = createResumeHarness({ switchSession });
		try {
			const controller = new SelectorController(harness.context);
			const pendingClear = vi.spyOn(harness.context.pendingMessagesContainer, "clear").mockImplementation(() => {
				throw cleanupFailure;
			});

			const observed = await controller.handleResumeSession("/tmp/cleanup-failure.jsonl").then(
				() => undefined,
				error => error,
			);
			expect(pendingClear).toHaveBeenCalledTimes(1);
			expect(harness.statusContainer.children).toHaveLength(0);

			// `finally` must still release the guard even when cleanup itself fails.
			pendingClear.mockRestore();
			await expect(controller.handleResumeSession("/tmp/retry.jsonl")).resolves.toBeUndefined();
			expect(switchSession).toHaveBeenCalledTimes(2);

			// Contract item 3 requires the original switch error to reach the caller.
			expect(observed).toBe(switchFailure);
		} finally {
			harness.dispose();
		}
	});
	it("RT-20 preserves previous-session transient state for settings, probe, and inspection failures", async () => {
		const selectedPath = "/tmp/pre-switch-failure.jsonl";
		const scenarios = ["settings", "managed destination probe", "inspection"] as const;

		for (const scenario of scenarios) {
			const failure = new Error(`${scenario} exploded`);
			const switchSession = vi.fn<SwitchSession>(async () => true);
			const harness = createResumeHarness({
				switchSession,
				settingsGet: () => {
					if (scenario === "settings") throw failure;
					return undefined;
				},
				isManagedDestination: () => {
					if (scenario === "managed destination probe") throw failure;
					return scenario === "inspection";
				},
			});
			if (scenario === "inspection") {
				vi.spyOn(SessionManager, "inspectSessionTailReadOnly").mockRejectedValue(failure);
			}
			try {
				const controller = new SelectorController(harness.context);
				const state = seedTransientSessionUi(harness.context);

				await expect(controller.handleResumeSession(selectedPath)).rejects.toBe(failure);
				expect(switchSession).not.toHaveBeenCalled();
				expectTransientSessionUiPreserved(harness.context, state);
				expect(harness.statusContainer.children).toHaveLength(0);
			} finally {
				harness.dispose();
				vi.restoreAllMocks();
			}
		}
	});
});
