import { describe, expect, it } from "bun:test";
import type { RpcUnattendedDeclaration } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	type NegotiateContext,
	UnattendedAccountingError,
	type UnattendedAuditEvent,
	UnattendedBudgetExceededError,
	UnattendedNegotiationError,
	UnattendedRunController,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";

function decl(overrides: Partial<RpcUnattendedDeclaration> = {}): RpcUnattendedDeclaration {
	return {
		actor: "hermes",
		budget: { max_tokens: 1000, max_tool_calls: 3, max_wall_time_ms: 10_000, max_cost_usd: 5 },
		scopes: ["prompt", "control"],
		action_allowlist: ["bash.readonly"],
		...overrides,
	};
}

function ctx(
	extra: Partial<NegotiateContext> = {},
): NegotiateContext & { audit: (e: UnattendedAuditEvent) => void; events: UnattendedAuditEvent[] } {
	const events: UnattendedAuditEvent[] = [];
	return {
		runId: "run-1",
		sessionId: "sess-1",
		audit: e => events.push(e),
		events,
		providerSupportsTokenCostMetrics: true,
		...extra,
	};
}

describe("UnattendedRunController.negotiate (fail-closed)", () => {
	it("refuses a missing budget", () => {
		expect(() => UnattendedRunController.negotiate({ actor: "a", scopes: [], action_allowlist: [] }, ctx())).toThrow(
			UnattendedNegotiationError,
		);
	});

	it("refuses a partial or non-positive budget", () => {
		const partial = {
			actor: "a",
			scopes: [],
			action_allowlist: [],
			budget: { max_tokens: 1, max_tool_calls: 1, max_wall_time_ms: 1 },
		};
		const negative = decl({ budget: { max_tokens: -1, max_tool_calls: 1, max_wall_time_ms: 1, max_cost_usd: 1 } });
		for (const d of [partial, negative]) {
			try {
				UnattendedRunController.negotiate(d, ctx());
				throw new Error("expected refusal");
			} catch (e) {
				expect(e).toBeInstanceOf(UnattendedNegotiationError);
				expect((e as UnattendedNegotiationError).code).toBe("incomplete_budget");
			}
		}
	});

	it("refuses an invalid declaration shape", () => {
		expect(() => UnattendedRunController.negotiate(decl({ actor: "" }), ctx())).toThrow(/actor/);
		expect(() => UnattendedRunController.negotiate({ ...decl(), scopes: [1] as unknown as string[] }, ctx())).toThrow(
			UnattendedNegotiationError,
		);
	});

	it("refuses providers without token/cost accounting (fail-closed)", () => {
		try {
			UnattendedRunController.negotiate(decl(), ctx({ providerSupportsTokenCostMetrics: false }));
			throw new Error("expected refusal");
		} catch (e) {
			expect((e as UnattendedNegotiationError).code).toBe("unsupported_budget_metric");
		}
	});

	it("accepts a complete declaration and audits negotiation", () => {
		const c = ctx();
		const controller = UnattendedRunController.negotiate(decl(), c);
		expect(controller.actor).toBe("hermes");
		expect(controller.scopes.has("control")).toBe(true);
		expect(controller.actionAllowlist.has("bash.readonly")).toBe(true);
		expect(c.events.some(e => e.event === "unattended_negotiated")).toBe(true);
	});

	it("does not run abort hooks when negotiation fails", () => {
		let aborts = 0;
		expect(() =>
			UnattendedRunController.negotiate(
				decl({ actor: "" }),
				ctx({
					abortHooks: {
						abortModelStream: () => {
							aborts += 1;
						},
					},
				}),
			),
		).toThrow();
		expect(aborts).toBe(0);
	});
});

describe("UnattendedRunController budget accounting", () => {
	it("preflights tool calls and breaches before exceeding the cap", () => {
		const c = ctx();
		const controller = UnattendedRunController.negotiate(
			decl({ budget: { max_tokens: 1000, max_tool_calls: 2, max_wall_time_ms: 10_000, max_cost_usd: 5 } }),
			c,
		);
		controller.preflightToolCall();
		controller.preflightToolCall();
		try {
			controller.preflightToolCall();
			throw new Error("expected breach");
		} catch (e) {
			expect(e).toBeInstanceOf(UnattendedBudgetExceededError);
			expect((e as UnattendedBudgetExceededError).payload.metric).toBe("tool_calls");
			expect((e as UnattendedBudgetExceededError).payload.abort_status).toBe("aborting");
		}
		expect(c.events.some(e => e.event === "budget_exceeded")).toBe(true);
		expect(controller.isAborted).toBe(true);
	});

	it("breaches on token and cost reconciliation", () => {
		const tokenC = UnattendedRunController.negotiate(decl(), ctx());
		expect(() => tokenC.recordTokens(2000)).toThrow(UnattendedBudgetExceededError);
		const costC = UnattendedRunController.negotiate(decl(), ctx());
		expect(() => costC.recordCost(10)).toThrow(UnattendedBudgetExceededError);
	});

	it("breaches on wall-time using an injected clock", () => {
		let t = 1000;
		const controller = UnattendedRunController.negotiate(
			decl({ budget: { max_tokens: 1000, max_tool_calls: 3, max_wall_time_ms: 500, max_cost_usd: 5 } }),
			ctx({ now: () => t }),
		);
		t = 1400; // within budget
		expect(() => controller.checkWallTime()).not.toThrow();
		t = 1600; // exceeded
		expect(() => controller.checkWallTime()).toThrow(UnattendedBudgetExceededError);
	});

	it("breaches on pre-turn estimate before doing work", () => {
		const controller = UnattendedRunController.negotiate(decl(), ctx());
		expect(() => controller.preTurnEstimate({ tokens: 5000 })).toThrow(UnattendedBudgetExceededError);
	});

	it("fires abort hooks exactly once across breach + explicit abort", async () => {
		const counts = { model: 0, bash: 0, tools: 0, uris: 0, workflow: 0 };
		const controller = UnattendedRunController.negotiate(
			decl({ budget: { max_tokens: 1000, max_tool_calls: 1, max_wall_time_ms: 10_000, max_cost_usd: 5 } }),
			ctx({
				abortHooks: {
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
				},
			}),
		);
		controller.preflightToolCall();
		expect(() => controller.preflightToolCall()).toThrow(UnattendedBudgetExceededError);
		await controller.abort("manual"); // no-op, already aborted
		expect(counts).toEqual({ model: 1, bash: 1, tools: 1, uris: 1, workflow: 1 });
	});

	it("refuses negotiation when provider capability is omitted (fail-closed)", () => {
		try {
			UnattendedRunController.negotiate(decl(), { runId: "r", audit: () => {} });
			throw new Error("expected refusal");
		} catch (e) {
			expect((e as UnattendedNegotiationError).code).toBe("unsupported_budget_metric");
		}
	});

	it("fails closed on non-finite token/cost accounting and aborts", () => {
		const c = UnattendedRunController.negotiate(decl(), ctx());
		expect(() => c.recordTokens(Number.NaN)).toThrow(UnattendedAccountingError);
		expect(c.isAborted).toBe(true);
		const c2 = UnattendedRunController.negotiate(decl(), ctx());
		expect(() => c2.recordCost(Number.POSITIVE_INFINITY)).toThrow(UnattendedAccountingError);
	});

	it("runs all abort hooks even when one rejects, and reports abort_failed", async () => {
		const counts = { model: 0, bash: 0, tools: 0, uris: 0, workflow: 0 };
		const c = ctx({
			abortHooks: {
				abortModelStream: () => {
					counts.model += 1;
					return Promise.reject(new Error("model abort failed"));
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
			},
		});
		const controller = UnattendedRunController.negotiate(decl(), c);
		await controller.abort("test");
		await controller.abortCompletion;
		// Every hook ran exactly once despite the first rejecting.
		expect(counts).toEqual({ model: 1, bash: 1, tools: 1, uris: 1, workflow: 1 });
		const settled = c.events.find(e => e.event === "unattended_abort_settled");
		expect(settled).toBeDefined();
		expect(settled).toMatchObject({ status: "abort_failed", failures: 1 });
	});
});
