/**
 * Eval backend allowance (`GJC_PY`, legacy `PI_PY` / `PI_JS`, then `eval.py` / `eval.js` settings).
 * Kept out of the tools index so lightweight modules, such as the pre-load tool descriptions, can
 * resolve it without importing the whole registry.
 */
import { $env } from "@gajae-code/utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/**
 * Parse the `GJC_PY` multi-value token into per-backend booleans.
 *
 * Tokens (case-insensitive):
 * - `0` / `bash` → JavaScript only (`{ py: false, js: true }`)
 * - `1` / `py`   → Python only (`{ py: true, js: false }`)
 * - `js`         → JavaScript only (`{ py: false, js: true }`)
 * - `mix` / `both` → both backends (`{ py: true, js: true }`)
 *
 * Returns `null` when `GJC_PY` is unset, empty, or holds an unrecognized
 * token, so the caller can fall back to the legacy `PI_PY` / `PI_JS` flags or
 * per-key settings. This matches the documented contract that invalid values
 * are ignored.
 */
export function parseGjcPy(env: Record<string, string | undefined>): { py: boolean; js: boolean } | null {
	const raw = env.GJC_PY;
	if (raw === undefined) return null;
	const token = raw.trim().toLowerCase();
	if (token === "") return null;
	switch (token) {
		case "0":
		case "bash":
			return { py: false, js: true };
		case "1":
		case "py":
			return { py: true, js: false };
		case "js":
			return { py: false, js: true };
		case "mix":
		case "both":
			return { py: true, js: true };
		default:
			return null;
	}
}

function isTruthyPythonFlag(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on", "y"].includes(value.trim().toLowerCase());
}

/**
 * Parse legacy `PI_PY` / `PI_JS` boolean flags. Each is a boolean flag; unset
 * means "not specified, defer to settings". Returns `null` when neither is set
 * so the caller can fall through to `readEvalBackendsAllowance` per key.
 */
function parseLegacyEvalEnvFlags(env: Record<string, string | undefined>): EvalBackendsAllowance | null {
	const pyEnv = env.PI_PY;
	const jsEnv = env.PI_JS;
	if (pyEnv === undefined && jsEnv === undefined) return null;
	return {
		python: pyEnv === undefined ? true : isTruthyPythonFlag(pyEnv),
		js: jsEnv === undefined ? true : isTruthyPythonFlag(jsEnv),
	};
}

/**
 * Resolve eval-backend allowance from environment only. `GJC_PY` wins when set
 * to a recognized token; otherwise the legacy `PI_PY` / `PI_JS` flags apply.
 * Returns `null` when no env override is set so the caller can defer to settings.
 */
export function resolveEvalBackendsFromEnv(env: Record<string, string | undefined>): EvalBackendsAllowance | null {
	const gjc = parseGjcPy(env);
	if (gjc) return { python: gjc.py, js: gjc.js };
	return parseLegacyEvalEnvFlags(env);
}

/** Read per-backend allowance from settings (defaults true). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance. `GJC_PY` takes precedence
 * over the legacy `PI_PY` / `PI_JS` env flags, which in turn override the
 * per-key settings (defaults true). When no env override is set, settings win.
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	return resolveEvalBackendsFromEnv($env) ?? readEvalBackendsAllowance(session);
}
