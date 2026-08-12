export interface SkillDiscoverySettings {
	enabled?: boolean;
	enableSkillCommands?: boolean;
	enableCodexUser?: boolean;
	enableClaudeUser?: boolean;
	enableClaudeProject?: boolean;
	/**
	 * User-facing trust controls for filesystem-discovered skills. Discovery is
	 * on by default: a valid skill placed in a documented project or user
	 * location is loaded without extra configuration ceremony. Setting either of
	 * these to `false` disables that scope while leaving the other scope (and
	 * the `skills.enabled` master switch) intact.
	 *
	 * `enablePiUser` / `enablePiProject` are deprecated legacy aliases for the
	 * same effective setting: an explicitly configured legacy value is honored
	 * only when the corresponding trust flag is not configured.
	 */
	trustProjectSkills?: boolean;
	trustUserSkills?: boolean;
	/** @deprecated Legacy alias for `trustUserSkills`. */
	enablePiUser?: boolean;
	/** @deprecated Legacy alias for `trustProjectSkills`. */
	enablePiProject?: boolean;
	customDirectories?: string[];
	ignoredSkills?: string[];
	includeSkills?: string[];
}

/** Default trust for a skill scope when neither the trust flag nor its legacy alias is configured. */
export const DEFAULT_SKILL_SCOPE_TRUST = true;

/**
 * Resolve whether a skill scope is trusted, honoring the user-facing trust flag
 * first and the deprecated `enablePiUser` / `enablePiProject` aliases second.
 *
 * Because both settings are optional (`undefined` when unconfigured), an
 * explicitly configured legacy value keeps working, and a fresh install with no
 * configuration resolves to the zero-config default (`true`).
 */
export function resolveSkillScopeTrust(
	settings: Pick<
		SkillDiscoverySettings,
		"trustProjectSkills" | "trustUserSkills" | "enablePiUser" | "enablePiProject"
	>,
	scope: "project" | "user",
): boolean {
	const trust = scope === "project" ? settings.trustProjectSkills : settings.trustUserSkills;
	if (trust !== undefined) return trust;
	const legacy = scope === "project" ? settings.enablePiProject : settings.enablePiUser;
	if (legacy !== undefined) return legacy;
	return DEFAULT_SKILL_SCOPE_TRUST;
}

export const DEFAULT_SKILL_DISCOVERY_SETTINGS: SkillDiscoverySettings = {
	enabled: true,
	enableSkillCommands: true,
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	customDirectories: [],
	ignoredSkills: [],
	includeSkills: [],
};

export const DEFAULT_DISABLED_EXTENSIONS: string[] = [];
