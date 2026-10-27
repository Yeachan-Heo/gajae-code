import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { startupProjectEnvSnapshot } from "@gajae-code/utils/env";
import { canonicalEnvKey } from "@gajae-code/utils/env-file";

export type AcpPermissionMode = "auto" | "prompt" | "always-allow";

const ACP_PERMISSION_MODE_ENV = "GJC_ACP_PERMISSION_MODE";

function parseAcpPermissionMode(value: unknown): AcpPermissionMode {
	if (value === "auto" || value === "prompt" || value === "always-allow") return value;
	return "prompt";
}

/**
 * The default process environment includes the cwd `.env` merge. A live value
 * equal to that startup declaration is the overlay and fails safe. A different
 * live value is the launching environment, including when the declaration is
 * dynamic (`$` or backticks) and is not that value. An explicit env map is
 * the caller's value. The raw string is parsed so padding still fails safe.
 */
function permissionModeFromEnv(env: NodeJS.ProcessEnv): unknown {
	const raw = env[ACP_PERMISSION_MODE_ENV];
	if (env !== process.env || typeof raw !== "string") return raw;
	const declared = startupProjectEnvSnapshot().values[canonicalEnvKey(ACP_PERMISSION_MODE_ENV)];
	if (declared !== undefined && raw.trim() === declared.trim()) return undefined;
	return raw;
}

/** Client metadata is authoritative; the process environment is only a fallback when that field is absent. */
export function resolveAcpPermissionMode(
	clientCapabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AcpPermissionMode {
	const meta = clientCapabilities?._meta;
	if (typeof meta === "object" && meta !== null) {
		const gjc = (meta as { gjc?: unknown }).gjc;
		if (typeof gjc === "object" && gjc !== null && "permissionHandling" in gjc) {
			return parseAcpPermissionMode((gjc as { permissionHandling?: unknown }).permissionHandling);
		}
	}
	return parseAcpPermissionMode(permissionModeFromEnv(env));
}
