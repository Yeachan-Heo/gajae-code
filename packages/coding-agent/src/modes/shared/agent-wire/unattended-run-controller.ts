/**
 * Unattended run controller (#318).
 *
 * The single required owner of negotiated unattended state. Entering unattended
 * mode is fail-closed: a controller can only be created via {@link
 * UnattendedRunController.negotiate}, which rejects a missing/partial budget, an
 * invalid declaration, or a provider that cannot account for tokens/cost.
 *
 * The controller owns budget accounting across metrics and phases. Scope/action
 * authorization (#319) and the durable audit trail (#320) layer onto the same
 * controller; this slice wires the budget floor and abort coordination.
 *
 * Attended mode never constructs a controller, so by construction the attended
 * path is unaffected by everything here.
 */
import type {
	RpcActionDenied,
	RpcBudgetExceeded,
	RpcBudgetMetric,
	RpcScopeDenied,
	RpcUnattendedActionClass,
	RpcUnattendedBudget,
	RpcUnattendedDeclaration,
	RpcUnattendedRefusalCode,
} from "../../rpc/rpc-types";
import type { BridgeCommandScope } from "./scopes";
import { actionClassForScope, classifyBashAction } from "./unattended-action-policy";

/** Coordinated abort surfaces invoked exactly once on a budget breach / abort. */
export interface UnattendedAbortHooks {
	abortModelStream?(): void | Promise<void>;
	abortBash?(): void | Promise<void>;
	cancelHostTools?(reason: string): void | Promise<void>;
	cancelHostUris?(reason: string): void | Promise<void>;
	stopWorkflow?(reason: string): void | Promise<void>;
}

export type UnattendedAuditEvent =
	| { event: "unattended_negotiated"; run_id: string; actor: string }
	| { event: "budget_exceeded"; payload: RpcBudgetExceeded }
	| { event: "unattended_aborted"; run_id: string; reason: string }
	| { event: "unattended_abort_settled"; run_id: string; status: "aborted" | "abort_failed"; failures: number }
	| { event: "scope_denied"; payload: RpcScopeDenied }
	| { event: "action_denied"; payload: RpcActionDenied };

export interface NegotiateContext {
	runId: string;
	sessionId?: string;
	audit?(event: UnattendedAuditEvent): void;
	abortHooks?: UnattendedAbortHooks;
	/**
	 * Whether the active provider can report token usage and cost. Unattended
	 * mode rejects providers without this accounting up front (fail-closed).
	 */
	providerSupportsTokenCostMetrics?: boolean;
	/** Injectable clock for deterministic tests. Defaults to Date.now. */
	now?(): number;
}

export class UnattendedNegotiationError extends Error {
	constructor(
		readonly code: RpcUnattendedRefusalCode,
		message: string,
	) {
		super(message);
		this.name = "UnattendedNegotiationError";
	}
}

export class UnattendedBudgetExceededError extends Error {
	constructor(readonly payload: RpcBudgetExceeded) {
		super(`budget_exceeded: ${payload.metric} ${payload.observed}/${payload.limit} at ${payload.phase}`);
		this.name = "UnattendedBudgetExceededError";
	}
}

/** Thrown when a provider/tool reports a non-finite usage value (fail-closed). */
export class UnattendedAccountingError extends Error {
	constructor(
		readonly metric: RpcBudgetMetric,
		readonly phase: string,
		value: unknown,
	) {
		super(`non-finite ${metric} usage (${String(value)}) at ${phase}`);
		this.name = "UnattendedAccountingError";
	}
}

/** Thrown when a command's coarse scope is outside the declared allowlist (#319). */
export class ScopeDeniedError extends Error {
	constructor(readonly payload: RpcScopeDenied) {
		super(`scope_denied: ${payload.scope}${payload.command ? ` (${payload.command})` : ""}`);
		this.name = "ScopeDeniedError";
	}
}

/** Thrown when an action class is outside the declared allowlist (default-deny, #319). */
export class ActionDeniedError extends Error {
	constructor(readonly payload: RpcActionDenied) {
		super(`action_denied: ${payload.action}${payload.command ? ` (${payload.command})` : ""}`);
		this.name = "ActionDeniedError";
	}
}

interface Usage {
	tokens: number;
	toolCalls: number;
	costUsd: number;
}

function isPositiveFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function validateBudget(budget: unknown): RpcUnattendedBudget {
	if (typeof budget !== "object" || budget === null) {
		throw new UnattendedNegotiationError("incomplete_budget", "budget declaration is required for unattended mode");
	}
	const b = budget as Record<string, unknown>;
	const fields: Array<keyof RpcUnattendedBudget> = [
		"max_tokens",
		"max_tool_calls",
		"max_wall_time_ms",
		"max_cost_usd",
	];
	for (const f of fields) {
		if (!isPositiveFiniteNumber(b[f])) {
			throw new UnattendedNegotiationError("incomplete_budget", `budget.${f} must be a positive finite number`);
		}
	}
	return {
		max_tokens: b.max_tokens as number,
		max_tool_calls: b.max_tool_calls as number,
		max_wall_time_ms: b.max_wall_time_ms as number,
		max_cost_usd: b.max_cost_usd as number,
	};
}

export class UnattendedRunController {
	readonly runId: string;
	readonly sessionId?: string;
	readonly actor: string;
	readonly budget: RpcUnattendedBudget;
	readonly scopes: ReadonlySet<string>;
	readonly actionAllowlist: ReadonlySet<string>;

	private readonly usage: Usage = { tokens: 0, toolCalls: 0, costUsd: 0 };
	private readonly startedAt: number;
	private readonly now: () => number;
	private readonly audit?: (event: UnattendedAuditEvent) => void;
	private readonly abortHooks: UnattendedAbortHooks;
	private aborted = false;
	private abortPromise?: Promise<void>;

	private constructor(declaration: RpcUnattendedDeclaration, ctx: NegotiateContext, budget: RpcUnattendedBudget) {
		this.runId = ctx.runId;
		this.sessionId = ctx.sessionId;
		this.actor = declaration.actor;
		this.budget = budget;
		this.scopes = new Set(declaration.scopes);
		this.actionAllowlist = new Set(declaration.action_allowlist);
		this.now = ctx.now ?? Date.now;
		this.audit = ctx.audit;
		this.abortHooks = ctx.abortHooks ?? {};
		this.startedAt = this.now();
	}

	/** Fail-closed entry: validate the declaration + budget, or throw. */
	static negotiate(declaration: unknown, ctx: NegotiateContext): UnattendedRunController {
		if (typeof declaration !== "object" || declaration === null) {
			throw new UnattendedNegotiationError("invalid_unattended_declaration", "declaration is required");
		}
		const d = declaration as Record<string, unknown>;
		if (typeof d.actor !== "string" || d.actor.trim() === "") {
			throw new UnattendedNegotiationError("invalid_unattended_declaration", "declaration.actor is required");
		}
		if (!Array.isArray(d.scopes) || !d.scopes.every(s => typeof s === "string")) {
			throw new UnattendedNegotiationError("invalid_unattended_declaration", "declaration.scopes must be string[]");
		}
		if (!Array.isArray(d.action_allowlist) || !d.action_allowlist.every(s => typeof s === "string")) {
			throw new UnattendedNegotiationError(
				"invalid_unattended_declaration",
				"declaration.action_allowlist must be string[]",
			);
		}
		const budget = validateBudget(d.budget);
		// Reject providers that cannot account for tokens/cost (fail-closed): require
		// an explicit positive capability signal — omitted/unknown is refused too.
		if (ctx.providerSupportsTokenCostMetrics !== true) {
			throw new UnattendedNegotiationError(
				"unsupported_budget_metric",
				"unattended mode requires an explicit provider token/cost accounting capability",
			);
		}
		const controller = new UnattendedRunController(d as unknown as RpcUnattendedDeclaration, ctx, budget);
		ctx.audit?.({ event: "unattended_negotiated", run_id: ctx.runId, actor: controller.actor });
		return controller;
	}

	get isAborted(): boolean {
		return this.aborted;
	}

	usageSnapshot(): Readonly<Usage> & { wallTimeMs: number } {
		return { ...this.usage, wallTimeMs: this.now() - this.startedAt };
	}

	remainingWallTimeMs(): number {
		return Math.max(0, this.budget.max_wall_time_ms - (this.now() - this.startedAt));
	}

	/**
	 * Authorize a command's coarse scope against the declared allowlist. Throws
	 * ScopeDeniedError (pre-side-effect) when the scope was not declared.
	 */
	authorizeScope(scope: BridgeCommandScope, command?: string): void {
		if (this.scopes.has(scope)) return;
		const payload: RpcScopeDenied = {
			code: "scope_denied",
			scope,
			command,
			run_id: this.runId,
			session_id: this.sessionId,
			pre_side_effect: true,
		};
		this.audit?.({ event: "scope_denied", payload });
		throw new ScopeDeniedError(payload);
	}

	/**
	 * Authorize an action class against the declared allowlist. Default-deny: any
	 * class not explicitly declared is rejected with ActionDeniedError before the
	 * side effect runs.
	 */
	authorizeAction(action: RpcUnattendedActionClass, command?: string): void {
		if (this.actionAllowlist.has(action)) return;
		const payload: RpcActionDenied = {
			code: "action_denied",
			action,
			command,
			run_id: this.runId,
			session_id: this.sessionId,
			pre_side_effect: true,
		};
		this.audit?.({ event: "action_denied", payload });
		throw new ActionDeniedError(payload);
	}

	/**
	 * Classify a bash command and authorize the resulting action class BEFORE the
	 * command is executed. Returns the classified action class on success.
	 */
	authorizeBash(command: string): RpcUnattendedActionClass {
		this.authorizeScope("bash", command);
		const action = classifyBashAction(command);
		this.authorizeAction(action, command);
		return action;
	}

	/** Convenience: map a coarse scope to its `command.<scope>` action class. */
	static actionClassForScope = actionClassForScope;

	/** Pre-turn estimate: refuse to start a turn that would obviously breach. */
	preTurnEstimate(estimate: { tokens?: number; costUsd?: number }): void {
		this.checkWallTime("pre-turn estimate");
		if (estimate.tokens !== undefined) {
			if (!Number.isFinite(estimate.tokens)) {
				void this.fireAbort("accounting:tokens");
				throw new UnattendedAccountingError("tokens", "pre-turn estimate", estimate.tokens);
			}
			if (this.usage.tokens + estimate.tokens > this.budget.max_tokens) {
				this.breach("tokens", this.budget.max_tokens, this.usage.tokens + estimate.tokens, "pre-turn estimate");
			}
		}
		if (estimate.costUsd !== undefined) {
			if (!Number.isFinite(estimate.costUsd)) {
				void this.fireAbort("accounting:cost");
				throw new UnattendedAccountingError("cost", "pre-turn estimate", estimate.costUsd);
			}
			if (this.usage.costUsd + estimate.costUsd > this.budget.max_cost_usd) {
				this.breach("cost", this.budget.max_cost_usd, this.usage.costUsd + estimate.costUsd, "pre-turn estimate");
			}
		}
	}

	/** Reserve one tool-call unit BEFORE any side effect; breach if it would exceed. */
	preflightToolCall(phase = "tool-call preflight"): void {
		this.checkWallTime(phase);
		if (this.usage.toolCalls + 1 > this.budget.max_tool_calls) {
			this.breach("tool_calls", this.budget.max_tool_calls, this.usage.toolCalls + 1, phase);
		}
		this.usage.toolCalls += 1;
	}

	/** Post-turn reconciliation of actual token usage. Fails closed on non-finite. */
	recordTokens(tokens: number, phase = "post-turn reconciliation"): void {
		if (!Number.isFinite(tokens)) {
			void this.fireAbort(`accounting:tokens`);
			throw new UnattendedAccountingError("tokens", phase, tokens);
		}
		this.usage.tokens += Math.max(0, tokens);
		if (this.usage.tokens > this.budget.max_tokens) {
			this.breach("tokens", this.budget.max_tokens, this.usage.tokens, phase);
		}
	}

	recordCost(costUsd: number, phase = "post-turn reconciliation"): void {
		if (!Number.isFinite(costUsd)) {
			void this.fireAbort(`accounting:cost`);
			throw new UnattendedAccountingError("cost", phase, costUsd);
		}
		this.usage.costUsd += Math.max(0, costUsd);
		if (this.usage.costUsd > this.budget.max_cost_usd) {
			this.breach("cost", this.budget.max_cost_usd, this.usage.costUsd, phase);
		}
	}

	/** Combined post-turn reconciliation. */
	reconcile(actual: { tokens?: number; costUsd?: number }, phase = "post-turn reconciliation"): void {
		if (actual.tokens !== undefined) this.recordTokens(actual.tokens, phase);
		if (actual.costUsd !== undefined) this.recordCost(actual.costUsd, phase);
	}

	/** Wall-time check; call before/inside long operations. */
	checkWallTime(phase = "wall-time"): void {
		const elapsed = this.now() - this.startedAt;
		if (elapsed > this.budget.max_wall_time_ms) {
			this.breach("wall_time", this.budget.max_wall_time_ms, elapsed, phase);
		}
	}

	private breach(metric: RpcBudgetMetric, limit: number, observed: number, phase: string): never {
		// Initiate the (idempotent, awaitable) abort. breach() throws synchronously,
		// so the payload reports `aborting`; the settled status (aborted/abort_failed)
		// is emitted as an unattended_abort_settled audit event once hooks complete.
		void this.fireAbort(`budget_exceeded:${metric}`);
		const abortStatus: RpcBudgetExceeded["abort_status"] = "aborting";
		const payload: RpcBudgetExceeded = {
			code: "budget_exceeded",
			metric,
			limit,
			observed,
			phase,
			run_id: this.runId,
			session_id: this.sessionId,
			abort_status: abortStatus,
		};
		this.audit?.({ event: "budget_exceeded", payload });
		throw new UnattendedBudgetExceededError(payload);
	}

	/**
	 * Idempotent abort: runs every abort hook at most once. Safe to call from the
	 * synchronous breach path (which does not await) and from callers that do; both
	 * share a single abort promise so hook completion can be awaited deterministically.
	 */
	async abort(reason: string): Promise<void> {
		await this.fireAbort(reason);
	}

	/** Returns the in-flight/settled abort completion once aborting has begun. */
	get abortCompletion(): Promise<void> | undefined {
		return this.abortPromise;
	}

	private fireAbort(reason: string): Promise<void> {
		if (this.abortPromise) return this.abortPromise;
		this.aborted = true;
		this.abortPromise = this.runAbortHooks().then(failures => {
			this.audit?.({ event: "unattended_aborted", run_id: this.runId, reason });
			this.audit?.({
				event: "unattended_abort_settled",
				run_id: this.runId,
				status: failures === 0 ? "aborted" : "abort_failed",
				failures,
			});
		});
		return this.abortPromise;
	}

	/**
	 * Invoke every configured abort hook exactly once with per-hook isolation, so a
	 * failing hook never prevents the other cancellation surfaces from running.
	 * Returns the number of hooks that rejected.
	 */
	private async runAbortHooks(): Promise<number> {
		const calls: Array<Promise<unknown>> = [];
		const run = (fn: (() => void | Promise<void>) | undefined) => {
			if (!fn) return;
			// Invoke synchronously so the hook's synchronous prefix runs immediately,
			// but capture sync throws and async rejections so allSettled isolates them.
			try {
				calls.push(Promise.resolve(fn()));
			} catch (err) {
				calls.push(Promise.reject(err));
			}
		};
		run(this.abortHooks.abortModelStream);
		run(this.abortHooks.abortBash);
		run(() => this.abortHooks.cancelHostTools?.("unattended abort"));
		run(() => this.abortHooks.cancelHostUris?.("unattended abort"));
		run(() => this.abortHooks.stopWorkflow?.("unattended abort"));
		const results = await Promise.allSettled(calls);
		return results.filter(r => r.status === "rejected").length;
	}
}
