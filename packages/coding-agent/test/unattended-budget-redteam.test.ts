import { describe, expect, it } from "bun:test";
import type { RpcUnattendedBudget, RpcUnattendedDeclaration } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	type NegotiateContext,
	type UnattendedAbortHooks,
	type UnattendedAuditEvent,
	UnattendedBudgetExceededError,
	UnattendedNegotiationError,
	UnattendedRunController,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";

function budget(overrides: Partial<RpcUnattendedBudget> = {}): RpcUnattendedBudget {
	return { max_tokens: 100, max_tool_calls: 2, max_wall_time_ms: 1_000, max_cost_usd: 1, ...overrides };
}

function decl(overrides: Partial<RpcUnattendedDeclaration> = {}): RpcUnattendedDeclaration {
	return {
		actor: "redteam",
		budget: budget(),
		scopes: ["prompt", "control"],
		action_allowlist: ["bash.readonly"],
		...overrides,
	};
}

function ctx(
	extra: Partial<NegotiateContext> = {},
): NegotiateContext & { events: UnattendedAuditEvent[]; audit: (event: UnattendedAuditEvent) => void } {
	const events: UnattendedAuditEvent[] = [];
	return {
		runId: "run-red",
		sessionId: "sess-red",
		audit: event => events.push(event),
		events,
		providerSupportsTokenCostMetrics: true,
		...extra,
	};
}

function negotiate(
	overrides: Partial<RpcUnattendedDeclaration> = {},
	extra: Partial<NegotiateContext> = {},
): ReturnType<typeof UnattendedRunController.negotiate> {
	return UnattendedRunController.negotiate(decl(overrides), ctx(extra));
}

function expectNegotiationCode(thunk: () => unknown, code: UnattendedNegotiationError["code"]): void {
	try {
		thunk();
		throw new Error("expected negotiation refusal");
	} catch (error) {
		expect(error).toBeInstanceOf(UnattendedNegotiationError);
		expect((error as UnattendedNegotiationError).code).toBe(code);
	}
}

function expectBudgetExceeded(thunk: () => unknown): UnattendedBudgetExceededError {
	try {
		thunk();
		throw new Error("expected budget breach");
	} catch (error) {
		expect(error).toBeInstanceOf(UnattendedBudgetExceededError);
		return error as UnattendedBudgetExceededError;
	}
}

describe("UnattendedRunController adversarial negotiation", () => {
	it("refuses every budget field missing in turn as incomplete_budget", () => {
		const fields = ["max_tokens", "max_tool_calls", "max_wall_time_ms", "max_cost_usd"] as const;
		for (const field of fields) {
			const partial = { ...budget() } as Record<string, number>;
			delete partial[field];
			expectNegotiationCode(
				() => UnattendedRunController.negotiate(decl({ budget: partial as unknown as RpcUnattendedBudget }), ctx()),
				"incomplete_budget",
			);
		}
	});

	it("refuses NaN, Infinity, zero, and negative budget values", () => {
		const fields = ["max_tokens", "max_tool_calls", "max_wall_time_ms", "max_cost_usd"] as const;
		for (const field of fields) {
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
				expectNegotiationCode(
					() => UnattendedRunController.negotiate(decl({ budget: budget({ [field]: value }) }), ctx()),
					"incomplete_budget",
				);
			}
		}
	});

	it("refuses unsupported token/cost providers without constructing a controller or firing hooks", () => {
		let aborts = 0;
		const c = ctx({
			providerSupportsTokenCostMetrics: false,
			abortHooks: {
				abortModelStream: () => {
					aborts += 1;
				},
			},
		});
		expectNegotiationCode(() => UnattendedRunController.negotiate(decl(), c), "unsupported_budget_metric");
		expect(aborts).toBe(0);
		expect(c.events).toEqual([]);
	});
});

describe("UnattendedRunController adversarial budget enforcement", () => {
	it("preflight reserves before side effects and rejects before incrementing usage past cap", () => {
		const controller = negotiate({ budget: budget({ max_tool_calls: 1 }) });
		let sideEffects = 0;
		controller.preflightToolCall("tool-call preflight");
		sideEffects += 1;
		expect(controller.usageSnapshot().toolCalls).toBe(1);

		const breach = expectBudgetExceeded(() => {
			controller.preflightToolCall("tool-call preflight");
			sideEffects += 1;
		});
		expect(breach.payload.metric).toBe("tool_calls");
		expect(breach.payload.limit).toBe(1);
		expect(breach.payload.observed).toBe(2);
		expect(breach.payload.phase).toBe("tool-call preflight");
		expect(sideEffects).toBe(1);
		expect(controller.usageSnapshot().toolCalls).toBe(1);
	});

	it("treats wall-time boundary as allowed and just-over boundary as breach with injected clock", () => {
		let now = 10_000;
		const controller = negotiate({ budget: budget({ max_wall_time_ms: 500 }) }, { now: () => now });
		now = 10_500;
		expect(() => controller.checkWallTime("boundary check")).not.toThrow();
		now = 10_501;
		const breach = expectBudgetExceeded(() => controller.checkWallTime("just over boundary"));
		expect(breach.payload.metric).toBe("wall_time");
		expect(breach.payload.limit).toBe(500);
		expect(breach.payload.observed).toBe(501);
		expect(breach.payload.phase).toBe("just over boundary");
	});

	it("breaches token, cost, and combined reconciliation through reconcile()", () => {
		const token = expectBudgetExceeded(() =>
			negotiate({ budget: budget({ max_tokens: 10 }) }).reconcile({ tokens: 11 }, "token reconcile"),
		);
		expect(token.payload.metric).toBe("tokens");
		expect(token.payload.limit).toBe(10);
		expect(token.payload.observed).toBe(11);
		expect(token.payload.phase).toBe("token reconcile");

		const cost = expectBudgetExceeded(() =>
			negotiate({ budget: budget({ max_cost_usd: 0.25 }) }).reconcile({ costUsd: 0.26 }, "cost reconcile"),
		);
		expect(cost.payload.metric).toBe("cost");
		expect(cost.payload.limit).toBe(0.25);
		expect(cost.payload.observed).toBe(0.26);
		expect(cost.payload.phase).toBe("cost reconcile");

		const combined = expectBudgetExceeded(() =>
			negotiate({ budget: budget({ max_tokens: 10, max_cost_usd: 0.25 }) }).reconcile(
				{ tokens: 11, costUsd: 0.26 },
				"combined reconcile",
			),
		);
		expect(combined.payload.metric).toBe("tokens");
		expect(combined.payload.limit).toBe(10);
		expect(combined.payload.observed).toBe(11);
		expect(combined.payload.phase).toBe("combined reconcile");
	});

	it("emits budget_exceeded payload with required run and session fields", () => {
		const events: UnattendedAuditEvent[] = [];
		const controller = UnattendedRunController.negotiate(decl({ budget: budget({ max_tokens: 5 }) }), {
			runId: "run-payload",
			sessionId: "sess-payload",
			audit: event => events.push(event),
			providerSupportsTokenCostMetrics: true,
		});
		const breach = expectBudgetExceeded(() => controller.preTurnEstimate({ tokens: 6 }));
		expect(breach.payload).toEqual({
			code: "budget_exceeded",
			metric: "tokens",
			limit: 5,
			observed: 6,
			phase: "pre-turn estimate",
			run_id: "run-payload",
			session_id: "sess-payload",
			abort_status: "aborting",
		});
		expect(events).toContainEqual({ event: "budget_exceeded", payload: breach.payload });
	});

	it("fires each abort hook exactly once across breach, explicit abort, and a second breach attempt", async () => {
		const counts = { model: 0, bash: 0, tools: 0, uris: 0, workflow: 0 };
		const hooks: UnattendedAbortHooks = {
			abortModelStream: () => {
				counts.model += 1;
			},
			abortBash: () => {
				counts.bash += 1;
			},
			cancelHostTools: () => {
				counts.tools += 1;
			},
			cancelHostUris: () => {
				counts.uris += 1;
			},
			stopWorkflow: () => {
				counts.workflow += 1;
			},
		};
		const controller = negotiate({ budget: budget({ max_tokens: 5, max_tool_calls: 1 }) }, { abortHooks: hooks });
		expectBudgetExceeded(() => controller.preTurnEstimate({ tokens: 6 }));
		await controller.abort("manual abort");
		expectBudgetExceeded(() => controller.recordTokens(6, "second breach attempt"));
		await controller.abortCompletion;
		expect(counts).toEqual({ model: 1, bash: 1, tools: 1, uris: 1, workflow: 1 });
	});

	it("abortCompletion resolves only after async hooks complete", async () => {
		const order: string[] = [];
		let release!: () => void;
		const controller = negotiate(
			{ budget: budget({ max_tokens: 1 }) },
			{
				abortHooks: {
					abortModelStream: async () => {
						order.push("hook-start");
						await new Promise<void>(done => {
							release = done;
						});
						order.push("hook-end");
					},
				},
			},
		);
		order.push("before-breach");
		expectBudgetExceeded(() => controller.recordTokens(2));
		order.push("after-breach");
		const completion = controller.abortCompletion?.then(() => order.push("abort-complete"));
		await Promise.resolve();
		expect(order).toEqual(["before-breach", "hook-start", "after-breach"]);
		release();
		await Promise.resolve();
		await completion;
		expect(order).toEqual(["before-breach", "hook-start", "after-breach", "hook-end", "abort-complete"]);
	});

	it("usageSnapshot reflects accumulated usage and wallTimeMs from injected clock", () => {
		let now = 1_000;
		const controller = negotiate(
			{ budget: budget({ max_tokens: 100, max_tool_calls: 5, max_cost_usd: 5 }) },
			{ now: () => now },
		);
		controller.preflightToolCall();
		controller.recordTokens(15);
		controller.recordCost(0.75);
		now = 1_345;
		expect(controller.usageSnapshot()).toEqual({ tokens: 15, toolCalls: 1, costUsd: 0.75, wallTimeMs: 345 });
	});
});
