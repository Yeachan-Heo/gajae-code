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
export type LogDirIsolationEnv = Record<string, string | undefined>;

export type LogDirIsolationDecision =
	/** Replace the ambient value with a fresh isolated log sink. */
	| { action: "isolate"; reason: "absent" | "untrusted" | "shared" | "inherited" }
	/** Isolation cannot be made to stick; the suite must refuse to run. */
	| { action: "fail"; reason: "dynamic" }
	/** An explicit, trusted pin: honor it. */
	| { action: "honor"; logDir: string };

/** Resolve the canonical user log directory without importing the path resolver. */
export function defaultLogDirFor(input: {
	home: string;
	env: LogDirIsolationEnv;
	projectEnv: ProjectEnvSnapshot;
	xdgEligible: boolean;
}): string {
	return resolveCanonicalLogsDir({ ...input, pathExists: fs.existsSync });
}

function normalizePath(target: string): string {
	const resolved = path.normalize(path.resolve(target));
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function resolveThroughExistingAncestor(target: string, realpath: (target: string) => string): string | undefined {
	let current = path.resolve(target);
	const missing: string[] = [];
	for (;;) {
		try {
			const resolved = realpath(current);
			return normalizePath(path.join(resolved, ...missing.reverse()));
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

function pathsWithinOrEqual(left: string, right: string, realpath: (target: string) => string): boolean {
	const normalizedLeft = normalizePath(left);
	const normalizedRight = normalizePath(right);
	const resolvedLeft = resolveThroughExistingAncestor(left, realpath);
	const resolvedRight = resolveThroughExistingAncestor(right, realpath);
	if (resolvedLeft !== undefined && resolvedRight !== undefined) {
		return resolvedLeft === resolvedRight || isPathWithin(resolvedRight, resolvedLeft);
	}
	// If no existing ancestor can be resolved, fail closed only for lexical
	// descendants. Existing ancestors are resolved above so a symlinked parent
	// cannot make a missing child appear outside the shared sink.
	return normalizedLeft === normalizedRight || isPathWithin(normalizedRight, normalizedLeft);
}

/**
 * Decide whether this test process must be isolated into a fresh log sink.
 *
 * Isolation is the default. An ambient `GJC_LOG_DIR` is deferred to only when it
 * is trusted — an operator export or a fixture pin, not something the checkout's
 * dotenv files put there. An unknown or inherited pin that resolves to the
 * canonical shared user sink is never honored; a child that explicitly replaces
 * its parent's marked value may intentionally pin its own sink. Bun overlays
 * dotenv files into `process.env` before any module runs, so without these
 * provenance rules a repository could hand the suite a log directory it ships
 * and isolation would silently not happen.
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
	inheritedLogDir?: boolean;
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
	// A nested test process inherits the parent preload's log-dir pin through its
	// environment. Environment variables do not carry their origin, so the
	// preload propagates a value marker and passes the equality result here. A
	// matching marker means this process did not choose the pin itself; honoring
	// it would let a child keep writing to a parent's (or the operator's) sink.
	if (input.inheritedLogDir === true) return { action: "isolate", reason: "inherited" };
	if (
		input.inheritedLogDir !== false &&
		input.sharedLogDir !== undefined &&
		pathsWithinOrEqual(configured, input.sharedLogDir, input.realpath ?? ((target: string) => fs.realpathSync(target)))
	)
		return { action: "isolate", reason: "shared" };
	if (declared) return { action: "isolate", reason: "untrusted" };
	return { action: "honor", logDir: configured };
}
