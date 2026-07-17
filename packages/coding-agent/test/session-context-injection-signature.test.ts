import { describe, expect, it } from "bun:test";
import { buildContextInjectionSignature } from "@gajae-code/coding-agent/session/agent-session";

describe("context injection signatures", () => {
	it("is stable for identical activation identity and rendered content", () => {
		const parts = ["enabled", "goal-1", "counter-free content"];
		const first = buildContextInjectionSignature("goal-mode-context", parts);
		const second = buildContextInjectionSignature("goal-mode-context", parts);

		expect(second).toBe(first);
	});

	it("changes when any single activation, identity, kind, or rendered content part changes", () => {
		const parts = ["enabled", "goal-1", "content"];
		const base = buildContextInjectionSignature("goal-mode-context", parts);

		expect(buildContextInjectionSignature("plan-mode-context", parts)).not.toBe(base);
		expect(buildContextInjectionSignature("goal-mode-context", ["disabled", "goal-1", "content"])).not.toBe(base);
		expect(buildContextInjectionSignature("goal-mode-context", ["enabled", "goal-2", "content"])).not.toBe(base);
		expect(buildContextInjectionSignature("goal-mode-context", ["enabled", "goal-1", "changed"])).not.toBe(base);
		expect(
			buildContextInjectionSignature("plan-mode-context", ["enabled", "PLAN.md", "iterative", "content"]),
		).not.toBe(buildContextInjectionSignature("plan-mode-context", ["enabled", "PLAN.md", "parallel", "content"]));
	});

	it("preserves part boundaries so concatenation-equivalent inputs cannot collide", () => {
		const splitAfterFirst = buildContextInjectionSignature("goal-mode-context", ["a", "bc"]);
		const splitBeforeLast = buildContextInjectionSignature("goal-mode-context", ["ab", "c"]);

		expect(splitBeforeLast).not.toBe(splitAfterFirst);
	});
});
