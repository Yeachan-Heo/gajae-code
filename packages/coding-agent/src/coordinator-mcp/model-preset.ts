import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { UnknownModelProfileError, validateModelProfileName } from "../config/model-profile-contract";
import { mergeModelProfiles } from "../config/model-profiles";
import { ModelsConfigSchema } from "../config/models-config-schema";

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

function coordinatorModelProfiles(
	profiles?: Parameters<typeof mergeModelProfiles>[0],
): Map<string, CoordinatorModelProfile> {
	return new Map([...mergeModelProfiles(profiles).keys()].map(name => [name, { name }]));
}

export const loadCoordinatorModelProfiles: CoordinatorModelProfileLoader = async () => {
	const modelsFile = Bun.file(path.join(getAgentDir(), "models.yml"));
	if (!(await modelsFile.exists())) return coordinatorModelProfiles();
	try {
		const parsed = YAML.parse(await modelsFile.text());
		const config = ModelsConfigSchema.safeParse(parsed);
		if (!config.success) throw config.error;
		return coordinatorModelProfiles(config.data.profiles);
	} catch (error) {
		throw new CoordinatorModelProfileRegistryError(error);
	}
};

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
	const requested = typeof raw === "string" ? raw : "";
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
	try {
		const canonical = validateModelProfileName(requested, profiles);
		return { ok: true, mpreset: canonical };
	} catch (error) {
		if (error instanceof UnknownModelProfileError)
			return {
				ok: false,
				reason: "unknown_model_profile",
				mpreset: error.details.requestedProfile.slice(0, MAX_ECHOED_MPRESET_LENGTH),
				available_profiles: error.details.availableProfiles,
			};
		throw error;
	}
}
