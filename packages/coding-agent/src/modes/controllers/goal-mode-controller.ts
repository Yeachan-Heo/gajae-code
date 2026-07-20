import { consumePendingGoalModeRequest } from "../../gjc-runtime/goal-mode-request";
import {
	canonicalArgsKey,
	classifyToolOutcome,
	decideTimeoutHold,
	type TimeoutToolOutcome,
	toResultText,
	turnTimeoutFingerprint,
} from "../../goals/continuation-timeout-guard";
import { type Goal, type GoalModeState, normalizeGoal } from "../../goals/state";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { SessionContext, SessionManager } from "../../session/session-manager";
import { formatDuration } from "../../slash-commands/helpers/format";
import type { SubmittedUserInput } from "../types";
import type { ModeGate } from "./mode-gate";

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop"]);

interface GoalModeControllerContext {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly modeGate: ModeGate;
	get planModeActive(): boolean;
	get inputCallback(): ((input: SubmittedUserInput) => void) | undefined;
	get hasPendingSubmission(): boolean;
	get hasPendingImages(): boolean;
	get editorText(): string;
	startPendingSubmission(input: { text: string; customType?: string; display?: boolean }): SubmittedUserInput;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	showHookSelector(title: string, options: string[]): Promise<string | undefined>;
	showHookEditor(title: string, options?: { promptStyle?: boolean }): Promise<string | undefined>;
	updateGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void;
}

function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

/** Owns goal-mode state, continuation scheduling, commands, and session restoration. */
export class GoalModeController {
	#enabled = false;
	#paused = false;
	#previousTools: string[] | undefined;
	#continuationTimer: NodeJS.Timeout | undefined;
	#turnHadToolCalls = false;
	#continuationTurnInFlight = false;
	#suppressNextContinuation = false;
	#goalTurnToolStarts = new Map<string, { toolName: string; argsKey: string }>();
	#goalTurnOutcomes: TimeoutToolOutcome[] = [];
	#goalTurnUnpaired = false;
	#goalTurnSnapshotKey: string | undefined;
	#goalHeldSnapshotKey: string | undefined;
	#goalTimeoutFingerprint: string | undefined;
	#goalIdenticalTimeoutStreak = 0;

	constructor(private readonly ctx: GoalModeControllerContext) {}

	get enabled(): boolean {
		return this.#enabled;
	}

	get paused(): boolean {
		return this.#paused;
	}

	setEnabledForCompatibility(enabled: boolean): void {
		this.#enabled = enabled;
	}

	setPausedForCompatibility(paused: boolean): void {
		this.#paused = paused;
	}

	async beforeGetUserInput(): Promise<void> {
		if (this.ctx.session.getGoalModeState()?.mode === "exiting") {
			await this.exit({ reason: "completed", silent: true });
		}
	}

	scheduleContinuation(): void {
		this.cancelContinuation();
		if (!this.ctx.inputCallback) return;
		if (!this.ctx.session.settings.get("goal.continuationModes").includes("interactive")) return;
		if (this.ctx.planModeActive || !this.#enabled || this.#paused || this.#suppressNextContinuation) return;
		if (this.ctx.hasPendingSubmission || this.ctx.editorText.trim() || this.ctx.hasPendingImages) return;
		const state = this.ctx.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.ctx.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#continuationTimer = setTimeout(() => {
			this.#continuationTimer = undefined;
			if (!this.ctx.inputCallback || !this.#enabled || this.#paused) return;
			if (this.ctx.hasPendingSubmission || this.ctx.editorText.trim() || this.ctx.hasPendingImages) return;
			if (this.ctx.session.isStreaming || this.ctx.session.isCompacting) {
				this.scheduleContinuation();
				return;
			}
			const latestState = this.ctx.session.getGoalModeState();
			if (!latestState?.enabled || latestState.goal.status !== "active") return;
			this.#continuationTurnInFlight = true;
			this.ctx.inputCallback(
				this.ctx.startPendingSubmission({ text: prompt, customType: "goal-continuation", display: false }),
			);
		}, 800);
	}

	cancelContinuation(): void {
		if (this.#continuationTimer) clearTimeout(this.#continuationTimer);
		this.#continuationTimer = undefined;
	}

	onPendingSubmissionFinished(customType?: string): void {
		if (customType === "goal-continuation") this.#continuationTurnInFlight = false;
	}

	onUserSubmission(): void {
		this.#resetContinuationSuppression();
	}

	async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.#turnHadToolCalls = false;
			this.#goalTurnToolStarts.clear();
			this.#goalTurnOutcomes = [];
			this.#goalTurnUnpaired = false;
			const goal = this.ctx.session.getGoalModeState()?.goal;
			this.#goalTurnSnapshotKey = goal ? `${goal.id}\u0000${goal.objective}` : undefined;
			this.cancelContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#turnHadToolCalls = true;
			this.#goalTurnToolStarts.set(event.toolCallId, {
				toolName: event.toolName,
				argsKey: canonicalArgsKey(event.args),
			});
			if (!this.#continuationTurnInFlight) this.#resetContinuationSuppression();
			return;
		}
		if (event.type === "tool_execution_end") {
			const start = this.#goalTurnToolStarts.get(event.toolCallId);
			if (!start) {
				this.#turnHadToolCalls = true;
				this.#goalTurnUnpaired = true;
			} else {
				this.#goalTurnOutcomes.push({
					...start,
					kind: classifyToolOutcome(event.isError, toResultText(event.result)),
				});
				this.#goalTurnToolStarts.delete(event.toolCallId);
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.#resetContinuationSuppression();
			return;
		}
		if (event.type === "goal_updated") {
			if (event.state?.goal?.status === "dropped") {
				await this.exit({ reason: "dropped", silent: true });
				return;
			}
			const goal = event.state?.goal;
			const snapshotKey = goal ? `${goal.id}\u0000${goal.objective}` : undefined;
			if (this.#goalHeldSnapshotKey !== undefined && this.#goalHeldSnapshotKey !== snapshotKey)
				this.#resetContinuationSuppression();
			if (event.state?.enabled && !this.#previousTools) this.#previousTools = this.ctx.session.getActiveToolNames();
			this.#enabled = event.state?.enabled === true;
			this.#paused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (this.#enabled || this.#paused) this.ctx.modeGate.enter("goal");
			else this.ctx.modeGate.exit("goal");
			if (!event.state?.enabled) {
				this.#resetContinuationSuppression();
				this.cancelContinuation();
			}
			this.#updateStatus();
			return;
		}
		if (event.type !== "agent_end") return;
		if (this.#continuationTurnInFlight) {
			this.#suppressNextContinuation = !this.#turnHadToolCalls;
			const fingerprint =
				this.#goalTurnToolStarts.size > 0 || this.#goalTurnUnpaired
					? null
					: turnTimeoutFingerprint(this.#goalTurnOutcomes);
			const decision = decideTimeoutHold(
				{
					heldSnapshotKey: this.#goalHeldSnapshotKey,
					fingerprint: this.#goalTimeoutFingerprint,
					streak: this.#goalIdenticalTimeoutStreak,
				},
				{ snapshotKey: this.#goalTurnSnapshotKey ?? "", fingerprint },
			);
			if (fingerprint === null) this.#resetTimeoutHold();
			else {
				this.#goalHeldSnapshotKey = decision.next.heldSnapshotKey;
				this.#goalTimeoutFingerprint = decision.next.fingerprint;
				this.#goalIdenticalTimeoutStreak = decision.next.streak;
			}
			if (decision.hold) {
				this.#suppressNextContinuation = true;
				this.ctx.showStatus(
					`Goal paused for attention: repeated identical timeout from ${this.#goalTurnOutcomes[0]?.toolName ?? "tool"}. Send a message to continue.`,
				);
			}
			this.#continuationTurnInFlight = false;
		} else {
			this.#resetTimeoutHold();
		}
		if (this.ctx.session.getGoalModeState()?.mode === "exiting") {
			await this.exit({ reason: "completed", silent: true });
			return;
		}
		this.scheduleContinuation();
	}

	/**
	 * Restore durable goal state. Recovery hydration deliberately performs only
	 * in-memory restoration: it neither consumes a pending request nor repairs
	 * invalid persisted state by writing a fallback mode entry.
	 */
	async restoreFromSession(
		sessionContext: SessionContext,
		options?: { recoveryHydration?: boolean },
	): Promise<boolean> {
		const recoveryHydration = options?.recoveryHydration === true;
		const goalEnabled = this.ctx.session.settings.get("goal.enabled");
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			if (recoveryHydration) return false;
			this.ctx.sessionManager.appendModeChange("none");
			return true;
		}
		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			const goal = normalizeGoal(sessionContext.modeData?.goal) ?? undefined;
			if (!goal) {
				if (recoveryHydration) throw new Error("Recovery hydration rejected an invalid persisted goal state.");
				this.ctx.sessionManager.appendModeChange("none");
				return true;
			}
			this.ctx.session.setGoalModeState({ enabled: sessionContext.mode === "goal", mode: "active", goal });
			if (recoveryHydration) {
				this.#enabled = sessionContext.mode === "goal";
				this.#paused = sessionContext.mode === "goal_paused";
				if (this.#enabled || this.#paused) this.ctx.modeGate.enter("goal");
				this.#updateStatus();
				return true;
			}
			const restored = await this.ctx.session.goalRuntime.onThreadResumed();
			this.#enabled = restored?.enabled === true;
			this.#paused = restored?.enabled !== true && restored?.goal.status === "paused";
			if (this.#enabled || this.#paused) this.ctx.modeGate.enter("goal");
			if (restored?.goal) {
				this.#previousTools = this.ctx.session.getActiveToolNames();
				await this.ctx.session.setActiveToolsByName([...new Set([...this.#previousTools, "goal"])]);
			}
			this.#updateStatus();
			return true;
		}
		if (recoveryHydration) return false;
		const pendingGoal = goalEnabled
			? await consumePendingGoalModeRequest(this.ctx.sessionManager.getCwd(), this.ctx.sessionManager.getSessionId())
			: null;
		if (!pendingGoal) return false;
		await this.enter({ objective: pendingGoal.objective, provenance: pendingGoal.provenance, silent: true });
		this.scheduleContinuation();
		return true;
	}

	async handleCommand(rest?: string): Promise<void> {
		try {
			if (this.ctx.planModeActive) return this.ctx.showWarning("Exit plan mode first.");
			if (!this.ctx.session.settings.get("goal.enabled"))
				return this.ctx.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
			const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
			if (sub) return await this.#dispatchSubcommand(sub, subRest);
			if (this.#enabled) {
				if (subRest)
					return this.ctx.showStatus(
						"Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
					);
				return await this.#openMenu("active");
			}
			if (this.#getPausedState()) {
				if (subRest)
					return this.ctx.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return await this.#openMenu("paused");
			}
			const objective = subRest || (await this.ctx.showHookEditor("Goal objective", { promptStyle: true }))?.trim();
			if (objective) await this.#startFromObjective(objective);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	async enter(options: {
		objective?: string;
		provenance?: Goal["provenance"];
		resume?: boolean;
		silent?: boolean;
	}): Promise<void> {
		if (this.#enabled) return;
		if (!this.ctx.modeGate.enter("goal")) return this.ctx.showWarning("Exit plan mode first.");
		this.#previousTools = this.ctx.session.getActiveToolNames();
		this.#paused = false;
		const state = options.resume
			? await this.ctx.session.goalRuntime.resumeGoal()
			: await this.ctx.session.goalRuntime.createGoal({
					objective: options.objective ?? "",
					provenance: options.provenance,
				});
		await this.ctx.session.setActiveToolsByName([...new Set([...this.#previousTools, "goal"])]);
		this.ctx.session.setGoalModeState(state);
		this.#enabled = true;
		this.#resetContinuationSuppression();
		this.#updateStatus();
		if (this.ctx.session.isStreaming) await this.ctx.session.sendGoalModeContext({ deliverAs: "steer" });
		if (!options.silent) this.ctx.showStatus(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
	}

	async exit(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		const shouldRestoreTools =
			this.#previousTools &&
			options?.reason !== "dropped" &&
			(this.#enabled || options?.reason === "completed" || options?.paused);
		if (shouldRestoreTools && this.#previousTools) await this.ctx.session.setActiveToolsByName(this.#previousTools);
		const currentState = this.ctx.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.ctx.session.setGoalModeState(undefined);
			this.ctx.sessionManager.appendModeChange("none");
			this.ctx.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.#enabled = false;
		this.#paused = options?.paused ?? false;
		this.#previousTools = undefined;
		this.#continuationTurnInFlight = false;
		this.#resetContinuationSuppression();
		this.cancelContinuation();
		if (!this.#paused) this.ctx.modeGate.exit("goal");
		this.#updateStatus();
		if (!options?.silent)
			this.ctx.showStatus(
				options?.reason === "completed"
					? "Goal mode completed."
					: options?.reason === "dropped"
						? "Goal dropped."
						: options?.paused
							? "Goal mode paused."
							: "Goal mode disabled.",
			);
	}

	#getPausedState(): GoalModeState | undefined {
		const state = this.ctx.session.getGoalModeState();
		return state?.goal && !state.enabled && state.goal.status === "paused" ? state : undefined;
	}

	#updateStatus(): void {
		this.ctx.updateGoalModeStatus(
			this.#enabled || this.#paused ? { enabled: this.#enabled, paused: this.#paused } : undefined,
		);
	}

	#resetTimeoutHold(): void {
		this.#goalTurnToolStarts.clear();
		this.#goalTurnOutcomes = [];
		this.#goalTurnUnpaired = false;
		this.#goalTurnSnapshotKey = undefined;
		this.#goalHeldSnapshotKey = undefined;
		this.#goalTimeoutFingerprint = undefined;
		this.#goalIdenticalTimeoutStreak = 0;
	}

	#resetContinuationSuppression(): void {
		this.#suppressNextContinuation = false;
		this.#resetTimeoutHold();
	}

	async #dispatchSubcommand(sub: GoalSubcommand, rest: string): Promise<void> {
		switch (sub) {
			case "set":
				return await this.#set(rest);
			case "show":
				return this.#showDetails();
			case "pause":
				return await this.#pause();
			case "resume":
				return await this.#resume();
			case "drop":
				return await this.#drop();
		}
	}

	async #openMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.ctx.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = goal.objective.length > 48 ? `${goal.objective.slice(0, 47)}…` : goal.objective;
		const choice = await this.ctx.showHookSelector(
			state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`,
			state === "active" ? ["Show details", "Pause", "Drop"] : ["Resume", "Show details", "Drop"],
		);
		if (choice === "Show details") this.#showDetails();
		else if (choice === "Pause") await this.#pause();
		else if (choice === "Resume") await this.#resume();
		else if (choice === "Drop") await this.#drop();
	}

	#showDetails(): void {
		const state = this.ctx.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) return this.ctx.showStatus("No goal set.");
		this.ctx.showStatus(
			[
				`Objective: ${goal.objective}`,
				`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
				`Tokens used: ${goal.tokensUsed.toLocaleString()}`,
				`Time spent: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
			].join("\n"),
		);
	}

	async #pause(): Promise<void> {
		if (!this.#enabled) return this.ctx.showWarning("No active goal to pause.");
		await this.ctx.session.goalRuntime.pauseGoal();
		await this.exit({ paused: true, reason: "paused" });
	}

	async #resume(): Promise<void> {
		if (!this.#getPausedState()) return this.ctx.showWarning("No paused goal to resume.");
		await this.enter({ resume: true, silent: true });
		this.ctx.showStatus("Goal mode resumed.");
		this.scheduleContinuation();
	}

	async #drop(): Promise<void> {
		if (!this.#enabled && !this.#getPausedState()) return this.ctx.showWarning("No goal to drop.");
		if (
			!(await this.ctx.showHookConfirm(
				"Drop goal?",
				"This removes the goal record. Accumulated usage stays in the session log.",
			))
		)
			return;
		await this.ctx.session.goalRuntime.dropGoal();
		await this.exit({ reason: "dropped" });
	}

	async #startFromObjective(objective: string): Promise<void> {
		await this.enter({ objective, silent: true });
		this.#resetContinuationSuppression();
		this.ctx.inputCallback?.(this.ctx.startPendingSubmission({ text: objective }));
	}

	async #replaceFromObjective(objective: string): Promise<void> {
		const state = await this.ctx.session.goalRuntime.replaceGoal({ objective });
		this.ctx.session.setGoalModeState(state);
		this.#enabled = true;
		this.#paused = false;
		this.#resetContinuationSuppression();
		this.#updateStatus();
		if (this.ctx.session.isStreaming) await this.ctx.session.sendGoalModeContext({ deliverAs: "steer" });
		this.ctx.inputCallback?.(this.ctx.startPendingSubmission({ text: objective }));
	}

	async #set(rest: string): Promise<void> {
		if (!this.#enabled && this.#getPausedState())
			return this.ctx.showWarning("Resume the current goal first, or drop it before setting a new objective.");
		const objective = rest.trim() || (await this.ctx.showHookEditor("Goal objective", { promptStyle: true }))?.trim();
		if (!objective) return;
		if (this.#enabled) await this.#replaceFromObjective(objective);
		else await this.#startFromObjective(objective);
	}
}
