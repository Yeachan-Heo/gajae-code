import type { AbortScope } from "../../sdk/host/control/operations";

const ACP_ABORT_SCOPE_ENV = "GJC_ACP_ABORT_SCOPE";

function parseAcpAbortScope(value: unknown): AbortScope {
	if (value === "turn" || value === "owned") return value;
	return "turn";
}

/**
 * Resolves the C04 terminal-abort scope for an ACP `session/cancel`. Client
 * metadata is authoritative; the process environment is only a fallback when
 * that field is absent. Both default to `"turn"` so an external client that
 * ends a turn only stops that turn, matching the SDK `turn.abort` default and
 * other ACP clients' cancel behavior; a client that also wants exact owned
 * subagents and background tasks stopped opts in per request with
 * `_meta.gjc.abortScope: "owned"` (or process-wide with
 * `GJC_ACP_ABORT_SCOPE=owned`). Paseo keeps owned cancels through its provider
 * config `env: { "GJC_ACP_ABORT_SCOPE": "owned" }` without source changes.
 */
export function resolveAcpAbortScope(meta: unknown, env: NodeJS.ProcessEnv = process.env): AbortScope {
	if (typeof meta === "object" && meta !== null) {
		const gjc = (meta as { gjc?: unknown }).gjc;
		if (typeof gjc === "object" && gjc !== null && "abortScope" in gjc) {
			return parseAcpAbortScope((gjc as { abortScope?: unknown }).abortScope);
		}
	}
	return parseAcpAbortScope(env[ACP_ABORT_SCOPE_ENV]);
}
