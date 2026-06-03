import { describe, expect, it } from "bun:test";
import { classifyRecovery } from "../../src/harness-control-plane/classifier";
import { DEFAULT_RETRY_BUDGET, type Observation, type RetryBudget } from "../../src/harness-control-plane/types";

function obs(p: Partial<Observation>): Observation {
	return {
		lifecycle: "observing",
		ownerLive: false,
		cwd: ".",
		branch: null,
		gitDelta: "unknown",
		lastActivityAt: null,
		observedSignals: [],
		risk: "normal",
		...p,
	};
}

function budget(p: Partial<RetryBudget> = {}): RetryBudget {
	return { ...DEFAULT_RETRY_BUDGET, ...p };
}

describe("classifyRecovery", () => {
	it("dirty vanished worktree -> restart-preserve-delta, never restart-clean, requires vanish, critical", () => {
		const d = classifyRecovery({ observation: obs({ ownerLive: false, gitDelta: "dirty" }), retryBudget: budget() });
		expect(d.classification).toBe("restart-preserve-delta");
		expect(d.classification).not.toBe("restart-clean");
		expect(d.requiredReceiptFamily).toBe("vanish");
		expect(d.severity).toBe("critical");
		expect(d.ownerRequired).toBe(true);
	});

	it("dirty preserve budget exhausted -> fallback-codex-exec (still requires vanish, never clean-delete)", () => {
		const d = classifyRecovery({
			observation: obs({ ownerLive: false, gitDelta: "dirty" }),
			retryBudget: budget({ dirtyVanishPreserve: 0 }),
		});
		expect(d.classification).toBe("fallback-codex-exec");
		expect(d.requiredReceiptFamily).toBe("vanish");
		expect(d.classification).not.toBe("restart-clean");
	});

	it("zero-delta vanished -> restart-clean with budget; exhausted -> fallback-codex-exec", () => {
		const ok = classifyRecovery({
			observation: obs({ ownerLive: false, gitDelta: "zero-delta" }),
			retryBudget: budget(),
		});
		expect(ok.classification).toBe("restart-clean");
		expect(ok.requiredReceiptFamily).toBe("vanish");
		const exhausted = classifyRecovery({
			observation: obs({ ownerLive: false, gitDelta: "zero-delta" }),
			retryBudget: budget({ zeroDeltaVanish: 0 }),
		});
		expect(exhausted.classification).toBe("fallback-codex-exec");
	});

	it("clean vanished -> restart-clean (requires vanish)", () => {
		const d = classifyRecovery({ observation: obs({ ownerLive: false, gitDelta: "clean" }), retryBudget: budget() });
		expect(d.classification).toBe("restart-clean");
		expect(d.requiredReceiptFamily).toBe("vanish");
	});

	it("unknown delta vanished -> human-check (never destructive)", () => {
		const d = classifyRecovery({
			observation: obs({ ownerLive: false, gitDelta: "unknown" }),
			retryBudget: budget(),
		});
		expect(d.classification).toBe("human-check");
		expect(["restart-clean", "restart-preserve-delta", "fallback-codex-exec"]).not.toContain(d.classification);
	});

	it("deleted worktree -> human-check, never recreate over unknown data", () => {
		const d = classifyRecovery({
			observation: obs({ ownerLive: false, gitDelta: "dirty", risk: "deleted-worktree" }),
			retryBudget: budget(),
		});
		expect(d.classification).toBe("human-check");
	});

	it("owner live + normal -> continue (info)", () => {
		const d = classifyRecovery({ observation: obs({ ownerLive: true, risk: "normal" }), retryBudget: budget() });
		expect(d.classification).toBe("continue");
		expect(d.severity).toBe("info");
	});

	it("owner live + prompt-not-accepted -> reinject-prompt (budget) then human-check (exhausted)", () => {
		const re = classifyRecovery({
			observation: obs({ ownerLive: true, risk: "prompt-not-accepted" }),
			retryBudget: budget(),
		});
		expect(re.classification).toBe("reinject-prompt");
		expect(re.requiredReceiptFamily).toBe("prompt-acceptance");
		const exhausted = classifyRecovery({
			observation: obs({ ownerLive: true, risk: "prompt-not-accepted" }),
			retryBudget: budget({ reinjectPrompt: 0 }),
		});
		expect(exhausted.classification).toBe("human-check");
	});

	it("owner live + validation-failed -> continue (budget) then human-check (exhausted)", () => {
		const repair = classifyRecovery({
			observation: obs({ ownerLive: true, observedSignals: ["validation-failed"] }),
			retryBudget: budget(),
		});
		expect(repair.classification).toBe("continue");
		const exhausted = classifyRecovery({
			observation: obs({ ownerLive: true, observedSignals: ["validation-failed"] }),
			retryBudget: budget({ validationRepair: 0 }),
		});
		expect(exhausted.classification).toBe("human-check");
	});

	it("never emits send-enter across the supported branch matrix", () => {
		const deltas = ["clean", "dirty", "zero-delta", "unknown"] as const;
		const risks = ["normal", "prompt-not-accepted", "deleted-worktree", "vanished-dirty"] as const;
		for (const ownerLive of [true, false]) {
			for (const gitDelta of deltas) {
				for (const risk of risks) {
					const d = classifyRecovery({ observation: obs({ ownerLive, gitDelta, risk }), retryBudget: budget() });
					expect(d.classification).not.toBe("send-enter");
				}
			}
		}
	});
});
