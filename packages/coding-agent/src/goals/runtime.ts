import { prompt, Snowflake } from "@gajae-code/utils";
import goalContinuationPrompt from "../prompts/goals/goal-continuation.md" with { type: "text" };
import goalModeActivePrompt from "../prompts/goals/goal-mode-active.md" with { type: "text" };
import {
	type Goal,
	type GoalModeState,
	type GoalRuntimeEvent,
	type GoalTokenUsage,
	normalizeGoalModeState,
} from "./state";

export interface GoalRuntimeHost {
	getState(): GoalModeState | undefined;
	setState(state: GoalModeState | undefined): void;
	getCurrentUsage(): GoalTokenUsage;
	emit(event: GoalRuntimeEvent): void | Promise<void>;
	persist(mode: "goal" | "goal_paused" | "none", state?: GoalModeState): void;
	sendHiddenMessage(message: {
		customType: string;
		content: string;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	}): Promise<void>;
	now?(): number;
}

export interface GoalTurnSnapshot {
	turnId: string;
	baselineUsage: GoalTokenUsage;
	activeGoalId?: string;
}

export interface GoalWallClockSnapshot {
	lastAccountedAt: number;
	activeGoalId?: string;
}

export interface GoalRuntimeSnapshot {
	turnSnapshot?: GoalTurnSnapshot;
	wallClock: GoalWallClockSnapshot;
}

export type GoalPromptKind = "active" | "continuation";

function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

function cloneState(state: GoalModeState): GoalModeState {
	return { ...state, goal: cloneGoal(state.goal) };
}

export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

export function renderTrustedObjective(objective: string): string {
	return `<objective>\n${escapeXmlText(objective)}\n</objective>`;
}

export function validateGoalObjective(objective: string, op: "create" | "replace"): string {
	const trimmed = objective.trim();
	if (!trimmed) throw new Error(`objective is required when op=${op}`);
	if (trimmed === "/goal") {
		throw new Error("objective must describe the goal; `/goal` is the command name, not a goal objective");
	}
	return trimmed;
}

export function goalTokenDelta(current: GoalTokenUsage, baseline: GoalTokenUsage): number {
	// Diverges from OpenAI code backend-rs: OpenAI code backend omits cache creation because its target providers
	// do not bill cache writes distinctly through the token-usage stream. Pi receives
	// cacheWrite separately on Anthropic/Bedrock; rotating a 1h ephemeral cache or
	// re-anchoring a changed system prompt can write 100K+ tokens, which usage accounting must track.
	// cacheRead is excluded because it is reused prefix, not new work consumed by the goal.
	return (
		Math.max(0, current.input - baseline.input) +
		Math.max(0, current.cacheWrite - baseline.cacheWrite) +
		Math.max(0, current.output - baseline.output)
	);
}

export function renderGoalPrompt(kind: GoalPromptKind, goal: Goal): string {
	const template = kind === "active" ? goalModeActivePrompt : goalContinuationPrompt;
	return prompt.render(template, {
		objective: escapeXmlText(goal.objective),
		tokensUsed: String(goal.tokensUsed),
		timeUsedSeconds: String(goal.timeUsedSeconds),
	});
}

function isAccountingStatus(goal: Goal): boolean {
	return goal.status === "active";
}

export class GoalRuntime {
	readonly #host: GoalRuntimeHost;
	#turnSnapshot: GoalTurnSnapshot | undefined;
	#wallClock: GoalWallClockSnapshot;
	#accountingTail: Promise<void> = Promise.resolve();

	constructor(host: GoalRuntimeHost) {
		this.#host = host;
		this.#wallClock = { lastAccountedAt: this.#now() };
	}

	get snapshot(): GoalRuntimeSnapshot {
		return {
			turnSnapshot: this.#turnSnapshot
				? { ...this.#turnSnapshot, baselineUsage: { ...this.#turnSnapshot.baselineUsage } }
				: undefined,
			wallClock: { ...this.#wallClock },
		};
	}

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}

	#hasAccountingState(): boolean {
		const state = normalizeGoalModeState(this.#host.getState());
		return Boolean(state?.enabled && isAccountingStatus(state.goal));
	}

	async #withAccounting<T>(fn: () => Promise<T> | T): Promise<T> {
		const previous = this.#accountingTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#accountingTail = previous.then(
			() => promise,
			() => promise,
		);
		await previous.catch(() => {});
		try {
			return await fn();
		} finally {
			resolve();
		}
	}

	#getStateClone(): GoalModeState | undefined {
		const state = normalizeGoalModeState(this.#host.getState());
		return state ? cloneState(state) : undefined;
	}

	async #commitState(
		state: GoalModeState | undefined,
		options?: { persist?: "goal" | "goal_paused" | "none"; emit?: boolean },
	): Promise<void> {
		this.#host.setState(state ? cloneState(state) : undefined);
		if (options?.persist) {
			this.#host.persist(options.persist, state);
		}
		if (options?.emit !== false) {
			await this.#host.emit({ type: "goal_updated", goal: state ? cloneGoal(state.goal) : null, state });
		}
	}

	#markActiveAccounting(goal: Goal): void {
		if (this.#wallClock.activeGoalId !== goal.id) {
			this.#wallClock = { lastAccountedAt: this.#now(), activeGoalId: goal.id };
		}
		if (this.#turnSnapshot) {
			this.#turnSnapshot.activeGoalId = goal.id;
			this.#turnSnapshot.baselineUsage = { ...this.#host.getCurrentUsage() };
		}
	}

	#clearActiveAccounting(): void {
		this.#wallClock = { lastAccountedAt: this.#now() };
		if (this.#turnSnapshot) {
			this.#turnSnapshot.activeGoalId = undefined;
		}
	}

	onTurnStart(turnId: string, baselineUsage: GoalTokenUsage): void {
		this.#turnSnapshot = { turnId, baselineUsage: { ...baselineUsage } };
		const state = this.#getStateClone();
		if (state?.enabled && isAccountingStatus(state.goal)) {
			this.#turnSnapshot.activeGoalId = state.goal.id;
			if (this.#wallClock.activeGoalId !== state.goal.id) {
				this.#wallClock = { lastAccountedAt: this.#now(), activeGoalId: state.goal.id };
			}
		}
	}

	async onToolCompleted(toolName: string): Promise<void> {
		if (toolName === "goal") return;
		if (!this.#hasAccountingState()) return;
		await this.flushUsage();
	}

	async onGoalToolCompleted(): Promise<void> {
		if (!this.#hasAccountingState()) return;
		await this.flushUsage();
	}

	async onAgentEnd(options?: { turnCompleted?: boolean; currentUsage?: GoalTokenUsage }): Promise<void> {
		if (!this.#hasAccountingState()) {
			this.#turnSnapshot = undefined;
			return;
		}
		await this.flushUsage(options?.currentUsage);
		this.#turnSnapshot = undefined;
	}

	async onTaskAborted(_options?: { reason?: "interrupted" | "internal" }): Promise<void> {
		const state = this.#getStateClone();
		const needsAccounting = state?.enabled && isAccountingStatus(state.goal);
		if (!needsAccounting) {
			this.#turnSnapshot = undefined;
			return;
		}
		await this.#withAccounting(async () => {
			await this.#flushUsageLocked();
			this.#turnSnapshot = undefined;
			const cloned = this.#getStateClone();
			if (!cloned?.enabled || !isAccountingStatus(cloned.goal)) return;
			cloned.goal.updatedAt = this.#now();
			this.#markActiveAccounting(cloned.goal);
			await this.#commitState(cloned, { persist: "goal" });
		});
	}

	async onThreadResumed(): Promise<GoalModeState | undefined> {
		const state = this.#getStateClone();
		if (!state) return undefined;
		if (state.goal.status === "active") {
			state.enabled = true;
		}
		if (state.enabled && isAccountingStatus(state.goal)) {
			this.#markActiveAccounting(state.goal);
		} else {
			this.#clearActiveAccounting();
		}
		await this.#commitState(state, { emit: true });
		return state;
	}

	async #flushUsageLocked(currentUsage: GoalTokenUsage = this.#host.getCurrentUsage()): Promise<void> {
		const state = this.#getStateClone();
		if (!state?.enabled || !isAccountingStatus(state.goal)) return;
		if (this.#turnSnapshot?.activeGoalId !== state.goal.id && this.#wallClock.activeGoalId !== state.goal.id) return;

		const tokenDelta =
			this.#turnSnapshot?.activeGoalId === state.goal.id
				? goalTokenDelta(currentUsage, this.#turnSnapshot.baselineUsage)
				: 0;
		const wallSeconds =
			this.#wallClock.activeGoalId === state.goal.id
				? Math.max(0, Math.floor((this.#now() - this.#wallClock.lastAccountedAt) / 1000))
				: 0;
		if (tokenDelta <= 0 && wallSeconds <= 0) return;

		state.goal.tokensUsed += tokenDelta;
		state.goal.timeUsedSeconds += wallSeconds;
		state.goal.updatedAt = this.#now();

		if (this.#turnSnapshot?.activeGoalId === state.goal.id) {
			this.#turnSnapshot.baselineUsage = { ...currentUsage };
		}
		if (this.#wallClock.activeGoalId === state.goal.id && wallSeconds > 0) {
			this.#wallClock.lastAccountedAt += wallSeconds * 1000;
		}

		await this.#commitState(state, { persist: "goal" });
	}

	async flushUsage(currentUsage: GoalTokenUsage = this.#host.getCurrentUsage()): Promise<void> {
		await this.#withAccounting(() => this.#flushUsageLocked(currentUsage));
	}

	#createGoalState(objective: string): GoalModeState {
		const now = this.#now();
		const goal: Goal = {
			id: String(Snowflake.next()),
			objective,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		return { enabled: true, mode: "active", goal };
	}

	async createGoal(input: { objective: string }): Promise<GoalModeState> {
		const objective = validateGoalObjective(input.objective, "create");
		return await this.#withAccounting(async () => {
			const existing = this.#getStateClone();
			if (existing?.goal && existing.goal.status !== "dropped" && existing.goal.status !== "complete") {
				throw new Error("cannot create a new goal because this session already has a goal");
			}
			const state = this.#createGoalState(objective);
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async replaceGoal(input: { objective: string }): Promise<GoalModeState> {
		const objective = validateGoalObjective(input.objective, "replace");
		return await this.#withAccounting(async () => {
			const existing = this.#getStateClone();
			if (!existing?.enabled || !isAccountingStatus(existing.goal)) {
				throw new Error("cannot replace goal because no goal is active");
			}
			await this.#flushUsageLocked();
			const state = this.#createGoalState(objective);
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async resumeGoal(): Promise<GoalModeState> {
		return await this.#withAccounting(async () => {
			const state = this.#getStateClone();
			if (!state?.goal) throw new Error("No paused goal.");
			if (state.goal.status === "complete") throw new Error("Goal is already complete.");
			state.enabled = true;
			state.mode = "active";
			state.reason = undefined;
			state.goal.status = "active";
			state.goal.updatedAt = this.#now();
			this.#markActiveAccounting(state.goal);
			await this.#commitState(state, { persist: "goal" });
			return state;
		});
	}

	async pauseGoal(): Promise<GoalModeState | undefined> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked();
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			if (state.goal.status !== "active") {
				throw new Error(`cannot pause a goal that is not active (current status: ${state.goal.status})`);
			}
			state.enabled = false;
			state.mode = "active";
			state.reason = undefined;
			state.goal.status = "paused";
			state.goal.updatedAt = this.#now();
			this.#clearActiveAccounting();
			await this.#commitState(state, { persist: "goal_paused" });
			return state;
		});
	}

	async dropGoal(): Promise<Goal | undefined> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked();
			const state = this.#getStateClone();
			if (!state?.goal) return undefined;
			const dropped = { ...state.goal, status: "dropped" as const, updatedAt: this.#now() };
			this.#clearActiveAccounting();
			await this.#host.emit({
				type: "goal_updated",
				goal: dropped,
				state: { ...state, enabled: false, goal: dropped },
			});
			await this.#commitState(undefined, { persist: "none", emit: false });
			return dropped;
		});
	}

	async completeGoalFromTool(): Promise<Goal> {
		return await this.#withAccounting(async () => {
			await this.#flushUsageLocked();
			const state = this.#getStateClone();
			if (!state?.goal) {
				throw new Error("cannot complete goal because no goal is active");
			}
			if (state.goal.status === "complete") {
				throw new Error("goal is already complete");
			}
			if (state.goal.status === "dropped") {
				throw new Error("cannot complete a dropped goal");
			}
			state.enabled = false;
			state.goal.status = "complete";
			state.goal.updatedAt = this.#now();
			state.mode = "exiting";
			state.reason = "completed";
			this.#clearActiveAccounting();
			await this.#commitState(state, { persist: "goal" });
			return state.goal;
		});
	}

	buildActivePrompt(): string | undefined {
		const state = this.#getStateClone();
		return state?.enabled && state.goal.status === "active" ? renderGoalPrompt("active", state.goal) : undefined;
	}

	buildContinuationPrompt(): string | undefined {
		const state = this.#getStateClone();
		return state?.enabled && state.goal.status === "active"
			? renderGoalPrompt("continuation", state.goal)
			: undefined;
	}
}
