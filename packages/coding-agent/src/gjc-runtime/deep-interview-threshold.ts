import { isSettingsInitialized, Settings } from "../config/settings";
import { resolveWorkflowSetting } from "./workflow-settings";

/** Base deep-interview ambiguity threshold when no flag or configured value chose one. */
export const DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD = 0.05;

/** Ambiguity thresholds selected by the `--quick` / `--standard` / `--deep` resolution flags. */
export const RESOLUTION_THRESHOLDS = {
	quick: 0.6,
	standard: 0.5,
	deep: 0.35,
} as const;

export type DeepInterviewResolution = keyof typeof RESOLUTION_THRESHOLDS;

export interface ResolvedAmbiguityThreshold {
	threshold: number;
	source: string;
}

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

/**
 * Resolve the threshold for a skill activation (`/skill:deep-interview <args>`
 * or the `$deep-interview` keyword) with the same precedence as the CLI seed:
 * `--threshold` > configured value > `--quick`/`--standard`/`--deep` > default.
 *
 * Activation must not fail on a malformed request, so an invalid `--threshold`
 * value or conflicting resolution flags are ignored here and resolution falls
 * through to the next layer.
 */
export async function resolveSkillActivationAmbiguityThreshold(
	cwd: string,
	options: { args?: string; agentDir?: string } = {},
): Promise<ResolvedAmbiguityThreshold> {
	const tokens = options.args?.trim().split(/\s+/).filter(Boolean) ?? [];
	const explicit = explicitThresholdFlag(tokens);
	if (explicit !== undefined) return { threshold: explicit, source: "flag:--threshold" };
	const configured = await resolveConfiguredAmbiguityThreshold(cwd, options.agentDir);
	if (configured) return configured;
	const resolutions = (Object.keys(RESOLUTION_THRESHOLDS) as DeepInterviewResolution[]).filter(name =>
		tokens.includes(`--${name}`),
	);
	if (resolutions.length === 1) {
		const [resolution] = resolutions;
		return { threshold: RESOLUTION_THRESHOLDS[resolution], source: `flag:--${resolution}` };
	}
	return { threshold: DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD, source: "default" };
}

function explicitThresholdFlag(tokens: readonly string[]): number | undefined {
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const raw =
			token === "--threshold" ? tokens[index + 1] : token.startsWith("--threshold=") ? token.slice(12) : undefined;
		if (raw === undefined) continue;
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) return parsed;
	}
	return undefined;
}
