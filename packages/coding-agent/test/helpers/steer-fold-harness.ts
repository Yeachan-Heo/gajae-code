/**
 * Shared harness for steer-triggered bash fold tests.
 *
 * Wires an enqueue-time steering-arrival seam, a real `AsyncJobManager`, and a
 * real `FoldCoordinator` behind a minimal `ToolSession`. The production Agent
 * integration is covered by sdk-steer-fold-live-session.test.ts; this harness
 * isolates Bash fold races while preserving the contract that each wait sees
 * only a steer admitted after that wait starts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { AsyncJobManager, type FoldReason, type JobFoldEvent } from "@gajae-code/coding-agent/async";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { type FoldAdapter, FoldCoordinator } from "@gajae-code/coding-agent/session/fold-coordinator";
import type { ToolSession } from "@gajae-code/coding-agent/tools";

export interface SteerHarness {
	session: ToolSession;
	coordinator: FoldCoordinator;
	manager: AsyncJobManager;
	/** Admit a steer into the simulated live run (never consumed by the harness). */
	steer: (text?: string) => void;
	hasQueuedSteering: () => boolean;
	fenceArmed: () => boolean;
	stopRequested: () => boolean;
	folds: JobFoldEvent[];
	/** Flip the busy-prompt setting after the harness was built. */
	setBusyPromptMode: (mode: "steer" | "queue") => void;
}

export interface SteerHarnessOptions {
	busyPromptMode?: "steer" | "queue";
	toolInterruptPolicy?: "abort_tools" | "finish_tools";
	autoBackgroundEnabled?: boolean;
	autoBackgroundThresholdMs?: number;
	/** Omit the tool-interrupt-policy accessor (fail-closed regression). */
	omitToolInterruptPolicy?: boolean;
	/** Omit the steering-arrival waiter (fail-closed regression). */
	omitSteeringWait?: boolean;
	/** Manager retention for evicted-record probes. */
	retentionMs?: number;
}

/** A tool context that marks the call as owned by a live Agent turn (originatingTurn=true). */
export function turnContext(): AgentToolContext {
	return {
		attemptScope: { attemptId: "attempt-1", generation: 1, lineage: "main" },
	} as unknown as AgentToolContext;
}

/**
 * A turn context that additionally advertises a UI host so `bash` selects the
 * PTY overlay. The fake overlay renders nothing and resolves the foreground
 * only through the runner's `done` callback, exactly like the real TUI host.
 */
export function ptyTurnContext(): AgentToolContext {
	const ui = {
		custom<T>(factory: unknown): Promise<T> {
			const result = Promise.withResolvers<T>();
			let component: { dispose?: () => void } | undefined;
			const done = (value: T) => {
				component?.dispose?.();
				result.resolve(value);
			};
			try {
				component = (
					factory as (
						tui: { terminal: { rows: number; columns: number }; requestRender: () => void },
						theme: Record<string, never>,
						keybindings: Record<string, never>,
						done: (result: T) => void,
					) => { dispose?: () => void }
				)({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, {}, {}, done);
			} catch (error) {
				result.reject(error);
			}
			return result.promise;
		},
	};
	return {
		attemptScope: { attemptId: "attempt-1", generation: 1, lineage: "main" },
		hasUI: true,
		ui,
	} as unknown as AgentToolContext;
}

export function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

export function createSteerHarness(cwd: string, options: SteerHarnessOptions = {}): SteerHarness {
	const manager = new AsyncJobManager({ onJobComplete: async () => {}, retentionMs: options.retentionMs });
	AsyncJobManager.setInstance(manager);
	const steeringWaiters = new Set<() => void>();
	let queuedSteering = false;
	let fenceArmed = false;
	let stopRequested = false;
	const coordinator = new FoldCoordinator({
		hasActiveTurn: () => true,
		armSteeringFence: () => {
			fenceArmed = true;
			return () => {
				fenceArmed = false;
			};
		},
		requestStop: () => {
			stopRequested = true;
		},
		captureRemainingIntent: () => undefined,
		deliverParked: () => {},
	});
	const folds: JobFoldEvent[] = [];
	manager.onFold(event => folds.push(event));
	const settings = Settings.isolated({
		"bash.autoBackground.enabled": options.autoBackgroundEnabled ?? false,
		"bash.autoBackground.thresholdMs": options.autoBackgroundThresholdMs ?? 60_000,
		busyPromptMode: options.busyPromptMode ?? "steer",
	});
	const sessionDir = path.join(cwd, "session");
	let artifactCounter = 0;
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getSessionId: () => "steer-fold-session",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		getAsyncJobManager: () => manager,
		registerForegroundFoldParticipant: adapter => coordinator.registerParticipant(adapter),
		hasForegroundBashBackgroundRequestHandler: () => coordinator.hasFoldableParticipant(),
		requestForegroundBashBackground: async (reason?: FoldReason, adapter?: FoldAdapter) =>
			(await coordinator.requestFold(adapter, reason)).status === "folded",
		...(options.omitToolInterruptPolicy
			? {}
			: { getToolInterruptPolicy: () => options.toolInterruptPolicy ?? "abort_tools" }),
		...(options.omitSteeringWait
			? {}
			: {
					waitForUserSteering: (signal: AbortSignal) => {
						if (signal.aborted) return Promise.resolve();
						const { promise, resolve } = Promise.withResolvers<void>();
						const settle = () => {
							steeringWaiters.delete(settle);
							signal.removeEventListener("abort", settle);
							resolve();
						};
						steeringWaiters.add(settle);
						signal.addEventListener("abort", settle, { once: true });
						return promise;
					},
				}),
	};
	return {
		session,
		coordinator,
		manager,
		steer: () => {
			queuedSteering = true;
			for (const resolve of [...steeringWaiters]) resolve();
		},
		hasQueuedSteering: () => queuedSteering,
		fenceArmed: () => fenceArmed,
		stopRequested: () => stopRequested,
		folds,
		setBusyPromptMode: mode => settings.set("busyPromptMode", mode),
	};
}
