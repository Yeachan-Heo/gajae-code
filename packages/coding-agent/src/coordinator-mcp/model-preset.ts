import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { ModelsConfigSchema } from "../config/models-config-schema";

/**
 * The coordinator runs in the shipped MCP process and must stay outside the
 * session host import graph. Keep this identity catalog in the coordinator
 * boundary; profile activation and model registry code belong to that host.
 */
const BUILTIN_MODEL_PROFILE_NAMES = [
	"codex-eco",
	"codex-medium",
	"codex-pro",
	"opencodego",
	"claude-opus",
	"claude-fable",
	"glm-eco",
	"glm-medium",
	"glm-pro",
	"kimi-coding-plan-eco",
	"kimi-coding-plan-medium",
	"kimi-coding-plan-pro",
	"mimo-eco",
	"mimo-medium",
	"mimo-pro",
	"grok-eco",
	"grok-medium",
	"grok-pro",
	"grok-build-pro",
	"cursor-eco",
	"cursor-medium",
	"cursor-pro",
	"minimax-eco",
	"minimax-medium",
	"minimax-pro",
	"opus-codex",
	"codex-opencodego",
	"fable-opus-codex",
] as const;

export interface CoordinatorModelProfile {
	name: string;
}

/**
 * Loads the merged built-in + custom model-profile names from `models.yml`
 * without loading the session-host model registry. The child still owns
 * profile activation; this validates the selection before session creation.
 */
export type CoordinatorModelProfileLoader = () =>
	| Map<string, CoordinatorModelProfile>
	| Promise<Map<string, CoordinatorModelProfile>>;

const MAX_ECHOED_MPRESET_LENGTH = 128;
const LEGACY_MODEL_PROFILE_ALIASES: ReadonlyMap<string, string> = new Map([["codex-standard", "codex-medium"]]);

/**
 * Thrown by the default loader when `models.yml` exists but is invalid or
 * unreadable. This lets the resolver fail closed with a distinct, stable reason
 * instead of silently collapsing a broken registry to the built-ins-only set
 * (which would misreport a caller's valid custom profile as unknown).
 */
export class CoordinatorModelProfileRegistryError extends Error {
	constructor(cause?: unknown) {
		super("coordinator_model_profile_registry_error");
		this.name = "CoordinatorModelProfileRegistryError";
		if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
	}
}

function builtInCoordinatorModelProfiles(): Map<string, CoordinatorModelProfile> {
	return new Map(BUILTIN_MODEL_PROFILE_NAMES.map(name => [name, { name }]));
}

export const loadCoordinatorModelProfiles: CoordinatorModelProfileLoader = async () => {
	const modelsFile = Bun.file(path.join(getAgentDir(), "models.yml"));
	if (!(await modelsFile.exists())) return builtInCoordinatorModelProfiles();
	try {
		const parsed = YAML.parse(await modelsFile.text());
		const config = ModelsConfigSchema.safeParse(parsed);
		if (!config.success) throw config.error;
		const profiles = builtInCoordinatorModelProfiles();
		for (const name of Object.keys(config.data.profiles ?? {})) profiles.set(name, { name });
		return profiles;
	} catch (error) {
		throw new CoordinatorModelProfileRegistryError(error);
	}
};

function sortedProfileNames(profiles: ReadonlyMap<string, CoordinatorModelProfile>): string[] {
	return [...profiles.keys()].sort((left, right) => left.localeCompare(right));
}

function resolveCoordinatorModelProfileName(profileName: string, profiles: ReadonlyMap<string, unknown>): string {
	if (profiles.has(profileName)) return profileName;
	const replacement = LEGACY_MODEL_PROFILE_ALIASES.get(profileName);
	return replacement && profiles.has(replacement) ? replacement : profileName;
}

export type CoordinatorMpresetResolution =
	| { ok: true; mpreset: string | null }
	| { ok: false; reason: "unknown_model_profile"; mpreset: string; available_profiles: string[] }
	| { ok: false; reason: "model_profile_registry_error"; mpreset: string; available_profiles: string[] };

/**
 * Resolve a coordinator `mpreset` argument against the merged profile registry.
 *
 * Only an absent (`undefined`/`null`) value is a no-op (`mpreset: null`); an
 * explicit empty/whitespace string is a caller error and is rejected rather
 * than silently launching at the default tier. Legacy aliases are canonicalized
 * exactly like the CLI (e.g. `codex-standard` -> `codex-medium`) so coordinator
 * selection stays in parity with `gjc --mpreset <profile>`; the resolved value
 * is the canonical profile name. Unknown names are rejected with the
 * available-profile listing and never reach a spawned child command, and a
 * broken registry fails closed with `model_profile_registry_error`.
 */
export async function resolveCoordinatorMpreset(
	raw: unknown,
	loadProfiles: CoordinatorModelProfileLoader,
): Promise<CoordinatorMpresetResolution> {
	if (raw === undefined || raw === null) return { ok: true, mpreset: null };
	const requested = typeof raw === "string" ? raw.trim() : "";
	const echoed = requested.slice(0, MAX_ECHOED_MPRESET_LENGTH);
	let profiles: Map<string, CoordinatorModelProfile>;
	try {
		profiles = await loadProfiles();
	} catch (error) {
		if (error instanceof CoordinatorModelProfileRegistryError) {
			return { ok: false, reason: "model_profile_registry_error", mpreset: echoed, available_profiles: [] };
		}
		throw error;
	}
	// Non-string input and explicit blank/whitespace strings can never name a
	// profile; only absent/null (handled above) means "no selection".
	if (typeof raw !== "string" || requested.length === 0) {
		return {
			ok: false,
			reason: "unknown_model_profile",
			mpreset: echoed,
			available_profiles: sortedProfileNames(profiles),
		};
	}
	const canonical = resolveCoordinatorModelProfileName(requested, profiles);
	if (!profiles.has(canonical)) {
		return {
			ok: false,
			reason: "unknown_model_profile",
			mpreset: echoed,
			available_profiles: sortedProfileNames(profiles),
		};
	}
	return { ok: true, mpreset: canonical };
}
