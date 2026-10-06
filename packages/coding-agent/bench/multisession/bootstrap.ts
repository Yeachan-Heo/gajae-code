import * as crypto from "node:crypto";
import { canonicalJson } from "./contract";
import { COHORT_MARKER_ENV } from "./cohort";

/** Explicit bench setup. Keep this value identical for both isolation arms. */
export const RunnerBootstrap = {
	version: 1,
	agentDir: "isolated-temporary-directory-per-session",
	environment: {
		allowlist: ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", COHORT_MARKER_ENV],
		stripNames: [
			"GJC_MASTER_CAPABILITY",
			"GJC_MASTER_OWNER_SESSION_ID",
			"GJC_BROKER_RESTART_REQUEST",
			"GJC_LIFECYCLE_REQUEST_ID",
			"GJC_SDK_LIFECYCLE_REQUEST",
			"GJC_STATE_ROOT",
		],
		stripPrefixes: [
			"GJC_SESSION_",
			"GJC_COORDINATOR_SESSION_",
			"GJC_COORDINATOR_SIDECAR_",
			"GJC_TMUX_OWNER_",
			"GJC_MANAGED_OWNER_",
		],
	},
	settings: {
		sdkHostModeSupported: false,
		notificationHostModeSupported: false,
		enableLsp: false,
		enableMCP: false,
		enableMcpAutoload: false,
		disableExtensionDiscovery: true,
		compaction: {
			enabled: true,
			strategy: "context-full",
			// Above the session host's full product prompt + tool schema estimate (so no
			// pre-prompt auto-compaction fires before the first turn there), and below
			// the workload's compaction-sized turn, so compaction fires exactly there.
			thresholdTokens: 16_384,
			remoteEnabled: false,
		},
	},
	tools: ["bash", "read", "search", "task"],
	logicalTools: { grep: "search" },
	capabilities: ["bash", "read", "grep", "task", "compaction"],
	excludedServices: [
		"sdk-root-host-endpoint-and-websocket-control",
		"notification-host-endpoint-and-provider-daemons",
		"broker-lifecycle-readiness-capability-and-endpoint-ownership",
		"mcp-manager-discovery-connection-and-tool-registration",
		"lsp-runtime-server-discovery-and-warmup",
		"extension-hook-command-skill-rule-and-context-file-discovery",
		"deferred-hindsight-memory-backend-startup",
		"session-host-process-postmortem-exit-authority",
	],
} as const;

export type RunnerBootstrap = typeof RunnerBootstrap;


/** SHA-256 digest of the key-sorted bootstrap manifest. */
export function bootstrapDigest(): string {
	return crypto.createHash("sha256").update(canonicalJson(RunnerBootstrap)).digest("hex");
}
