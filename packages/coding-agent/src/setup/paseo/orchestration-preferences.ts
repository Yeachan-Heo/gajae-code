import { ORCHESTRATION_ROLE_KEYS, PROVIDER_KEY } from "./setup-deps";

/** Every newly seeded orchestration role points at the base provider this setup registers. */
export const SEEDED_ROLE_VALUE = PROVIDER_KEY;

/** Paseo nests its role assignments under `providers`; the file's other top-level keys are not ours. */
const PROVIDERS_KEY = "providers";

export interface OrchestrationSeed {
	readonly mutate: (draft: Record<string, unknown>) => void;
	readonly seededKeys: readonly string[];
	readonly seededValues: Record<string, string>;
}

function readRoles(preferences: Record<string, unknown>): Record<string, unknown> | undefined {
	const providers = preferences[PROVIDERS_KEY];
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	return providers as Record<string, unknown>;
}

/**
 * A role is empty only when it is absent, `""`, or `[]`.
 *
 * Every other value, including `null`, belongs to the user and is left alone --
 * seeding must never overwrite an assignment somebody already made.
 */
function isEmpty(roles: Record<string, unknown> | undefined, key: string): boolean {
	if (!roles || !(key in roles)) return true;
	const value = roles[key];
	return value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * Plan the seeding of `providers.{impl,ui,research,planning,audit}`.
 *
 * Only empty roles are seeded. `preferences[]` and any other top-level key are
 * never read or assigned, so an existing array keeps its identity and content.
 */
/** Read a role's current value, or `undefined` when unset. Shared by seeding and removal. */
export function readRoleValue(preferences: Record<string, unknown>, key: string): string | undefined {
	const roles = readRoles(preferences);
	const value = roles?.[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Delete seeded roles from the nested `providers` map.
 *
 * `shouldDelete` gates each key on provenance, so a role the user reassigned
 * after install is left alone. The `providers` object itself is removed only
 * when it becomes empty, so a file GJC fully seeded returns to its prior shape.
 */
export function removeSeededRoles(
	draft: Record<string, unknown>,
	keys: readonly string[],
	shouldDelete: (key: string, currentValue: string | undefined) => boolean,
): void {
	const roles = readRoles(draft);
	if (!roles) return;
	for (const key of keys) {
		const value = roles[key];
		if (shouldDelete(key, typeof value === "string" ? value : undefined)) delete roles[key];
	}
	if (Object.keys(roles).length === 0) delete draft[PROVIDERS_KEY];
}

export function createOrchestrationSeed(preferences: Record<string, unknown>): OrchestrationSeed {
	const roles = readRoles(preferences);
	const seededKeys = ORCHESTRATION_ROLE_KEYS.filter(key => isEmpty(roles, key));
	const seededValues = Object.fromEntries(seededKeys.map(key => [key, SEEDED_ROLE_VALUE]));

	return {
		mutate: draft => {
			if (seededKeys.length === 0) return;
			const existing = draft[PROVIDERS_KEY];
			const target =
				existing && typeof existing === "object" && !Array.isArray(existing)
					? (existing as Record<string, unknown>)
					: {};
			for (const key of seededKeys) target[key] = SEEDED_ROLE_VALUE;
			draft[PROVIDERS_KEY] = target;
		},
		seededKeys,
		seededValues,
	};
}
