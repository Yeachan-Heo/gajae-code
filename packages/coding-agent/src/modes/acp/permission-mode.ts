import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export type AcpPermissionMode = "auto" | "prompt" | "always-allow";

const ACP_PERMISSION_MODE_ENV = "GJC_ACP_PERMISSION_MODE";

function parseAcpPermissionMode(value: unknown): AcpPermissionMode {
	if (value === "auto" || value === "prompt" || value === "always-allow") return value;
	return "prompt";
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
	return parseAcpPermissionMode(env[ACP_PERMISSION_MODE_ENV]);
}
