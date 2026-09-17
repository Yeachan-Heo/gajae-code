/**
 * Decision logic for test-process log-directory isolation (issue #5618).
 *
 * Kept separate from `scripts/test-preload.ts` so it is unit-testable: importing
 * the preload itself would apply its environment mutations as a side effect.
 */

/** Environment inputs the decision reads. Injectable for tests. */
export interface LogDirIsolationEnv {
	GJC_LOG_DIR?: string | undefined;
}

export type LogDirIsolationDecision =
	/** Replace the ambient value with a fresh isolated log sink. */
	| { action: "isolate"; reason: "absent" | "untrusted" }
	/** Isolation cannot be made to stick; the suite must refuse to run. */
	| { action: "fail"; reason: "dynamic" }
	/** An explicit, trusted pin: honor it. */
	| { action: "honor"; logDir: string };

/** A dotenv value Bun expands at load time, which production refuses to trust. */
const DYNAMIC_VALUE_PATTERN = /[$`]/;

/**
 * Decide whether this test process must be isolated into a fresh log sink.
 *
 * Isolation is the default. An ambient `GJC_LOG_DIR` is deferred to only when it
 * is trusted — an operator export or a fixture pin, not something the checkout's
 * own `.env` put there. Bun loads `cwd/.env` into `process.env` before any
 * module runs, so without this rule a repository could hand the suite a log
 * directory it ships and isolation would silently not happen.
 *
 * The rule here is deliberately stricter than production's: `trustedValue()` in
 * `packages/utils/src/dirs.ts` compares *values* and honors an inherited value
 * that merely differs from the declared one, because an operator override is a
 * legitimate thing to want. A test preload has no such case — it has no reason
 * to ever honor a repo-declared log directory — so the mere *declaration* of the
 * key is disqualifying. That also closes the dynamic-value hole a pure equality
 * check leaves open, at the cost of refusing a pin whose name a checkout happens
 * to declare; the same trade-off `trustedValue` already documents.
 */
export function decideLogDirIsolation(input: {
	env: LogDirIsolationEnv;
	projectEnv: Record<string, string>;
}): LogDirIsolationDecision {
	const declared = input.projectEnv.GJC_LOG_DIR;
	// Checked before the value, not after: a dynamic declaration poisons the key
	// for this whole process regardless of what it currently expands to. Bun
	// substitutes the value at load time, so production's `trustedValue()` cannot
	// tell what it became and rejects the key outright — including the temp sink
	// this preload would go on to set. Isolating would look like it worked while
	// every log write fell back to the operator's real sink, which is the exact
	// regression this guard exists to prevent. Refuse to run instead.
	if (declared !== undefined && DYNAMIC_VALUE_PATTERN.test(declared)) return { action: "fail", reason: "dynamic" };
	const configured = input.env.GJC_LOG_DIR?.trim();
	if (!configured) return { action: "isolate", reason: "absent" };
	if (declared !== undefined) return { action: "isolate", reason: "untrusted" };
	return { action: "honor", logDir: configured };
}
