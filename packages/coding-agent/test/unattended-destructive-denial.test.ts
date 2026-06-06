import { describe, expect, it } from "bun:test";
import type { RpcUnattendedDeclaration } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	ActionDeniedError,
	type UnattendedAuditEvent,
	UnattendedRunController,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-run-controller";

/**
 * #319 acceptance: a destructive action that is NOT in the declared allowlist must
 * hard-fail BEFORE the side effect runs. This proves session.executeBash is never
 * invoked for a denied command.
 */

class FakeSession {
	executeBashCalls: string[] = [];
	executeBash(command: string): { ok: true } {
		this.executeBashCalls.push(command);
		return { ok: true };
	}
}

/** A minimal unattended bash dispatcher that authorizes BEFORE executing. */
function dispatchBash(controller: UnattendedRunController, session: FakeSession, command: string): { ok: true } {
	controller.authorizeBash(command); // throws before any side effect if denied
	return session.executeBash(command);
}

function makeController(actionAllowlist: string[], events: UnattendedAuditEvent[]) {
	const decl: RpcUnattendedDeclaration = {
		actor: "hermes",
		budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 10_000, max_cost_usd: 5 },
		scopes: ["bash"],
		action_allowlist: actionAllowlist,
	};
	return UnattendedRunController.negotiate(decl, {
		runId: "run-d",
		sessionId: "sess-d",
		audit: e => events.push(e),
		providerSupportsTokenCostMetrics: true,
	});
}

describe("#319 destructive action denial before side effect", () => {
	it("does not call executeBash for a denied force-push", () => {
		const events: UnattendedAuditEvent[] = [];
		const session = new FakeSession();
		const controller = makeController(["bash.readonly", "bash.mutating"], events);

		expect(() => dispatchBash(controller, session, "git push --force origin main")).toThrow(ActionDeniedError);
		expect(session.executeBashCalls).toHaveLength(0);
		const denial = events.find(e => e.event === "action_denied");
		expect(denial).toBeDefined();
		expect(denial).toMatchObject({
			payload: { code: "action_denied", action: "git.force_push", pre_side_effect: true },
		});
	});

	it("does not call executeBash for a denied recursive delete", () => {
		const session = new FakeSession();
		const controller = makeController(["bash.readonly"], []);
		expect(() => dispatchBash(controller, session, "rm -rf /important")).toThrow(ActionDeniedError);
		expect(session.executeBashCalls).toHaveLength(0);
	});

	it("executes a declared, allowed command", () => {
		const session = new FakeSession();
		const controller = makeController(["bash.readonly"], []);
		expect(dispatchBash(controller, session, "ls -la").ok).toBe(true);
		expect(session.executeBashCalls).toEqual(["ls -la"]);
	});

	it("denies bash entirely when the bash scope is not declared", () => {
		const session = new FakeSession();
		const decl: RpcUnattendedDeclaration = {
			actor: "hermes",
			budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 10_000, max_cost_usd: 5 },
			scopes: ["prompt"],
			action_allowlist: ["bash.readonly"],
		};
		const controller = UnattendedRunController.negotiate(decl, {
			runId: "run-d2",
			audit: () => {},
			providerSupportsTokenCostMetrics: true,
		});
		expect(() => dispatchBash(controller, session, "ls")).toThrow();
		expect(session.executeBashCalls).toHaveLength(0);
	});
});
