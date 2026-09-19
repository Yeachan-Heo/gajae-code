/**
 * Decision logic for test-process log-directory isolation (issue #5618).
 *
 * Kept separate from `scripts/test-preload.ts` so it is unit-testable: importing
 * the preload itself would apply its environment mutations as a side effect.
 *
 * Provenance comes from the canonical {@link ProjectEnvSnapshot} that production
 * resolves from, imported from the leaf `env-file` module (no side effects, and
 * notably NOT from `dirs.ts`, whose load-time resolver construction would freeze
 * state before the preload sets its isolation variables).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCanonicalLogsDir } from "../packages/utils/src/canonical-log-dir";
import type { ProjectEnvSnapshot } from "../packages/utils/src/env-file";
import { canonicalEnvKey } from "../packages/utils/src/env-file";

/** Environment inputs the decision reads. Injectable for tests. */
export interface LogDirIsolationEnv {
	GJC_LOG_DIR?: string | undefined;
	GJC_CONFIG_DIR?: string | undefined;
	PI_CONFIG_DIR?: string | undefined;
	XDG_STATE_HOME?: string | undefined;
}

export type LogDirIsolationDecision =
	/** Replace the ambient value with a fresh isolated log sink. */
	| { action: "isolate"; reason: "absent" | "untrusted" | "shared" }
	/** Isolation cannot be made to stick; the suite must refuse to run. */
	| { action: "fail"; reason: "dynamic" }
	/** An explicit, trusted pin: honor it. */
	| { action: "honor"; logDir: string };

/** Resolve the canonical user log directory without importing the path resolver. */
export function defaultLogDirFor(input: {
	home: string;
	env: LogDirIsolationEnv;
	projectEnv: ProjectEnvSnapshot;
}): string {
	// The preload has already replaced the default agent profile with a fresh
	// custom temp directory, so the canonical log sink stays under the config
	// root rather than following XDG shared state.
	return resolveCanonicalLogsDir({ ...input, xdgEligible: false, pathExists: fs.existsSync });
}

function pathsEquivalent(left: string, right: string, realpath: (target: string) => string): boolean {
	const normalize = (target: string): string => {
		const resolved = path.normalize(path.resolve(target));
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	if (normalize(left) === normalize(right)) return true;
	try {
		return normalize(realpath(left)) === normalize(realpath(right));
	} catch {
		return false;
	}
}

/**
 * Decide whether this test process must be isolated into a fresh log sink.
 *
 * Isolation is the default. An ambient `GJC_LOG_DIR` is deferred to only when it
 * is trusted — an operator export or a fixture pin, not something the checkout's
 * dotenv files put there. The canonical shared user sink is never honored,
 * however: a child test process can inherit an operator export that points back
 * to that sink, and test isolation must win over that pin. Bun overlays those
 * files into `process.env` before any module runs, so without this rule a
 * repository could hand the suite a log directory it ships and isolation would
 * silently not happen.
 *
 * The declaration set is the canonical snapshot production resolves from —
 * `.env`, `.env.$NODE_ENV`, `.env.local` (skipped under `NODE_ENV=test`),
 * `.env.$NODE_ENV.local` — not a local re-read of `cwd/.env`. A narrower reader
 * here is precisely how a `GJC_LOG_DIR` declared in a layered file came to be
 * honored by this preload and then rejected by production, silently routing
 * every test log record to the operator's canonical sink.
 *
 * The rule is deliberately stricter than production's: `trustedValue()` in
 * `packages/utils/src/dirs.ts` compares *values* and honors an inherited value
 * that merely differs from the declared one, because an operator override is a
 * legitimate thing to want. A test preload has no such case — it has no reason
 * to ever honor a repo-declared log directory — so the mere *declaration* of the
 * key is disqualifying, at the cost of refusing a pin whose name a checkout
 * happens to declare; the same trade-off `trustedValue` already documents.
 */
export function decideLogDirIsolation(input: {
	env: LogDirIsolationEnv;
	projectEnv: ProjectEnvSnapshot;
	sharedLogDir?: string;
	realpath?: (target: string) => string;
}): LogDirIsolationDecision {
	const key = canonicalEnvKey("GJC_LOG_DIR");
	const declared = Object.hasOwn(input.projectEnv.values, key);
	// Checked before the value, not after: a dynamic declaration poisons the key
	// for this whole process regardless of what it currently expands to. Bun
	// substitutes the value at load time, so production's `trustedValue()` cannot
	// tell what it became and rejects the key outright — including the temp sink
	// this preload would go on to set. Isolating would look like it worked while
	// every log write fell back to the operator's real sink, which is the exact
	// regression this guard exists to prevent. Refuse to run instead.
	//
	// The verdict is CONSUMED from the snapshot, never recomputed from the
	// surviving value: `dynamic` carries later-layer precedence, so a `.env`
	// declaring `GJC_LOG_DIR=$HOME/x` that `.env.test` then redeclares statically
	// is NOT dynamic in production, and a local `/[$`]/` re-test would disagree
	// with the resolver this decision exists to stay in step with.
	if (input.projectEnv.dynamic.has(key)) return { action: "fail", reason: "dynamic" };
	const configured = input.env.GJC_LOG_DIR?.trim();
	if (!configured) return { action: "isolate", reason: "absent" };
	if (
		input.sharedLogDir !== undefined &&
		pathsEquivalent(configured, input.sharedLogDir, input.realpath ?? ((target: string) => fs.realpathSync(target)))
	)
		return { action: "isolate", reason: "shared" };
	if (declared) return { action: "isolate", reason: "untrusted" };
	return { action: "honor", logDir: configured };
}
