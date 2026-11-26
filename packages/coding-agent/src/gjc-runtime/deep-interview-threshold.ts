import { isSettingsInitialized, Settings } from "../config/settings";
import { resolveWorkflowSetting } from "./workflow-settings";

/** Base deep-interview ambiguity threshold when no flag or configured value chose one. */
export const DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD = 0.05;

/**
 * Resolve the configured ambiguity threshold through the shared five-layer
 * resolver: project `.gjc/config.yml` > project `.gjc/settings.json` > user
 * `getAgentDir()/config.yml` > legacy config-root `settings.json` > default.
 * Project configuration beats user configuration, and invalid optional files
 * continue to lower layers (tolerant contract). Returns `undefined` when the
 * resolver falls back to the default so the resolution flags (`--quick`/
 * `--standard`/`--deep`) still apply.
 */
export async function resolveConfiguredAmbiguityThreshold(
	cwd: string,
	agentDir?: string,
): Promise<{ threshold: number; source: string } | undefined> {
	const resolution = await resolveWorkflowSetting(cwd, "gjc.deepInterview.ambiguityThreshold", {
		defaultValue: DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD,
		parse: value => {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
				return {
					kind: "invalid",
					reason: "expected gjc.deepInterview.ambiguityThreshold to be a number in (0, 1]",
				};
			}
			return { kind: "valid", value };
		},
		// The session's effective agent profile: an SDK session created with
		// `createAgentSession({ agentDir })` resolves against that directory
		// instead of the process-global default.
		agentDir: agentDir ?? (isSettingsInitialized() ? Settings.instance.getAgentDir() : undefined),
	});
	if (resolution.source === "default") return undefined;
	return { threshold: resolution.value, source: resolution.source };
}
