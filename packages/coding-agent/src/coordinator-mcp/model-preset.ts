import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { resolveModelProfileName } from "../config/model-profile-activation";
import { type ModelProfileDefinition, mergeModelProfiles } from "../config/model-profiles";
import { ModelsConfigFile } from "../config/model-registry";

/**
 * Loads the merged built-in + custom model-profile registry the way the `gjc`
 * CLI resolves `--mpreset`, so coordinator MCP launches select the same
 * authoritative profile the spawned child will activate. Custom profiles live
 * in the shared models config, which the child inherits, so both sides agree.
 */
export type CoordinatorModelProfileLoader = () =>
	| Map<string, ModelProfileDefinition>
	| Promise<Map<string, ModelProfileDefinition>>;

const MAX_ECHOED_MPRESET_LENGTH = 128;

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

export const loadCoordinatorModelProfiles: CoordinatorModelProfileLoader = () => {
	const configFile = ModelsConfigFile.relocate(path.join(getAgentDir(), "models.yml"));
	configFile.invalidate();
	const loaded = configFile.tryLoad();
	// A present-but-invalid config must fail closed; absence (`value` undefined
	// with a non-error status) is fine and yields the built-in profiles only.
	if (loaded.status === "error") throw new CoordinatorModelProfileRegistryError(loaded.error);
	return mergeModelProfiles(loaded.value?.profiles);
};

function sortedProfileNames(profiles: ReadonlyMap<string, ModelProfileDefinition>): string[] {
	return [...profiles.keys()].sort((left, right) => left.localeCompare(right));
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
	let profiles: Map<string, ModelProfileDefinition>;
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
	const canonical = resolveModelProfileName(requested, profiles);
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
