import { ThinkingLevel } from "@gajae-code/agent-core";
import { type Api, isKnownProvider, type Model } from "@gajae-code/ai/core";
import { logger } from "@gajae-code/utils";
import type { AgentSession, DefaultFallbackRuntimeState } from "../session/agent-session";
import { clampExplicitThinkingLevelForModel, formatClampedModelSelector } from "../thinking";
import { validateModelProfileName } from "./model-profile-contract";
import {
	commitDurableModelProfileOwnershipWithResult,
	type DurableModelProfileOwnership,
	type DurableModelProfileOwnershipCommit,
	ModelProfileApplyCommittedError,
	type ModelProfileOwnershipMarker,
	modelProfileOwnershipMarkersEqual,
	type ProfileOwnershipChangedEvent,
	readDurableModelProfileOwnership,
} from "./model-profile-ownership";
import {
	aggregateModelProfileRequiredProviders,
	deriveModelProfileMappedProviders,
	formatModelProfileDisplayLabel,
	type ModelProfileDefinition,
	PROXY_ROUTABLE_PROVIDER_IDS,
	type ResolvedProfileBinding,
	resolveProfileBindings,
} from "./model-profiles";

export { resolveModelProfileName } from "./model-profile-contract";

import {
	GJC_MODEL_ASSIGNMENT_TARGETS,
	type GjcModelAssignmentTargetId,
	isAuthenticated,
	kNoAuth,
	type ModelRegistry,
	registrySelectorResolvesToModel,
} from "./model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	parseModelString,
	resolveConfiguredModelPatterns,
	resolveModelChainWithAuth,
	resolveModelRoleValue,
	splitSelectorThinkingSuffix,
} from "./model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue } from "./model-selector-value";
import type { Settings, SettingsAtomicPatch } from "./settings";

type ModelProfileActivationSession = Pick<
	AgentSession,
	"model" | "thinkingLevel" | "sessionId" | "getConfiguredModelChain" | "setConfiguredModelChain"
> & {
	credentialSessionId?: string;
	setModelTemporary?: AgentSession["setModelTemporary"];
	setActiveModelProfile?: (name: string | undefined) => void;
	getActiveModelProfile?: () => string | undefined;
	getModelProfileOwnershipMarker?: () => ModelProfileOwnershipMarker | undefined;
	getDurableModelProfileOwnershipSnapshot?: () => DurableModelProfileOwnership;
	commitModelProfileOwnershipMarker?: (marker: ModelProfileOwnershipMarker) => Promise<void>;
	updateDurableModelProfileOwnershipSnapshot?: (ownership: DurableModelProfileOwnership) => void;
	markModelProfileOwnershipFailed?: (error: ModelProfileApplyCommittedError) => void;
	markModelProfileOwnershipReady?: () => void;
	hasModelProfileOwnershipFailure?: () => boolean;
	emitProfileOwnershipChanged?: (event: ProfileOwnershipChangedEvent) => void;
	/** Record which runtime override keys this activation installed (session-scoped). */
	noteProfileInstalledOverrides?: (
		modelRoles: readonly string[],
		agentModelOverrides: readonly string[],
		preProfileModel: Model<Api> | undefined,
	) => void;
	/** Drop the recorded profile-installed override keys (e.g. after materialization). */
	clearProfileInstalledOverrides?: () => void;
	/** Current profile-installed override keys, for deriving the activation base. */
	getProfileInstalledOverrideKeys?: () => { modelRoles: readonly string[]; agentModelOverrides: readonly string[] };
	/** Re-apply vendor-separated delegation (task tool + prompt) after the role layer changed. */
	syncEagerDelegation?: () => Promise<void>;
	getSessionDefaultModelSelector?: () => string | undefined;
	recordResumeDefaultModel?: (selector: string | undefined) => void;
	seedDefaultFallbackResolution?: (activeIndex: number, skips: Array<{ selector: string; reason: string }>) => void;
	getDefaultFallbackRuntimeState?: () => DefaultFallbackRuntimeState;
	restoreDefaultFallbackRuntimeState?: (state: DefaultFallbackRuntimeState) => void;
	restoreModelSelectionForRollback?: AgentSession["restoreModelSelectionForRollback"];
	modelRegistry?: Pick<
		ModelRegistry,
		| "getSessionCanonicalVariant"
		| "restoreSessionCanonicalVariant"
		| "clearCanonicalVariant"
		| "getAvailable"
		| "lookupAliasExists"
		| "resolveModelByLookupAlias"
		| "authStorage"
		| "isCredentiallessProvider"
	> &
		Partial<Pick<ModelRegistry, "getAvailableForProfileActivation">>;
	getConfiguredModelChainState?: (role: string) => ConfiguredModelChainState | undefined;
};

type ConfiguredModelChainState = {
	entries: readonly string[];
	origin: string;
	identity?: string;
	explicitHead: boolean;
};

export interface PrepareModelProfileActivationOptions {
	session: ModelProfileActivationSession;
	modelRegistry: Pick<
		ModelRegistry,
		| "getModelProfile"
		| "getModelProfiles"
		| "getAvailableModelProfileNames"
		| "getApiKeyForProvider"
		| "getAll"
		| "resolveCanonicalModel"
		| "getCanonicalVariants"
		| "getCanonicalId"
	> &
		Partial<
			Pick<
				ModelRegistry,
				| "getAvailable"
				| "getAvailableForProfileActivation"
				| "resolveModelByLookupAlias"
				| "lookupAliasExists"
				| "clearCanonicalVariant"
				| "seedCanonicalVariant"
				| "getSessionCanonicalVariant"
				| "restoreSessionCanonicalVariant"
				| "getConfiguredProviderIds"
				| "isKnownProvider"
				| "assertCurrentModelProfileExists"
			>
		> & {
			getError?: ModelRegistry["getError"];
		};
	settings: Pick<Settings, "get" | "getGlobal" | "getOverride">;
	profileName: string;
}
export interface ApplyModelProfileActivationOptions {
	persistDefault?: boolean;
	thinkingLevelOverride?: ThinkingLevel;
	/** Session marker to commit after apply; startup of a durable baseline uses inherit. */
	ownershipMarker?: ModelProfileOwnershipMarker;
	/** Startup reconciliation installs runtime state without persisting another session marker. */
	commitOwnershipMarker?: boolean;
	/** Reconciliation never replays a transition-success event. */
	emitOwnershipEvent?: boolean;
}
export interface PreparedModelProfileActivation {
	profileName: string;
	session: ModelProfileActivationSession & { setModelTemporary: AgentSession["setModelTemporary"] };
	settings: Pick<
		Settings,
		| "clearOverride"
		| "commitAtomicBatchWithCurrent"
		| "get"
		| "getGlobal"
		| "getOverride"
		| "override"
		| "set"
		| "unset"
		| "flush"
		| "flushOrThrow"
	>;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, ModelSelectorValue>;
	previousModelRoles: Record<string, ModelSelectorValue>;
	previousPersistedModelRoles: Record<string, ModelSelectorValue> | undefined;
	previousPersistedAgentModelOverrides: Record<string, ModelSelectorValue> | undefined;
	previousModelRolesOverride: Record<string, ModelSelectorValue> | undefined;
	previousAgentModelOverridesOverride: Record<string, ModelSelectorValue> | undefined;
	previousDefaultProfileOverride: string | undefined;
	previousPersistedDefaultProfile: string | undefined;
	previousPersistedDefaultThinkingLevel: Exclude<ThinkingLevel, "inherit"> | undefined;
	previousDefaultThinkingLevelOverride: ThinkingLevel | undefined;
	baseAgentModelOverrides: Record<string, ModelSelectorValue>;
	baseModelRoles: Record<string, ModelSelectorValue>;
	previousDefaultChain: readonly string[] | undefined;
	previousDefaultChainState: ConfiguredModelChainState | undefined;
	previousDefaultFallbackRuntimeState: DefaultFallbackRuntimeState | undefined;
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	/** Full configured default fallback chain with resolvable entries clamped. */
	defaultChain: readonly string[];
	/** Index of the authenticated default-chain entry selected for activation. */
	defaultActiveIndex: number | undefined;
	/** Resolution-time skips that occurred before selecting the default entry. */
	defaultResolutionSkips: Array<{ selector: string; reason: string }>;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
	previousActiveModelProfile: string | undefined;
	previousModelProfileOwnershipMarker: ModelProfileOwnershipMarker | undefined;
	previousModelProfileOwnershipFailure: boolean;
	previousDurableModelProfileOwnership: DurableModelProfileOwnership;
	/**
	 * The session resume default ("provider/id") captured BEFORE activation —
	 * the model resume would restore prior to this profile. Snapshotted
	 * separately from `previousModel` (the live runtime model, which may be a
	 * transient switch) so a failed-activation rollback restores the correct
	 * resume default without promoting a transient model to it.
	 */
	previousSessionDefaultModel: string | undefined;
	/**
	 * Exact concrete sticky selector ("provider/id") snapshotted from the
	 * registry BEFORE the session sticky canonical variant is invalidated during
	 * prepare. Captured verbatim — never re-derived from the live model — so a
	 * transient live-model switch cannot corrupt the restored sticky. Rollback
	 * restores this exact selector when present; otherwise the sticky is cleared
	 * so a stale provider cannot silently resurrect.
	 */
	previousCanonicalVariant: string | undefined;
	/** Registry used to resolve and restore the session sticky canonical variant. */
	modelRegistry: PrepareModelProfileActivationOptions["modelRegistry"];
}
export interface MaterializeModelProfileAssignmentOptions {
	session: Pick<
		ModelProfileActivationSession,
		| "model"
		| "thinkingLevel"
		| "sessionId"
		| "credentialSessionId"
		| "getConfiguredModelChain"
		| "getConfiguredModelChainState"
		| "setConfiguredModelChain"
		| "setActiveModelProfile"
		| "getActiveModelProfile"
		| "getModelProfileOwnershipMarker"
		| "getDurableModelProfileOwnershipSnapshot"
		| "commitModelProfileOwnershipMarker"
		| "updateDurableModelProfileOwnershipSnapshot"
		| "markModelProfileOwnershipFailed"
		| "hasModelProfileOwnershipFailure"
		| "emitProfileOwnershipChanged"
		| "syncEagerDelegation"
		| "getDefaultFallbackRuntimeState"
		| "restoreDefaultFallbackRuntimeState"
		| "modelRegistry"
		| "clearProfileInstalledOverrides"
	>;
	settings: Pick<
		Settings,
		| "clearOverride"
		| "commitAtomicBatchWithCurrent"
		| "get"
		| "getGlobal"
		| "getOverride"
		| "override"
		| "set"
		| "unset"
	>;
	role: GjcModelAssignmentTargetId;
	selector: string;
}

export interface MaterializeModelProfileAssignmentsOptions {
	session: Pick<
		ModelProfileActivationSession,
		| "model"
		| "thinkingLevel"
		| "sessionId"
		| "credentialSessionId"
		| "getConfiguredModelChain"
		| "getConfiguredModelChainState"
		| "setConfiguredModelChain"
		| "setActiveModelProfile"
		| "getActiveModelProfile"
		| "getModelProfileOwnershipMarker"
		| "getDurableModelProfileOwnershipSnapshot"
		| "commitModelProfileOwnershipMarker"
		| "updateDurableModelProfileOwnershipSnapshot"
		| "markModelProfileOwnershipFailed"
		| "hasModelProfileOwnershipFailure"
		| "emitProfileOwnershipChanged"
		| "syncEagerDelegation"
		| "getDefaultFallbackRuntimeState"
		| "restoreDefaultFallbackRuntimeState"
		| "modelRegistry"
		| "clearProfileInstalledOverrides"
	>;
	settings: Pick<
		Settings,
		| "clearOverride"
		| "commitAtomicBatchWithCurrent"
		| "get"
		| "getGlobal"
		| "getOverride"
		| "override"
		| "set"
		| "unset"
	>;
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>;
}

function isReadonlyAssignmentMap(
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>,
): assignments is ReadonlyMap<GjcModelAssignmentTargetId, string> {
	return typeof (assignments as { entries?: unknown }).entries === "function";
}

function getMaterializedAssignments(
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>,
): Array<[GjcModelAssignmentTargetId, string]> {
	if (isReadonlyAssignmentMap(assignments)) return [...assignments.entries()];
	const assignmentRecord: Partial<Record<GjcModelAssignmentTargetId, string>> = assignments;
	const result: Array<[GjcModelAssignmentTargetId, string]> = [];
	for (const role of Object.keys(assignmentRecord) as GjcModelAssignmentTargetId[]) {
		const selector = assignmentRecord[role];
		if (selector !== undefined) result.push([role, selector]);
	}
	return result;
}

function materializeConfiguredDefaultChain(
	session: Pick<ModelProfileActivationSession, "model" | "thinkingLevel" | "getConfiguredModelChain">,
): ModelSelectorValue | undefined {
	if (!session.model) return undefined;
	return formatModelSelectorValue(`${session.model.provider}/${session.model.id}`, session.thinkingLevel);
}

function concretizeMaterializedAssignmentValues(
	options: MaterializeModelProfileAssignmentOptions | MaterializeModelProfileAssignmentsOptions,
	assignments: Record<string, ModelSelectorValue>,
): Record<string, ModelSelectorValue> {
	const modelRegistry = options.session.modelRegistry;
	const sessionId = (options.session as { sessionId?: string }).sessionId;
	const credentialSessionId = options.session.credentialSessionId ?? sessionId;
	if (!modelRegistry || !sessionId) return assignments;
	// Materialized assignments are persisted into `modelRoles` and
	// `task.agentModelOverrides` and later consumed by profile execution, so they
	// must resolve against the descriptor-backed profile-activation catalog, not
	// the broadened general one: otherwise a bare assignment can persist a
	// bundled model that fresh live profile evidence excludes.
	const availableModels = modelRegistry.getAvailableForProfileActivation?.() ?? modelRegistry.getAvailable();
	const authenticatedModels = availableModels.filter(model => {
		const isCredentiallessProvider = modelRegistry.isCredentiallessProvider?.bind(modelRegistry);
		const hasUsableAuth = modelRegistry.authStorage?.hasUsableAuth?.bind(modelRegistry.authStorage);
		if (!isCredentiallessProvider || !hasUsableAuth) return true;
		return isCredentiallessProvider(model.provider) || hasUsableAuth(model.provider);
	});
	return Object.fromEntries(
		Object.entries(assignments).map(([role, selectorValue]) => {
			const concrete = normalizeModelSelectorValue(selectorValue)
				.map(selector => {
					if (splitSelectorThinkingSuffix(selector).selector.includes("/")) return selector;
					const resolved = resolveModelRoleValue(selector, authenticatedModels, {
						settings: options.settings as Settings,
						modelRegistry,
						sessionId,
						credentialSessionId,
						aliasIntent: "preset-equivalent",
					});
					if (!resolved.model) return undefined;
					const concreteSelector = `${resolved.model.provider}/${resolved.model.id}`;
					return resolved.explicitThinkingLevel && resolved.thinkingLevel
						? formatModelSelectorValue(concreteSelector, resolved.thinkingLevel)
						: concreteSelector;
				})
				.filter((selector): selector is string => selector !== undefined);
			if (concrete.length === 0) {
				throw new Error(
					`Active model profile assignment ${role} could not be concretized: ${normalizeModelSelectorValue(selectorValue).join(", ")}`,
				);
			}
			return [role, concrete.length === 1 && typeof selectorValue === "string" ? concrete[0] : concrete];
		}),
	);
}

async function commitMaterializedProfileAssignments(
	options: MaterializeModelProfileAssignmentOptions | MaterializeModelProfileAssignmentsOptions,
	profileName: string,
	modelRoles: Record<string, ModelSelectorValue>,
	agentModelOverrides: Record<string, ModelSelectorValue>,
): Promise<boolean> {
	const oldSessionMarker = options.session.getModelProfileOwnershipMarker?.();
	const previousOwnershipFailure = options.session.hasModelProfileOwnershipFailure?.() ?? false;
	const observedDurableOwnership =
		options.session.getDurableModelProfileOwnershipSnapshot?.() ?? readDurableModelProfileOwnership(options.settings);
	const previousModelRolesOverride = options.settings.getOverride("modelRoles");
	const previousAgentModelOverridesOverride = options.settings.getOverride("task.agentModelOverrides");
	const previousDefaultProfileOverride = options.settings.getOverride("modelProfile.default");
	const previousActiveProfile = options.session.getActiveModelProfile?.();
	const previousChain = options.session.getConfiguredModelChainState?.("default");
	const previousFallbackRuntimeState = options.session.getDefaultFallbackRuntimeState?.();
	const previousCanonicalVariant = options.session.modelRegistry?.getSessionCanonicalVariant?.(
		options.session.sessionId,
	);
	const nextModelRoles = concretizeMaterializedAssignmentValues(options, modelRoles);
	const nextAgentModelOverrides = concretizeMaterializedAssignmentValues(options, agentModelOverrides);
	const durableCommit = await commitDurableModelProfileOwnershipWithResult(
		options.settings,
		{ kind: "cleared" },
		[
			{ path: "modelRoles", op: "set", value: nextModelRoles },
			{
				path: "task.agentModelOverrides",
				op: "set",
				value: nextAgentModelOverrides,
			},
		],
		undefined,
		observedDurableOwnership,
	);
	const committed = durableCommit.ownership;
	options.session.updateDurableModelProfileOwnershipSnapshot?.(committed);
	try {
		options.settings.clearOverride("modelProfile.default");
		options.settings.override("modelRoles", nextModelRoles);
		options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
		options.session.setConfiguredModelChain(
			"default",
			normalizeModelSelectorValue(nextModelRoles.default),
			"modelRoles",
			undefined,
			true,
		);
		options.session.setActiveModelProfile?.(undefined);
		await options.session.commitModelProfileOwnershipMarker?.({ kind: "inherit" });
		options.session.clearProfileInstalledOverrides?.();
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		const restore = (action: () => void): void => {
			try {
				action();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		};
		restore(() =>
			options.session.setConfiguredModelChain(
				"default",
				previousChain?.entries ?? [],
				previousChain?.origin ?? "rollback",
				previousChain?.identity,
				previousChain?.explicitHead ?? true,
			),
		);
		if (previousFallbackRuntimeState) {
			restore(() => options.session.restoreDefaultFallbackRuntimeState?.(previousFallbackRuntimeState));
		}
		restore(() =>
			previousModelRolesOverride === undefined
				? options.settings.clearOverride("modelRoles")
				: options.settings.override("modelRoles", previousModelRolesOverride),
		);
		restore(() =>
			previousAgentModelOverridesOverride === undefined
				? options.settings.clearOverride("task.agentModelOverrides")
				: options.settings.override("task.agentModelOverrides", previousAgentModelOverridesOverride),
		);
		restore(() =>
			previousDefaultProfileOverride === undefined
				? options.settings.clearOverride("modelProfile.default")
				: options.settings.override("modelProfile.default", previousDefaultProfileOverride),
		);
		restore(() => options.session.setActiveModelProfile?.(previousActiveProfile));
		if (options.session.modelRegistry) {
			restore(() =>
				previousCanonicalVariant !== undefined &&
				options.session.modelRegistry?.restoreSessionCanonicalVariant?.(
					options.session.sessionId,
					previousCanonicalVariant,
				) !== true
					? options.session.modelRegistry?.clearCanonicalVariant?.(options.session.sessionId)
					: previousCanonicalVariant === undefined
						? options.session.modelRegistry?.clearCanonicalVariant?.(options.session.sessionId)
						: undefined,
			);
		}
		try {
			await options.session.commitModelProfileOwnershipMarker?.(oldSessionMarker ?? { kind: "inherit" });
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		const cause =
			rollbackErrors.length === 0
				? error
				: new AggregateError(
						[error, ...rollbackErrors],
						"Durable profile materialization committed; runtime rollback was incomplete.",
					);
		const committedError = new ModelProfileApplyCommittedError(profileName, committed.version, cause);
		options.session.markModelProfileOwnershipFailed?.(committedError);
		const ownershipStateChanged =
			durableCommit.wrote || !modelProfileOwnershipMarkersEqual(oldSessionMarker, { kind: "inherit" });
		if (ownershipStateChanged) {
			try {
				options.session.emitProfileOwnershipChanged?.({
					type: "profile_ownership_changed",
					transitionId: globalThis.crypto.randomUUID(),
					source: durableCommit.wrote ? "durable" : "recovery",
					oldMarker: oldSessionMarker ?? { kind: "inherit" },
					newMarker: { kind: "inherit" },
					oldSessionId: options.session.sessionId,
					sessionId: options.session.sessionId,
					observedDurableVersion: durableCommit.wrote ? observedDurableOwnership.version : committed.version,
					...(durableCommit.wrote ? { committedDurableVersion: committed.version } : {}),
					outcome: "failed",
				});
			} catch (eventError) {
				logger.warn("Failed to emit profile ownership materialization failure", {
					profile: profileName,
					error: eventError instanceof Error ? eventError.message : String(eventError),
				});
			}
		}
		throw committedError;
	}
	try {
		await options.session.syncEagerDelegation?.();
	} catch (error) {
		logger.warn("Failed to refresh delegation after durable profile materialization", {
			profile: profileName,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const ownershipStateChanged =
		durableCommit.wrote ||
		previousOwnershipFailure ||
		!modelProfileOwnershipMarkersEqual(oldSessionMarker, { kind: "inherit" });
	if (ownershipStateChanged) {
		try {
			options.session.emitProfileOwnershipChanged?.({
				type: "profile_ownership_changed",
				transitionId: globalThis.crypto.randomUUID(),
				source: durableCommit.wrote ? "durable" : "recovery",
				oldMarker: oldSessionMarker ?? { kind: "inherit" },
				newMarker: { kind: "inherit" },
				oldSessionId: options.session.sessionId,
				sessionId: options.session.sessionId,
				observedDurableVersion: durableCommit.wrote ? observedDurableOwnership.version : committed.version,
				...(durableCommit.wrote ? { committedDurableVersion: committed.version } : {}),
				outcome: durableCommit.wrote ? "committed" : "reconciled",
			});
		} catch (error) {
			logger.warn("Failed to emit profile ownership materialization event", {
				profile: profileName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return true;
}

export async function materializeActiveModelProfileAssignment(
	options: MaterializeModelProfileAssignmentOptions,
): Promise<boolean> {
	const activeProfile = options.session.getActiveModelProfile?.();
	if (!activeProfile) return false;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const target = GJC_MODEL_ASSIGNMENT_TARGETS[options.role];

	if (options.role === "default") {
		nextModelRoles.default = options.selector;
	} else if (!nextModelRoles.default) {
		const defaultChain = materializeConfiguredDefaultChain(options.session);
		if (defaultChain) nextModelRoles.default = defaultChain;
	}

	if (target.settingsPath === "modelRoles") {
		nextModelRoles[options.role] = options.selector;
	} else {
		nextAgentModelOverrides[options.role] = options.selector;
	}

	return commitMaterializedProfileAssignments(options, activeProfile, nextModelRoles, nextAgentModelOverrides);
}

export async function materializeActiveModelProfileAssignments(
	options: MaterializeModelProfileAssignmentsOptions,
): Promise<boolean> {
	const activeProfile = options.session.getActiveModelProfile?.();
	if (!activeProfile) return false;

	const materializedAssignments = getMaterializedAssignments(options.assignments);
	if (materializedAssignments.length === 0) return true;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const includesDefault = materializedAssignments.some(([role]) => role === "default");

	if (!includesDefault && !nextModelRoles.default) {
		const defaultChain = materializeConfiguredDefaultChain(options.session);
		if (defaultChain) nextModelRoles.default = defaultChain;
	}

	for (const [role, selector] of materializedAssignments) {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
		if (target.settingsPath === "modelRoles") {
			nextModelRoles[role] = selector;
		} else {
			nextAgentModelOverrides[role] = selector;
		}
	}

	return commitMaterializedProfileAssignments(options, activeProfile, nextModelRoles, nextAgentModelOverrides);
}

export class ModelProfileCredentialError extends Error {
	readonly code: string = "authentication_failed";
	readonly profileLabel: string;
	readonly providers: readonly string[];
	readonly role: string | undefined;

	constructor(profileLabel: string, providers: readonly string[], role?: string) {
		super(formatModelProfileCredentialError(profileLabel, providers));
		this.name = "ModelProfileCredentialError";
		this.profileLabel = profileLabel;
		this.providers = [...providers];
		this.role = role;
	}
}

export function formatModelProfileCredentialError(profileLabel: string, providers: readonly string[]): string {
	return `Model profile "${profileLabel}" requires credentials for: ${providers.join(", ")}. Run /login and configure the missing provider(s), then retry.`;
}
export function formatModelProfileUnknownProviderError(profileLabel: string, providers: readonly string[]): string {
	return `Model profile "${profileLabel}" requires provider(s) this build does not know: ${providers.join(", ")}. The profile likely targets a newer or custom build; declare the provider(s) in models.yml or use a build that ships them.`;
}

/**
 * A required profile provider that this build cannot know: it is neither a
 * built-in provider id nor declared in models.yml. That is a build/config
 * mismatch (for example a profile authored on a newer or custom build), not a
 * credential gap, so the diagnosis must not send the user to /login.
 *
 * Extends {@link ModelProfileCredentialError} so existing startup recovery
 * (interactive toast-and-continue) keeps working with the sharper message.
 */
export class ModelProfileUnknownProviderError extends ModelProfileCredentialError {
	readonly code = "unknown_provider";

	constructor(profileLabel: string, providers: readonly string[], role?: string) {
		super(profileLabel, providers, role);
		this.name = "ModelProfileUnknownProviderError";
		this.message = formatModelProfileUnknownProviderError(profileLabel, providers);
	}
}

/**
 * Rewrite a selector only within the selector provider's own alternative group.
 * Strict providers are never rewritten, and authenticated alternative providers
 * keep their original selectors.
 */
function rewriteSelectorProvider(
	selector: string,
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): string {
	const slash = selector.indexOf("/");
	if (slash < 0) return selector;

	const provider = selector.substring(0, slash);
	if (authenticatedProviders.has(provider)) return selector;

	const group = alternativeGroups.find(candidates => candidates.includes(provider));
	if (!group) return selector;

	const replacement = group.find(candidate => authenticatedProviders.has(candidate));
	if (!replacement) return selector;

	return replacement + selector.substring(slash);
}

function rewriteSelectorValueProvider(
	selectorValue: ModelSelectorValue,
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue).map(selector =>
		rewriteSelectorProvider(selector, authenticatedProviders, alternativeGroups),
	);
	return selectors.length === 1 && typeof selectorValue === "string" ? selectors[0] : selectors;
}

function rewriteBindingsProviders(
	bindings: {
		defaultSelector?: ModelSelectorValue;
		modelRoles: Record<string, ModelSelectorValue>;
		agentModelOverrides: Record<string, ModelSelectorValue>;
	},
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): {
	defaultSelector?: ModelSelectorValue;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
} {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorValueProvider(bindings.defaultSelector, authenticatedProviders, alternativeGroups)
			: undefined,
		modelRoles: Object.fromEntries(
			Object.entries(bindings.modelRoles).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups),
			]),
		),
		agentModelOverrides: Object.fromEntries(
			Object.entries(bindings.agentModelOverrides).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups),
			]),
		),
	};
}
export function isModelProfileProxyConfigured(
	provider: string,
	configuredProviders: readonly string[] | undefined,
	credentialless: boolean,
): boolean {
	return configuredProviders?.includes(provider) === true || (provider === "opencodex" && credentialless);
}

/**
 * Resolve the explicitly configured OpenAI-compatible proxy provider id for a
 * preset. Returns undefined when unset or empty. Passwords/labels are never
 * treated as proxy ids here; only lowercase provider ids from settings.
 */
export function resolveProxyProviderId(settings: Pick<Settings, "get"> | undefined): string | undefined {
	const config = inspectProxyProviderId(settings);
	if (config.status === "unset") return undefined;
	if (config.status === "invalid") {
		throw new Error(
			`modelProfile.proxyProvider must be a lowercase provider id (got "${config.value}"). Configure an OpenAI-compatible proxy with \`gjc setup provider\`, then set its id here.`,
		);
	}
	return config.id;
}

export type ProxyProviderConfig =
	| { status: "unset" }
	| { status: "configured"; id: string }
	| { status: "invalid"; value: string };

export function inspectProxyProviderId(settings: Pick<Settings, "get"> | undefined): ProxyProviderConfig {
	if (!settings) return { status: "unset" };
	const value = settings.get("modelProfile.proxyProvider");
	if (typeof value !== "string" || value.trim() === "") return { status: "unset" };
	const id = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9._-]*$/.test(id) ? { status: "configured", id } : { status: "invalid", value: value.trim() };
}

/** Passive surfaces fail closed on malformed settings instead of throwing. */
export function tryResolveProxyProviderId(settings: Pick<Settings, "get"> | undefined): string | undefined {
	const config = inspectProxyProviderId(settings);
	return config.status === "configured" ? config.id : undefined;
}

export type ModelProfileProxyMode = "fallback" | "always";

export function resolveProxyMode(settings: Pick<Settings, "get"> | undefined): ModelProfileProxyMode {
	if (!settings) return "fallback";
	const value = settings.get("modelProfile.proxyMode");
	if (value === undefined || value === "fallback" || value === "always") return value ?? "fallback";
	throw new Error(`modelProfile.proxyMode must be "fallback" or "always" (got "${String(value)}")`);
}

/**
 * Rewrite a qualified provider selector so its model is served through the
 * configured proxy. The proxy catalog uses sub-provider-prefixed model ids
 * (e.g. `xiaomi/mimo-v2.5-pro` under `litellm`). Exact provider-prefixed
 * matches win; a unique final-segment match is accepted for gateways that do
 * not retain the upstream provider prefix. Missing or ambiguous matches fail
 * closed rather than leaving an unauthenticated role selector behind.
 */
export function getProxyRoutableProviders(profile: ModelProfileDefinition): ReadonlySet<string> {
	if (profile.source === "user") return new Set();
	return profile.source === "registry"
		? new Set([
				...PROXY_ROUTABLE_PROVIDER_IDS,
				...profile.requiredProviders,
				...deriveModelProfileMappedProviders(profile),
			])
		: PROXY_ROUTABLE_PROVIDER_IDS;
}

/**
 * Profile sources whose non-default qualified role bindings are part of the
 * activation contract. Proxy rewrites run before role resolution, so a
 * rewritten selector satisfies this prerequisite when its concrete proxy
 * model is present in the effective catalog. Embedded built-ins intentionally
 * retain their legacy tolerance for stale qualified role tails.
 */
export function requiresQualifiedModelProfileRoleResolution(profile: Pick<ModelProfileDefinition, "source">): boolean {
	return profile.source === "user" || profile.source === "registry";
}

/** Resolve a removed saved-session default through its already-resolved owner without mutating persistent state. */
export async function resolveMissingSessionModelRecovery(options: {
	modelRegistry: PrepareModelProfileActivationOptions["modelRegistry"];
	settings: Pick<Settings, "get" | "getModelRole">;
	profileName: string;
	defaultEntries: readonly string[];
	skips: Array<{ selector: string; reason: string }>;
	savedDefault: string | undefined;
	credentialSessionId: string;
	aliasIntent?: "preset-equivalent";
}): Promise<
	| {
			profileName: string;
			entries: string[];
			model?: Model<Api>;
			thinkingLevel?: ThinkingLevel;
			explicitThinkingLevel: boolean;
			activeIndex: number;
			skips: Array<{ selector: string; reason: string }>;
	  }
	| undefined
> {
	const allSelectorsUnknown =
		options.skips.length === options.defaultEntries.length &&
		options.skips.every(skip => skip.reason === "unknown_model");
	if (!allSelectorsUnknown) return undefined;
	const fullCatalog = options.modelRegistry.getAll();
	const savedSelectorsMissingFromCatalog = resolveConfiguredModelPatterns(
		options.defaultEntries,
		options.settings,
	).every(selector => {
		if (
			resolveModelRoleValue(selector, fullCatalog, {
				settings: options.settings,
				modelRegistry: options.modelRegistry,
				credentialSessionId: options.credentialSessionId,
				...(options.aliasIntent ? { aliasIntent: options.aliasIntent } : {}),
			}).model
		)
			return false;
		return !registrySelectorResolvesToModel(selector, fullCatalog);
	});
	const savedConcreteDefault = options.savedDefault ? parseModelString(options.savedDefault) : undefined;
	const savedConcreteDefaultMissingFromCatalog =
		savedConcreteDefault === undefined ||
		!fullCatalog.some(
			model =>
				model.provider.toLowerCase() === savedConcreteDefault.provider.toLowerCase() &&
				model.id.toLowerCase() === savedConcreteDefault.id.toLowerCase(),
		);
	const profileName = options.profileName;
	if (!savedSelectorsMissingFromCatalog || !savedConcreteDefaultMissingFromCatalog || !profileName) return undefined;
	return resolveModelProfileDefaultChain({
		modelRegistry: options.modelRegistry,
		settings: options.settings,
		profileName,
		credentialSessionId: options.credentialSessionId,
	});
}

/** Resolve a durable profile's effective default chain without mutating session or settings state. */
export async function resolveModelProfileDefaultChain(options: {
	modelRegistry: PrepareModelProfileActivationOptions["modelRegistry"];
	settings: Pick<Settings, "get">;
	profileName: string;
	credentialSessionId: string;
}): Promise<{
	profileName: string;
	entries: string[];
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
	activeIndex: number;
	skips: Array<{ selector: string; reason: string }>;
}> {
	const profiles = options.modelRegistry.getModelProfiles();
	const profileName = validateModelProfileName(options.profileName, profiles, options.modelRegistry.getError?.());
	const profile = profiles.get(profileName) ?? options.modelRegistry.getModelProfile(profileName)!;
	const profileLabel = formatModelProfileDisplayLabel(profile);
	const requiredProviders = aggregateModelProfileRequiredProviders(profile.requiredProviders, profile);
	const alternativeGroups = profile.alternativeProviderGroups ?? [];
	const alternativeSet = new Set(alternativeGroups.flat());
	const requiredProviderSet = new Set(requiredProviders);
	const authenticatedProviders = new Set<string>();
	const missingProviders: string[] = [];
	const configuredProviderIds = options.modelRegistry.getConfiguredProviderIds?.();
	if (configuredProviderIds !== undefined || options.modelRegistry.isKnownProvider !== undefined) {
		const isProviderKnown = (provider: string): boolean =>
			(options.modelRegistry.isKnownProvider?.(provider) ?? false) ||
			isKnownProvider(provider) ||
			configuredProviderIds?.includes(provider) === true;
		const unknownProviderIds = new Set<string>();
		for (const provider of requiredProviders) {
			if (!alternativeSet.has(provider) && !isProviderKnown(provider)) unknownProviderIds.add(provider);
		}
		for (const group of alternativeGroups) {
			if (group.some(isProviderKnown)) continue;
			for (const provider of group) {
				if (!isProviderKnown(provider)) unknownProviderIds.add(provider);
			}
		}
		const unknownProviders = [...unknownProviderIds].sort();
		if (unknownProviders.length > 0) throw new ModelProfileUnknownProviderError(profileLabel, unknownProviders);
	}
	for (const provider of new Set([
		...requiredProviders,
		...alternativeSet,
		...deriveModelProfileMappedProviders(profile),
	])) {
		let apiKey: string | undefined;
		try {
			apiKey = await options.modelRegistry.getApiKeyForProvider(provider, options.credentialSessionId);
		} catch (error) {
			if (requiredProviderSet.has(provider) && !alternativeSet.has(provider)) throw error;
			continue;
		}
		if (apiKey === kNoAuth || isAuthenticated(apiKey)) authenticatedProviders.add(provider);
		else if (requiredProviderSet.has(provider)) missingProviders.push(provider);
	}
	const proxyProvider = profile.source !== "user" ? resolveProxyProviderId(options.settings) : undefined;
	const proxyMode = profile.source !== "user" ? resolveProxyMode(options.settings) : "fallback";
	const proxyRoutableProviders =
		profile.source === "user"
			? new Set<string>()
			: profile.source === "registry"
				? new Set([
						...PROXY_ROUTABLE_PROVIDER_IDS,
						...profile.requiredProviders,
						...deriveModelProfileMappedProviders(profile),
					])
				: PROXY_ROUTABLE_PROVIDER_IDS;
	if (proxyMode === "always" && proxyProvider === undefined)
		throw new Error('modelProfile.proxyMode "always" requires modelProfile.proxyProvider');
	const proxyApiKey =
		proxyProvider === undefined
			? undefined
			: await options.modelRegistry.getApiKeyForProvider(proxyProvider, options.credentialSessionId);
	if (
		proxyProvider !== undefined &&
		!isModelProfileProxyConfigured(proxyProvider, configuredProviderIds, proxyApiKey === kNoAuth)
	) {
		throw new Error(
			`modelProfile.proxyProvider "${proxyProvider}" is not configured. Configure it with \`gjc setup provider\` before activating a preset.`,
		);
	}
	const proxyAuthenticated = proxyApiKey !== undefined && (proxyApiKey === kNoAuth || isAuthenticated(proxyApiKey));
	if (proxyMode === "always" && !proxyAuthenticated)
		throw new ModelProfileCredentialError(profileLabel, [proxyProvider!]);
	const strictMissing = missingProviders.filter(
		provider => !proxyRoutableProviders.has(provider) && !alternativeSet.has(provider),
	);
	if (strictMissing.length > 0) throw new ModelProfileCredentialError(profileLabel, strictMissing);
	const strictRoutableMissing = missingProviders.filter(
		provider => proxyRoutableProviders.has(provider) && !alternativeSet.has(provider),
	);
	if (strictRoutableMissing.length > 0 && !proxyAuthenticated) {
		throw new ModelProfileCredentialError(
			profileLabel,
			proxyProvider === undefined ? strictRoutableMissing : [proxyProvider],
		);
	}
	for (const group of alternativeGroups) {
		if (group.some(provider => authenticatedProviders.has(provider))) continue;
		const allRoutable = group.every(provider => proxyRoutableProviders.has(provider));
		if (allRoutable && proxyAuthenticated) continue;
		throw new ModelProfileCredentialError(
			profileLabel,
			allRoutable && proxyProvider !== undefined ? [proxyProvider] : [...group],
		);
	}
	const availableModels =
		options.modelRegistry.getAvailableForProfileActivation?.() ??
		options.modelRegistry.getAvailable?.() ??
		options.modelRegistry.getAll();
	let bindings = resolveProfileBindings(profile);
	if (alternativeGroups.length > 0)
		bindings = rewriteBindingsProviders(bindings, authenticatedProviders, alternativeGroups);
	if (proxyProvider !== undefined && proxyAuthenticated && profile.source !== "user") {
		bindings = rewriteBindingsForProxy(
			bindings,
			proxyProvider,
			proxyMode,
			availableModels,
			authenticatedProviders,
			proxyRoutableProviders,
		);
	}
	await preflightModelProfileRoleBindings({
		profile,
		bindings,
		roleCatalogModels: options.modelRegistry.getAll(),
		settings: options.settings as Settings,
		modelRegistry: options.modelRegistry as ModelRegistry,
		sessionId: "",
		credentialSessionId: options.credentialSessionId,
		profileLabel,
	});
	if (!bindings.defaultSelector)
		return { profileName, entries: [], explicitThinkingLevel: false, activeIndex: 0, skips: [] };
	const defaultChain = normalizeModelSelectorValue(
		await resolveAndClampSelectorValue(
			bindings.defaultSelector,
			availableModels,
			{
				settings: options.settings as Settings,
				modelRegistry: options.modelRegistry as ModelRegistry,
				sessionId: "",
				credentialSessionId: options.credentialSessionId,
				aliasIntent: "preset-equivalent",
			},
			profileLabel,
			"default",
		),
	);
	const resolution = await resolveModelChainWithAuth(
		defaultChain,
		{
			getAvailable: () => availableModels,
			getApiKey: (model, sessionId) =>
				options.modelRegistry.getApiKeyForProvider(model.provider, sessionId, model.baseUrl),
			resolveCanonicalModel: options.modelRegistry.resolveCanonicalModel?.bind(options.modelRegistry),
			getCanonicalVariants: options.modelRegistry.getCanonicalVariants?.bind(options.modelRegistry),
			getCanonicalId: options.modelRegistry.getCanonicalId?.bind(options.modelRegistry),
			resolveModelByLookupAlias: options.modelRegistry.resolveModelByLookupAlias?.bind(options.modelRegistry),
			lookupAliasExists: options.modelRegistry.lookupAliasExists?.bind(options.modelRegistry),
			clearCanonicalVariant: options.modelRegistry.clearCanonicalVariant?.bind(options.modelRegistry),
		} as ModelRegistry,
		options.settings as Settings,
		options.credentialSessionId,
		{
			managedFallback: true,
			aliasIntent: "preset-equivalent",
			canonicalSessionId: null,
			credentialSessionId: options.credentialSessionId,
		},
	);
	return { profileName, entries: defaultChain, ...resolution };
}

export function rewriteSelectorForProxy(
	selector: string,
	proxyProvider: string,
	proxyMode: ModelProfileProxyMode,
	allModels: Model<Api>[],
	directlyAuthenticated: ReadonlySet<string>,
	routableProviders: ReadonlySet<string>,
): string {
	const suffix = splitSelectorThinkingSuffix(selector);
	const baseSelector = suffix.selector;
	const slash = baseSelector.indexOf("/");
	const proxyModels = allModels.filter(model => model.provider === proxyProvider);
	const matchingProxyModels = (id: string): Model<Api>[] => {
		const publicMatches = proxyModels.filter(model => model.id === id);
		return publicMatches.length > 0 ? publicMatches : proxyModels.filter(model => model.wireModelId === id);
	};
	if (slash < 0) {
		if (proxyMode === "fallback") return selector;
		const exactMatches = matchingProxyModels(baseSelector);
		const finalSegmentMatches = proxyModels.filter(model => model.id.split("/").at(-1) === baseSelector);
		const matches = exactMatches.length > 0 ? exactMatches : finalSegmentMatches;
		if (matches.length !== 1) {
			throw new Error(
				`Configured proxy "${proxyProvider}" does not expose an unambiguous model for "${baseSelector}"`,
			);
		}
		const rewritten = `${proxyProvider}/${matches[0]!.id}`;
		return suffix.thinkingLevel ? formatModelSelectorValue(rewritten, suffix.thinkingLevel) : rewritten;
	}
	const directProvider = baseSelector.substring(0, slash);
	if (proxyMode === "fallback" && directlyAuthenticated.has(directProvider)) return selector;
	if (!routableProviders.has(directProvider)) return selector;
	if (proxyProvider === directProvider) {
		throw new Error(`Configured proxy "${proxyProvider}" cannot route its own direct selector "${baseSelector}"`);
	}
	const directModelId = baseSelector.substring(slash + 1);
	const exactMatches = matchingProxyModels(`${directProvider}/${directModelId}`);
	const flatMatches = matchingProxyModels(directModelId);
	const matches = exactMatches.length > 0 ? exactMatches : flatMatches;
	if (matches.length === 0) {
		throw new Error(`Configured proxy "${proxyProvider}" does not expose a model for "${baseSelector}"`);
	}
	if (matches.length > 1) {
		throw new Error(`Configured proxy "${proxyProvider}" has ambiguous models for "${baseSelector}"`);
	}
	const rewritten = `${proxyProvider}/${matches[0]!.id}`;
	return suffix.thinkingLevel ? formatModelSelectorValue(rewritten, suffix.thinkingLevel) : rewritten;
}

function rewriteSelectorValueForProxy(
	selectorValue: ModelSelectorValue,
	proxyProvider: string,
	proxyMode: "fallback" | "always",
	allModels: Model<Api>[],
	directlyAuthenticated: ReadonlySet<string>,
	routableProviders: ReadonlySet<string>,
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue).map(selector =>
		rewriteSelectorForProxy(selector, proxyProvider, proxyMode, allModels, directlyAuthenticated, routableProviders),
	);
	return selectors.length === 1 && typeof selectorValue === "string" ? selectors[0] : selectors;
}

function rewriteBindingsForProxy(
	bindings: {
		defaultSelector?: ModelSelectorValue;
		modelRoles: Record<string, ModelSelectorValue>;
		agentModelOverrides: Record<string, ModelSelectorValue>;
	},
	proxyProvider: string,
	proxyMode: "fallback" | "always",
	allModels: Model<Api>[],
	directlyAuthenticated: ReadonlySet<string>,
	routableProviders: ReadonlySet<string>,
): {
	defaultSelector?: ModelSelectorValue;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
} {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorValueForProxy(
					bindings.defaultSelector,
					proxyProvider,
					proxyMode,
					allModels,
					directlyAuthenticated,
					routableProviders,
				)
			: undefined,
		modelRoles: Object.fromEntries(
			Object.entries(bindings.modelRoles).map(([role, selector]) => [
				role,
				rewriteSelectorValueForProxy(
					selector,
					proxyProvider,
					proxyMode,
					allModels,
					directlyAuthenticated,
					routableProviders,
				),
			]),
		),
		agentModelOverrides: Object.fromEntries(
			Object.entries(bindings.agentModelOverrides).map(([role, selector]) => [
				role,
				rewriteSelectorValueForProxy(
					selector,
					proxyProvider,
					proxyMode,
					allModels,
					directlyAuthenticated,
					routableProviders,
				),
			]),
		),
	};
}

function formatMaterializedSelector(selector: string, model: Model<Api>): string {
	const suffix = splitSelectorThinkingSuffix(selector);
	if (!suffix.selector.includes("/") && suffix.thinkingLevel && model.thinking) {
		const clamped = clampExplicitThinkingLevelForModel(model, suffix.thinkingLevel);
		return clamped && clamped !== ThinkingLevel.Inherit
			? formatModelSelectorValue(suffix.selector, clamped)
			: suffix.selector;
	}
	const clampedSelector = formatClampedModelSelector(selector, model);
	const explicitThinkingLevel = parseModelString(selector)?.thinkingLevel;
	if (!explicitThinkingLevel || parseModelString(clampedSelector)?.thinkingLevel) return clampedSelector;
	return formatModelSelectorValue(clampedSelector, explicitThinkingLevel);
}
function getBareSelectorCredentialProviders(selector: string, modelRegistry: ModelRegistry): string[] {
	const suffix = splitSelectorThinkingSuffix(selector);
	const alias = (suffix.thinkingLevel ? suffix.selector : selector).trim().toLowerCase();
	const providers = modelRegistry
		.getAll()
		.filter(model => {
			const modelId = model.id.trim().toLowerCase();
			return modelId === alias || modelId.slice(modelId.lastIndexOf("/") + 1) === alias;
		})
		.map(model => model.provider);
	return [...new Set(providers)];
}

async function resolveAndClampSelectorValue(
	selectorValue: ModelSelectorValue,
	availableModels: Model<Api>[],
	options: {
		settings: Settings;
		modelRegistry: ModelRegistry;
		sessionId: string;
		credentialSessionId: string;
		aliasIntent: "preset-equivalent";
		requireQualifiedResolution?: boolean;
	},
	profileLabel: string,
	role: string,
): Promise<ModelSelectorValue> {
	const selectors = normalizeModelSelectorValue(selectorValue);
	const clamped: string[] = [];
	const unresolvedKnownBareProviders = new Set<string>();
	const unresolvedQualifiedSelectors: string[] = [];
	let everySelectorIsKnownBare = selectors.length > 1;
	let resolvedAny = false;
	for (const selector of selectors) {
		const bareAlias = !splitSelectorThinkingSuffix(selector).selector.includes("/");
		let resolved = resolveModelRoleValue(selector, availableModels, options);
		if (bareAlias) {
			const authenticated = await resolveModelChainWithAuth(
				[selector],
				{
					getAvailable: () => availableModels,
					getApiKey: model =>
						options.modelRegistry.getApiKeyForProvider(
							model.provider,
							options.credentialSessionId,
							model.baseUrl,
						),
					resolveCanonicalModel: options.modelRegistry.resolveCanonicalModel.bind(options.modelRegistry),
					resolveModelByLookupAlias: options.modelRegistry.resolveModelByLookupAlias?.bind(options.modelRegistry),
					lookupAliasExists: options.modelRegistry.lookupAliasExists?.bind(options.modelRegistry),
					clearCanonicalVariant: options.modelRegistry.clearCanonicalVariant?.bind(options.modelRegistry),
				},
				options.settings,
				options.credentialSessionId,
				{
					managedFallback: true,
					aliasIntent: options.aliasIntent,
					canonicalSessionId: options.sessionId,
					credentialSessionId: options.credentialSessionId,
				},
			);
			resolved = {
				model: authenticated.model,
				thinkingLevel: authenticated.thinkingLevel,
				explicitThinkingLevel: authenticated.explicitThinkingLevel,
				warning: undefined,
			};
		}
		if (!resolved.model) {
			if (bareAlias) {
				const providers = getBareSelectorCredentialProviders(selector, options.modelRegistry);
				const selectorSuffix = splitSelectorThinkingSuffix(selector);
				const bareSelector = selectorSuffix.thinkingLevel ? selectorSuffix.selector : selector;
				const aliasKnown =
					options.modelRegistry.lookupAliasExists?.(bareSelector.toLowerCase()) ?? providers.length > 0;
				if (selectors.length === 1) {
					if (!aliasKnown) {
						throw new Error(
							`Model profile "${profileLabel}" ${role} selector "${bareSelector}" does not match any catalog model`,
						);
					}
					throw new ModelProfileCredentialError(
						profileLabel,
						providers.length > 0 ? providers : [bareSelector],
						role,
					);
				}
				if (aliasKnown) {
					for (const provider of providers.length > 0 ? providers : [bareSelector]) {
						unresolvedKnownBareProviders.add(provider);
					}
				} else {
					everySelectorIsKnownBare = false;
				}
			} else {
				unresolvedQualifiedSelectors.push(selector);
				everySelectorIsKnownBare = false;
			}
			clamped.push(selector);
			continue;
		}
		resolvedAny = true;
		clamped.push(formatMaterializedSelector(selector, resolved.model));
	}
	if (!resolvedAny && everySelectorIsKnownBare && unresolvedKnownBareProviders.size > 0) {
		throw new ModelProfileCredentialError(profileLabel, [...unresolvedKnownBareProviders].sort(), role);
	}
	if (options.requireQualifiedResolution && !resolvedAny && unresolvedQualifiedSelectors.length > 0) {
		throw new Error(
			`Model profile "${profileLabel}" ${role} selectors do not match any catalog model: ${unresolvedQualifiedSelectors.join(", ")}`,
		);
	}
	return clamped.length === 1 && typeof selectorValue === "string" ? clamped[0] : clamped;
}

/** Resolve every non-default binding under the profile activation contract without installing it. */
async function preflightModelProfileRoleBindings(options: {
	profile: ModelProfileDefinition;
	bindings: ResolvedProfileBinding;
	roleCatalogModels: Model<Api>[];
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
	credentialSessionId: string;
	profileLabel: string;
}): Promise<{
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
}> {
	const resolveBindings = async (bindings: Record<string, ModelSelectorValue>) => {
		const resolved: Record<string, ModelSelectorValue> = {};
		for (const [role, selectorValue] of Object.entries(bindings) as [
			GjcModelAssignmentTargetId,
			ModelSelectorValue,
		][]) {
			resolved[role] = await resolveAndClampSelectorValue(
				selectorValue,
				options.roleCatalogModels,
				{
					settings: options.settings,
					modelRegistry: options.modelRegistry,
					sessionId: options.sessionId,
					credentialSessionId: options.credentialSessionId,
					aliasIntent: "preset-equivalent",
					requireQualifiedResolution: requiresQualifiedModelProfileRoleResolution(options.profile),
				},
				options.profileLabel,
				role,
			);
		}
		return resolved;
	};
	return {
		modelRoles: await resolveBindings(options.bindings.modelRoles),
		agentModelOverrides: await resolveBindings(options.bindings.agentModelOverrides),
	};
}

/**
 * Restore the session's canonical sticky variant after a failed activation.
 * The exact pre-clear sticky selector (snapshotted verbatim, never re-derived
 * from the live model) is restored when present; otherwise any stale sticky
 * variant is cleared so a previous provider cannot silently resurrect.
 */
function restoreCanonicalVariant(
	modelRegistry: PrepareModelProfileActivationOptions["modelRegistry"],
	sessionId: string,
	previousCanonicalVariant: string | undefined,
): void {
	if (previousCanonicalVariant !== undefined) {
		const restored = modelRegistry.restoreSessionCanonicalVariant?.(sessionId, previousCanonicalVariant) === true;
		if (!restored) modelRegistry.clearCanonicalVariant?.(sessionId);
	} else {
		modelRegistry.clearCanonicalVariant?.(sessionId);
	}
}
export async function prepareModelProfileActivation(
	options: PrepareModelProfileActivationOptions,
): Promise<PreparedModelProfileActivation> {
	const profiles = options.modelRegistry.getModelProfiles();
	const profileName = validateModelProfileName(options.profileName, profiles, options.modelRegistry.getError?.());
	const profile = profiles.get(profileName) ?? options.modelRegistry.getModelProfile(profileName)!;
	const profileLabel = formatModelProfileDisplayLabel(profile);

	const previousModel = options.session.model;
	// Snapshot the exact pre-clear sticky selector (verbatim, not re-derived from
	// the live model) so a failed prepare/apply/materialize rollback restores the
	// genuinely-sticky provider even when the live model is a transient switch.
	const credentialSessionId = options.session.credentialSessionId ?? options.session.sessionId;
	const previousCanonicalVariant = options.modelRegistry.getSessionCanonicalVariant?.(options.session.sessionId);

	// Explicit profile activation/reselection invalidates the session's sticky
	// canonical variant BEFORE the new profile's aliases resolve, so the old
	// provider's sticky variant cannot win the new profile's resolution.
	options.modelRegistry.clearCanonicalVariant?.(options.session.sessionId);

	try {
		const requiredProviders = aggregateModelProfileRequiredProviders(profile.requiredProviders, profile);
		const alternativeGroups = profile.alternativeProviderGroups ?? [];
		const alternativeSet = new Set(alternativeGroups.flat());
		const requiredProviderSet = new Set(requiredProviders);
		const authenticationProbeProviders = new Set<string>([
			...requiredProviders,
			...alternativeSet,
			...deriveModelProfileMappedProviders(profile),
		]);
		// A required provider this build cannot know is a build/config mismatch,
		// not a credential gap: diagnose it before any auth probing so the user
		// is never sent to /login for a provider this binary cannot serve (for
		// example a models.yml profile authored on a newer or custom build). A
		// registry without provider visibility keeps the legacy
		// credential diagnosis.
		const configuredProviderIds = options.modelRegistry.getConfiguredProviderIds?.();
		if (configuredProviderIds !== undefined || options.modelRegistry.isKnownProvider !== undefined) {
			const isProviderKnown = (provider: string): boolean =>
				(options.modelRegistry.isKnownProvider?.(provider) ?? false) ||
				isKnownProvider(provider) ||
				configuredProviderIds?.includes(provider) === true;
			const unknownRequiredProviders = new Set<string>();
			for (const provider of requiredProviders) {
				if (!alternativeSet.has(provider) && !isProviderKnown(provider)) unknownRequiredProviders.add(provider);
			}
			for (const group of alternativeGroups) {
				if (group.some(isProviderKnown)) continue;
				for (const provider of group) {
					if (!isProviderKnown(provider)) unknownRequiredProviders.add(provider);
				}
			}
			const unknownProviderIds = [...unknownRequiredProviders].sort();
			if (unknownProviderIds.length > 0) {
				throw new ModelProfileUnknownProviderError(profileLabel, unknownProviderIds);
			}
		}

		const missingProviders: string[] = [];
		const authenticatedProviders: string[] = [];
		for (const provider of authenticationProbeProviders) {
			let apiKey: string | undefined;
			try {
				apiKey = await options.modelRegistry.getApiKeyForProvider(provider, credentialSessionId);
			} catch (error) {
				if (requiredProviderSet.has(provider) && !alternativeSet.has(provider)) throw error;
				continue;
			}
			if (apiKey !== kNoAuth && !isAuthenticated(apiKey)) {
				if (requiredProviderSet.has(provider)) missingProviders.push(provider);
			} else {
				authenticatedProviders.push(provider);
			}
		}

		// Required providers are the only activation prerequisites. Mapped fallback
		// providers are resolution-time candidates and intentionally do not gate here.
		// A proxy-routable strict provider is satisfied through the configured
		// OpenAI-compatible proxy when that proxy is itself authenticated; otherwise
		// we fail closed pointing at the proxy (or the provider when none is set).
		const proxyProvider = profile.source !== "user" ? resolveProxyProviderId(options.settings) : undefined;
		const proxyMode = profile.source !== "user" ? resolveProxyMode(options.settings) : "fallback";
		const proxyRoutableProviders =
			profile.source === "user"
				? new Set<string>()
				: profile.source === "registry"
					? new Set([
							...PROXY_ROUTABLE_PROVIDER_IDS,
							...profile.requiredProviders,
							...deriveModelProfileMappedProviders(profile),
						])
					: PROXY_ROUTABLE_PROVIDER_IDS;
		if (proxyMode === "always" && proxyProvider === undefined) {
			throw new Error('modelProfile.proxyMode "always" requires modelProfile.proxyProvider');
		}
		const proxyApiKey =
			proxyProvider === undefined
				? undefined
				: await options.modelRegistry.getApiKeyForProvider(proxyProvider, credentialSessionId);
		if (proxyProvider !== undefined) {
			const configuredProxyProviders = options.modelRegistry.getConfiguredProviderIds?.();
			if (!isModelProfileProxyConfigured(proxyProvider, configuredProxyProviders, proxyApiKey === kNoAuth)) {
				throw new Error(
					`modelProfile.proxyProvider "${proxyProvider}" is not configured. Configure it with \`gjc setup provider\` before activating a preset.`,
				);
			}
		}
		const proxyAuthenticated =
			proxyProvider !== undefined &&
			proxyApiKey !== undefined &&
			(proxyApiKey === kNoAuth || isAuthenticated(proxyApiKey));
		if (proxyMode === "always" && !proxyAuthenticated) {
			throw new ModelProfileCredentialError(profileLabel, [proxyProvider!]);
		}

		const strictMissing = missingProviders.filter(
			provider => !proxyRoutableProviders.has(provider) && !alternativeSet.has(provider),
		);
		if (strictMissing.length > 0) {
			throw new ModelProfileCredentialError(profileLabel, strictMissing);
		}
		const strictRoutableMissing = missingProviders.filter(
			provider => proxyRoutableProviders.has(provider) && !alternativeSet.has(provider),
		);
		if (strictRoutableMissing.length > 0 && (proxyProvider === undefined || !proxyAuthenticated)) {
			throw new ModelProfileCredentialError(
				profileLabel,
				proxyProvider === undefined ? strictRoutableMissing : [proxyProvider],
			);
		}
		for (const group of alternativeGroups) {
			const groupAuthenticated = group.some(provider => authenticatedProviders.includes(provider));
			if (groupAuthenticated) continue;
			const allRoutable = group.every(provider => proxyRoutableProviders.has(provider));
			if (allRoutable && proxyAuthenticated) continue;
			throw new ModelProfileCredentialError(
				profileLabel,
				allRoutable && proxyProvider !== undefined ? [proxyProvider] : [...group],
			);
		}

		const availableModels =
			options.modelRegistry.getAvailableForProfileActivation?.() ??
			options.modelRegistry.getAvailable?.() ??
			options.modelRegistry.getAll();
		const roleCatalogModels = options.modelRegistry.getAll();
		let bindings = resolveProfileBindings(profile);
		if (alternativeGroups.length > 0) {
			bindings = rewriteBindingsProviders(bindings, new Set(authenticatedProviders), alternativeGroups);
		}
		// Built-in preset selectors are routed through a configured authenticated
		// proxy according to the selected mode. This session-scoped rewrite is never
		// persisted to models.yml.
		if (proxyProvider !== undefined && proxyAuthenticated && profile.source !== "user") {
			bindings = rewriteBindingsForProxy(
				bindings,
				proxyProvider,
				proxyMode,
				availableModels,
				new Set(authenticatedProviders),
				proxyRoutableProviders,
			);
		}
		const defaultSelectors = bindings.defaultSelector ? normalizeModelSelectorValue(bindings.defaultSelector) : [];
		const defaultChain =
			defaultSelectors.length > 0
				? normalizeModelSelectorValue(
						await resolveAndClampSelectorValue(
							bindings.defaultSelector!,
							availableModels,
							{
								settings: options.settings as Settings,
								modelRegistry: options.modelRegistry as ModelRegistry,
								sessionId: options.session.sessionId,
								credentialSessionId,
								aliasIntent: "preset-equivalent",
							},
							profileLabel,
							"default",
						),
					)
				: [];
		const defaultResolution = await resolveModelChainWithAuth(
			defaultChain,
			{
				getAvailable: () => availableModels,
				getApiKey: (model, sessionId) =>
					options.modelRegistry.getApiKeyForProvider(model.provider, sessionId, model.baseUrl),
				resolveCanonicalModel: options.modelRegistry.resolveCanonicalModel?.bind(options.modelRegistry),
				getCanonicalVariants: options.modelRegistry.getCanonicalVariants?.bind(options.modelRegistry),
				getCanonicalId: options.modelRegistry.getCanonicalId?.bind(options.modelRegistry),
				resolveModelByLookupAlias: options.modelRegistry.resolveModelByLookupAlias?.bind(options.modelRegistry),
				lookupAliasExists: options.modelRegistry.lookupAliasExists?.bind(options.modelRegistry),
				clearCanonicalVariant: options.modelRegistry.clearCanonicalVariant?.bind(options.modelRegistry),
			} as ModelRegistry,
			options.settings as Settings,
			credentialSessionId,
			{
				managedFallback: true,
				aliasIntent: "preset-equivalent",
				canonicalSessionId: options.session.sessionId,
				credentialSessionId,
			},
		);
		const defaultModel = defaultResolution.model;
		const defaultThinkingLevel = defaultResolution.thinkingLevel;
		const defaultActiveIndex = defaultModel ? defaultResolution.activeIndex : undefined;
		const defaultResolutionSkips = defaultResolution.skips;
		if (bindings.defaultSelector && !defaultModel) {
			const configuredDefaults = normalizeModelSelectorValue(bindings.defaultSelector);
			if (configuredDefaults.length === 1) {
				throw new Error(
					`Model profile "${profileLabel}" default selector did not resolve: ${configuredDefaults[0]}`,
				);
			}
			throw new Error(`Model profile "${profileLabel}" default selectors did not resolve to an authenticated model`);
		}

		const { modelRoles, agentModelOverrides } = await preflightModelProfileRoleBindings({
			profile,
			bindings,
			roleCatalogModels,
			settings: options.settings as Settings,
			modelRegistry: options.modelRegistry as ModelRegistry,
			sessionId: options.session.sessionId,
			credentialSessionId,
			profileLabel,
		});

		return {
			profileName,
			session: options.session as PreparedModelProfileActivation["session"],
			settings: options.settings as PreparedModelProfileActivation["settings"],
			modelRegistry: options.modelRegistry,
			previousModel,
			previousCanonicalVariant,
			previousThinkingLevel: options.session.thinkingLevel,
			previousAgentModelOverrides: { ...options.settings.get("task.agentModelOverrides") },
			previousModelRoles: { ...options.settings.get("modelRoles") },
			baseAgentModelOverrides: Object.fromEntries(
				Object.entries(options.settings.get("task.agentModelOverrides") ?? {}).filter(
					([key]) =>
						!(options.session.getProfileInstalledOverrideKeys?.().agentModelOverrides ?? []).includes(key),
				),
			),
			baseModelRoles: Object.fromEntries(
				Object.entries(options.settings.get("modelRoles") ?? {}).filter(
					([key]) => !(options.session.getProfileInstalledOverrideKeys?.().modelRoles ?? []).includes(key),
				),
			),
			previousPersistedModelRoles: options.settings.getGlobal("modelRoles"),
			previousPersistedAgentModelOverrides: options.settings.getGlobal("task.agentModelOverrides"),
			previousModelRolesOverride: options.settings.getOverride("modelRoles"),
			previousAgentModelOverridesOverride: options.settings.getOverride("task.agentModelOverrides"),
			previousDefaultProfileOverride: options.settings.getOverride("modelProfile.default"),
			previousPersistedDefaultProfile: options.settings.getGlobal("modelProfile.default"),
			previousPersistedDefaultThinkingLevel: options.settings.getGlobal("defaultThinkingLevel") as
				| Exclude<ThinkingLevel, "inherit">
				| undefined,
			previousDefaultThinkingLevelOverride: options.settings.getOverride("defaultThinkingLevel"),
			previousDefaultChain: options.session.getConfiguredModelChain("default"),
			previousDefaultChainState: options.session.getConfiguredModelChainState?.("default"),

			defaultModel,
			defaultThinkingLevel,
			defaultActiveIndex,
			defaultResolutionSkips,
			defaultChain,
			modelRoles,
			agentModelOverrides,
			previousActiveModelProfile: options.session.getActiveModelProfile?.(),
			previousModelProfileOwnershipMarker: options.session.getModelProfileOwnershipMarker?.(),
			previousModelProfileOwnershipFailure: options.session.hasModelProfileOwnershipFailure?.() ?? false,
			previousDurableModelProfileOwnership:
				options.session.getDurableModelProfileOwnershipSnapshot?.() ??
				readDurableModelProfileOwnership(options.settings),
			previousSessionDefaultModel: options.session.getSessionDefaultModelSelector?.(),
			previousDefaultFallbackRuntimeState: options.session.getDefaultFallbackRuntimeState?.(),
		};
	} catch (error) {
		try {
			restoreCanonicalVariant(options.modelRegistry, options.session.sessionId, previousCanonicalVariant);
		} catch (rollbackError) {
			throw incompleteModelProfileRollbackError("preparation", "profile preflight", error, [
				{ stage: "restore canonical model variant", error: rollbackError },
			]);
		}
		throw error;
	}
}

function modelProfileFailureReason(error: unknown, stage: string): string {
	try {
		if (error instanceof ModelProfileCredentialError) return "required credentials unavailable";
		if (error instanceof Error && error.message.startsWith("No API key for ")) return "credentials unavailable";
	} catch {
		// An exotic error getter must not replace the activation failure.
	}
	return stage.includes("settings") || stage.startsWith("persist ") || stage.endsWith(" setting")
		? "settings write failed"
		: "operation failed";
}

class ModelProfileActivationStageError extends Error {
	readonly stage: string;

	constructor(stage: string, error: unknown) {
		super(`${stage} (${modelProfileFailureReason(error, stage)})`, { cause: error });
		this.name = "ModelProfileActivationStageError";
		this.stage = stage;
	}
}

function incompleteModelProfileRollbackError(
	phase: "preparation" | "activation",
	stage: string,
	error: unknown,
	rollbackErrors: readonly { stage: string; error: unknown }[],
): AggregateError {
	const primary = new ModelProfileActivationStageError(stage, error);
	const incomplete = rollbackErrors.map(failure => new ModelProfileActivationStageError(failure.stage, failure.error));
	return new AggregateError(
		[primary, ...incomplete],
		`Model profile ${phase} failed at ${primary.message}; rollback incomplete: ${incomplete.map(failure => failure.message).join("; ")}. Prior state may be unverified.`,
	);
}

async function commitPreparedDurableModelProfileOwnership(
	prepared: PreparedModelProfileActivation,
	marker: ModelProfileOwnershipMarker,
): Promise<DurableModelProfileOwnershipCommit> {
	const thinkingPatches: SettingsAtomicPatch[] =
		marker.kind === "profile" &&
		prepared.defaultThinkingLevel !== undefined &&
		prepared.defaultThinkingLevel !== ThinkingLevel.Inherit
			? [{ path: "defaultThinkingLevel", op: "set", value: prepared.defaultThinkingLevel }]
			: [];
	return commitDurableModelProfileOwnershipWithResult(
		prepared.settings,
		marker,
		thinkingPatches,
		marker.kind === "profile"
			? () => prepared.modelRegistry.assertCurrentModelProfileExists?.(marker.profile)
			: undefined,
		prepared.previousDurableModelProfileOwnership,
	);
}

export async function applyPreparedModelProfileActivation(
	prepared: PreparedModelProfileActivation,
	options: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	let activationStage = "default chain";
	let committedDurableOwnership: DurableModelProfileOwnership | undefined;
	let durableOwnershipVersionAdvanced = false;
	let modelMutationStarted = false;
	let overridesChanged = false;
	let modelRolesChanged = false;
	let defaultChainChanged = false;
	let resumeDefaultChanged = false;
	let ownershipMarkerChanged = false;

	try {
		if (options.persistDefault) {
			activationStage = "commit durable profile ownership";
			const durableCommit = await commitPreparedDurableModelProfileOwnership(prepared, {
				kind: "profile",
				profile: prepared.profileName,
			});
			committedDurableOwnership = durableCommit.ownership;
			durableOwnershipVersionAdvanced = durableCommit.wrote;
			prepared.session.updateDurableModelProfileOwnershipSnapshot?.(committedDurableOwnership);
		}
		const ownedDefaultChain =
			prepared.defaultChain.length > 0
				? prepared.defaultChain
				: (prepared.previousDefaultChain ??
					(prepared.previousModel ? [formatModelString(prepared.previousModel)] : []));
		if (ownedDefaultChain.length > 0) {
			defaultChainChanged = true;
			prepared.session.setConfiguredModelChain(
				"default",
				ownedDefaultChain,
				"profile-activation",
				prepared.profileName,
				true,
			);
			if (prepared.defaultActiveIndex !== undefined) {
				prepared.session.seedDefaultFallbackResolution?.(
					prepared.defaultActiveIndex,
					prepared.defaultResolutionSkips,
				);
			}
		}
		if (prepared.defaultModel) {
			activationStage = "model selection";
			await prepared.session.setModelTemporary(
				prepared.defaultModel,
				options.thinkingLevelOverride ?? prepared.defaultThinkingLevel,
				{
					cause: "profile-activation",
					onMutationStarted: () => {
						modelMutationStarted = true;
					},
				},
			);
		}
		// Always reinstall the model role layer from the durable base plus the
		// new profile's roles so omitted roles from the previous profile are dropped.
		activationStage = "model role overrides";
		prepared.settings.override("modelRoles", {
			...prepared.baseModelRoles,
			...prepared.modelRoles,
		});
		modelRolesChanged = true;
		// Always reinstall the agent role layer from the durable base plus the
		// new profile's roles: a default-only or role-free successor must drop
		// the previous profile's role-agent mappings rather than inheriting them.
		activationStage = "agent role overrides";
		prepared.settings.override("task.agentModelOverrides", {
			...prepared.baseAgentModelOverrides,
			...prepared.agentModelOverrides,
		});
		overridesChanged = true;
		activationStage = "active profile marker";
		prepared.session.setActiveModelProfile?.(prepared.profileName);
		if (prepared.defaultModel) {
			activationStage = "canonical model variant";
			prepared.modelRegistry.seedCanonicalVariant?.(prepared.session.sessionId, prepared.defaultModel);
			resumeDefaultChanged = true;
			activationStage = "resume default model";
			prepared.session.recordResumeDefaultModel?.(`${prepared.defaultModel.provider}/${prepared.defaultModel.id}`);
		}
		activationStage = "installed role tracking";
		prepared.session.noteProfileInstalledOverrides?.(
			Object.keys(prepared.modelRoles),
			Object.keys(prepared.agentModelOverrides),
			prepared.previousModel,
		);
		const nextSessionMarker: ModelProfileOwnershipMarker =
			options.ownershipMarker ??
			(options.persistDefault ? { kind: "inherit" } : { kind: "profile", profile: prepared.profileName });
		if (options.commitOwnershipMarker !== false && prepared.session.commitModelProfileOwnershipMarker) {
			activationStage = "persist session ownership marker";
			ownershipMarkerChanged = true;
			await prepared.session.commitModelProfileOwnershipMarker(nextSessionMarker);
		}
		prepared.session.markModelProfileOwnershipReady?.();
		const ownershipStateChanged =
			durableOwnershipVersionAdvanced ||
			prepared.previousModelProfileOwnershipFailure ||
			!modelProfileOwnershipMarkersEqual(prepared.previousModelProfileOwnershipMarker, nextSessionMarker);
		if (options.emitOwnershipEvent !== false && ownershipStateChanged) {
			const event: ProfileOwnershipChangedEvent = {
				type: "profile_ownership_changed",
				transitionId: globalThis.crypto.randomUUID(),
				source: options.persistDefault ? (durableOwnershipVersionAdvanced ? "durable" : "recovery") : "session",
				oldMarker: prepared.previousModelProfileOwnershipMarker ?? { kind: "inherit" },
				newMarker: nextSessionMarker,
				oldSessionId: prepared.session.sessionId,
				sessionId: prepared.session.sessionId,
				observedDurableVersion:
					options.persistDefault && !durableOwnershipVersionAdvanced
						? (committedDurableOwnership?.version ?? prepared.previousDurableModelProfileOwnership.version)
						: prepared.previousDurableModelProfileOwnership.version,
				...(durableOwnershipVersionAdvanced && committedDurableOwnership
					? { committedDurableVersion: committedDurableOwnership.version }
					: {}),
				outcome: options.persistDefault && !durableOwnershipVersionAdvanced ? "reconciled" : "committed",
			};
			try {
				prepared.session.emitProfileOwnershipChanged?.(event);
			} catch (error) {
				logger.warn("Failed to emit model-profile ownership event after commit", {
					profile: prepared.profileName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} catch (error) {
		const rollbackErrors: Array<{ stage: string; error: unknown }> = [];
		const restore = (stage: string, action: () => void): void => {
			try {
				action();
			} catch (rollbackError) {
				rollbackErrors.push({ stage, error: rollbackError });
			}
		};
		if (modelRolesChanged) {
			restore("restore model role overrides", () =>
				prepared.previousModelRolesOverride === undefined
					? prepared.settings.clearOverride("modelRoles")
					: prepared.settings.override("modelRoles", prepared.previousModelRolesOverride),
			);
		}
		if (overridesChanged) {
			restore("restore agent role overrides", () =>
				prepared.previousAgentModelOverridesOverride === undefined
					? prepared.settings.clearOverride("task.agentModelOverrides")
					: prepared.settings.override("task.agentModelOverrides", prepared.previousAgentModelOverridesOverride),
			);
		}
		if (modelMutationStarted) {
			try {
				if (prepared.session.restoreModelSelectionForRollback) {
					await prepared.session.restoreModelSelectionForRollback(
						prepared.previousModel,
						prepared.previousThinkingLevel,
					);
				} else if (prepared.previousModel) {
					await prepared.session.setModelTemporary(prepared.previousModel, prepared.previousThinkingLevel, {
						cause: "rollback",
					});
				} else {
					throw new Error("Model-less profile activation rollback is unavailable");
				}
			} catch (rollbackError) {
				rollbackErrors.push({ stage: "restore live model", error: rollbackError });
			}
		}
		if (resumeDefaultChanged) {
			restore("restore resume default", () =>
				prepared.session.recordResumeDefaultModel?.(prepared.previousSessionDefaultModel),
			);
		}
		if (defaultChainChanged) {
			const previousChain = prepared.previousDefaultChainState;
			restore("restore default chain", () =>
				prepared.session.setConfiguredModelChain(
					"default",
					previousChain?.entries ??
						prepared.previousDefaultChain ??
						(prepared.previousModel ? [`${prepared.previousModel.provider}/${prepared.previousModel.id}`] : []),
					previousChain?.origin ?? "rollback",
					previousChain?.identity,
					previousChain?.explicitHead ?? true,
				),
			);
		}
		if (prepared.previousDefaultFallbackRuntimeState) {
			restore("restore fallback runtime", () =>
				prepared.session.restoreDefaultFallbackRuntimeState?.(prepared.previousDefaultFallbackRuntimeState!),
			);
		}
		restore("restore active profile", () =>
			prepared.session.setActiveModelProfile?.(prepared.previousActiveModelProfile),
		);
		restore("restore canonical model variant", () =>
			restoreCanonicalVariant(prepared.modelRegistry, prepared.session.sessionId, prepared.previousCanonicalVariant),
		);
		if (ownershipMarkerChanged) {
			try {
				await prepared.session.commitModelProfileOwnershipMarker?.(
					prepared.previousModelProfileOwnershipMarker ?? { kind: "inherit" },
				);
			} catch (rollbackError) {
				rollbackErrors.push({ stage: "restore session ownership marker", error: rollbackError });
			}
		}
		if (committedDurableOwnership) {
			const cause =
				rollbackErrors.length > 0
					? new AggregateError(
							[error, ...rollbackErrors.map(item => item.error)],
							"Durable profile ownership committed, runtime application failed, and session rollback was incomplete.",
						)
					: error;
			const committedError = new ModelProfileApplyCommittedError(
				prepared.profileName,
				committedDurableOwnership.version,
				cause,
			);
			prepared.session.markModelProfileOwnershipFailed?.(committedError);
			try {
				prepared.session.emitProfileOwnershipChanged?.({
					type: "profile_ownership_changed",
					transitionId: globalThis.crypto.randomUUID(),
					source: durableOwnershipVersionAdvanced ? "durable" : "recovery",
					oldMarker: prepared.previousModelProfileOwnershipMarker ?? { kind: "inherit" },
					newMarker: { kind: "inherit" },
					oldSessionId: prepared.session.sessionId,
					sessionId: prepared.session.sessionId,
					observedDurableVersion: durableOwnershipVersionAdvanced
						? prepared.previousDurableModelProfileOwnership.version
						: committedDurableOwnership.version,
					...(durableOwnershipVersionAdvanced
						? { committedDurableVersion: committedDurableOwnership.version }
						: {}),
					outcome: "failed",
				});
			} catch (eventError) {
				logger.warn("Failed to emit model-profile ownership failure diagnostic", {
					profile: prepared.profileName,
					error: eventError instanceof Error ? eventError.message : String(eventError),
				});
			}
			throw committedError;
		}
		if (rollbackErrors.length > 0) {
			throw incompleteModelProfileRollbackError("activation", activationStage, error, rollbackErrors);
		}
		throw error;
	}
	// The installed role layer decides whether this profile is vendor-separated,
	// so delegation must be re-applied to the live session rather than only to
	// sessions started after activation. Activation itself already succeeded; a
	// failed refresh must not roll it back.
	try {
		await prepared.session.syncEagerDelegation?.();
	} catch (error) {
		logger.warn("Failed to sync eager delegation after model profile activation", {
			profile: prepared.profileName,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function activateModelProfile(
	options: PrepareModelProfileActivationOptions,
	applyOptions: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	await applyPreparedModelProfileActivation(prepared, applyOptions);
}

/** Install only a profile's runtime role layer, preserving session model and configured-chain intent. */
export async function applyModelProfileRuntimeBindings(options: PrepareModelProfileActivationOptions): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	try {
		prepared.settings.override("modelRoles", {
			...prepared.baseModelRoles,
			...prepared.modelRoles,
		});
		prepared.settings.override("task.agentModelOverrides", {
			...prepared.baseAgentModelOverrides,
			...prepared.agentModelOverrides,
		});
		prepared.session.setActiveModelProfile?.(prepared.profileName);
		prepared.session.noteProfileInstalledOverrides?.(
			Object.keys(prepared.modelRoles),
			Object.keys(prepared.agentModelOverrides),
			prepared.previousModel,
		);
		try {
			await prepared.session.syncEagerDelegation?.();
		} catch (error) {
			logger.warn("Failed to sync eager delegation after recovered profile runtime bindings", {
				profile: prepared.profileName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	} finally {
		restoreCanonicalVariant(prepared.modelRegistry, prepared.session.sessionId, prepared.previousCanonicalVariant);
	}
}
