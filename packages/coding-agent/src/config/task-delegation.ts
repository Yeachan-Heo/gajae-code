/**
 * Vendor-separated delegation policy.
 *
 * A model profile that pins worker roles (`executor`, `planner`) to a provider
 * other than the main `default` role exists to move heavy implementation onto
 * that other provider's quota. That only pays off when the main agent actually
 * delegates, and the strong delegation directive is gated behind `task.eager`,
 * whose schema default is `false`. Such a layout therefore used to run
 * everything on the main provider with no signal at all.
 *
 * Vendor separation now implies eager delegation unless `task.eager` is
 * configured explicitly, in which case the user's value always wins.
 */

import type { ModelProfileDefinition, ModelProfileRole } from "./model-profiles";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { Settings } from "./settings";

/** Worker roles whose provider separation expresses delegation intent. */
export const VENDOR_SEPARATION_WORKER_ROLES = ["executor", "planner"] as const satisfies readonly ModelProfileRole[];

export type VendorSeparationWorkerRole = (typeof VENDOR_SEPARATION_WORKER_ROLES)[number];

export type RoleSelectorMap = Partial<Record<ModelProfileRole, ModelSelectorValue>>;

/**
 * Provider of a role's primary selector. Bare aliases (`glm-5.2:medium`) resolve
 * their provider at request time and are deliberately not treated as pinned.
 */
function primarySelectorProvider(value: ModelSelectorValue | undefined): string | undefined {
	if (value === undefined) return undefined;
	const [primary] = normalizeModelSelectorValue(value);
	if (primary === undefined) return undefined;
	const separator = primary.indexOf("/");
	return separator > 0 ? primary.slice(0, separator) : undefined;
}

/** Worker roles pinned to a provider other than the `default` role's provider. */
export function findVendorSeparatedWorkerRoles(mapping: RoleSelectorMap): VendorSeparationWorkerRole[] {
	const defaultProvider = primarySelectorProvider(mapping.default);
	if (defaultProvider === undefined) return [];
	return VENDOR_SEPARATION_WORKER_ROLES.filter(role => {
		const provider = primarySelectorProvider(mapping[role]);
		return provider !== undefined && provider !== defaultProvider;
	});
}

export interface EagerTaskDelegationInput {
	settings: Settings;
	/** Active profile, when its bindings are not (yet) installed into settings. */
	profile?: ModelProfileDefinition;
}

/**
 * Effective role selectors: profile mapping as the baseline, installed settings
 * bindings on top, since profile activation writes into those same settings.
 */
export function collectEffectiveRoleSelectors(input: EagerTaskDelegationInput): RoleSelectorMap {
	const mapping: RoleSelectorMap = { ...input.profile?.modelMapping };
	const defaultRole = input.settings.getModelRole("default");
	if (defaultRole !== undefined) mapping.default = defaultRole;
	const agentModelOverrides = input.settings.get("task.agentModelOverrides");
	for (const role of VENDOR_SEPARATION_WORKER_ROLES) {
		const override = agentModelOverrides[role];
		if (override !== undefined) mapping[role] = override;
	}
	return mapping;
}

export interface EagerTaskDelegation {
	eagerTasks: boolean;
	vendorSeparatedRoles: VendorSeparationWorkerRole[];
	/** Vendor-separated workers that an explicit `task.eager false` keeps unused. */
	suppressedByExplicitSetting: boolean;
}

export function resolveEagerTaskDelegation(input: EagerTaskDelegationInput): EagerTaskDelegation {
	const configured = input.settings.get("task.eager");
	const configuredExplicitly = input.settings.has("task.eager");
	const vendorSeparatedRoles = findVendorSeparatedWorkerRoles(collectEffectiveRoleSelectors(input));
	const eagerTasks = configured || (!configuredExplicitly && vendorSeparatedRoles.length > 0);
	return {
		eagerTasks,
		vendorSeparatedRoles,
		suppressedByExplicitSetting: !eagerTasks && vendorSeparatedRoles.length > 0,
	};
}
