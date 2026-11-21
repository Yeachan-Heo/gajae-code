import {
	type CreateAgentSessionResult,
	createSdkPreferenceControls,
	getSettingsCatalog,
	SdkPreferenceError,
	type SdkPreferenceOutcome,
	type SdkWriteConfigInput,
	type SdkWriteConfigResult,
	type SettingCatalogItem,
} from "@gajae-code/coding-agent/sdk";
import type {
	DesktopModelProfile,
	DesktopModelRoleId,
	DesktopModelRolePreference,
	DesktopPreferenceAction,
	DesktopPreferenceCapability,
	DesktopPreferenceOutcome,
	DesktopPreferenceResolution,
	DesktopPreferenceResult,
	DesktopPreferences,
	DesktopSamplingParameter,
} from "./preferences-protocol";

type Session = CreateAgentSessionResult["session"];
const ROLES: readonly DesktopModelRoleId[] = ["default", "executor", "architect", "planner", "critic", "image"];
const SAMPLING_PARAMETERS: readonly DesktopSamplingParameter[] = [
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"repetitionPenalty",
];
const STORAGE_GAP = "Durable preference storage is unavailable.";
const IMAGE_ROLE_GAP = "Image-role selection is not available in this picker.";
const SAMPLING_GAP =
	"The public SDK does not expose per-model sampling capabilities and parameter validation; sampling writes are unavailable.";

export class DesktopPreferenceError extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "unsupported_preference"
			| "stale_preferences"
			| "preference_busy"
			| "preference_superseded"
			| "preference_failed",
		message: string,
		readonly outcome?: SdkPreferenceOutcome,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "DesktopPreferenceError";
	}
}

export interface DesktopPreferencesController {
	listProfiles(): DesktopModelProfile[];
	read(): DesktopPreferences;
	apply(action: unknown): Promise<DesktopPreferenceResult>;
	/** Host-only scoped config seam; preserve SDK application/durability receipts verbatim. */
	writeConfig(input: SdkWriteConfigInput): Promise<SdkWriteConfigResult>;
	dispose(): void;
}

function unavailable(reason: string): DesktopPreferenceCapability {
	return { available: false, reason };
}

function resolution(item: SettingCatalogItem): DesktopPreferenceResolution {
	return { origin: item.resolution.origin, layers: [...item.resolution.layers] };
}

function exactKeys(action: Record<string, unknown>, keys: readonly string[]): void {
	if (Reflect.ownKeys(action).length !== keys.length || keys.some(key => !Object.hasOwn(action, key)))
		throw new DesktopPreferenceError("invalid_input", "Invalid preference action fields.");
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(action, key);
		if (!descriptor?.enumerable || !("value" in descriptor))
			throw new DesktopPreferenceError("invalid_input", "Invalid preference action fields.");
	}
}

function validateAction(value: unknown): DesktopPreferenceAction {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DesktopPreferenceError("invalid_input", "Invalid preference action.");
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new DesktopPreferenceError("invalid_input", "Invalid preference action.");
	const action = value as Record<string, unknown>;
	const descriptor = Object.getOwnPropertyDescriptor(action, "type");
	const type: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
	if (type === "profile.select") {
		exactKeys(action, ["type", "name", "scope"]);
		if (typeof action.name !== "string" || (action.scope !== "session" && action.scope !== "default"))
			throw new DesktopPreferenceError("invalid_input", "Invalid profile selection.");
		return { type, name: action.name, scope: action.scope };
	}
	if (type === "role.set") {
		exactKeys(action, ["type", "role", "modelId"]);
		if (!ROLES.some(role => role === action.role) || (action.modelId !== null && typeof action.modelId !== "string"))
			throw new DesktopPreferenceError("invalid_input", "Invalid model role action.");
		return { type, role: action.role as DesktopModelRoleId, modelId: action.modelId };
	}
	if (type === "sampling.set") {
		exactKeys(action, ["type", "parameter", "value", "scope"]);
		if (
			!SAMPLING_PARAMETERS.some(parameter => parameter === action.parameter) ||
			typeof action.value !== "number" ||
			!Number.isFinite(action.value) ||
			(action.scope !== "session" && action.scope !== "default")
		)
			throw new DesktopPreferenceError("invalid_input", "Invalid sampling action.");
		return {
			type,
			parameter: action.parameter as DesktopSamplingParameter,
			value: action.value,
			scope: action.scope,
		};
	}
	throw new DesktopPreferenceError("invalid_input", "Unknown preference action.");
}

/** Copy only native receipt primitives; application and durability are never inferred. */
export function projectPreferenceOutcome(outcome: SdkPreferenceOutcome): DesktopPreferenceOutcome {
	return {
		scope: outcome.scope,
		applied: outcome.applied,
		durability: outcome.durability,
		application: outcome.application,
		...(typeof outcome.committedVersion === "number" && Number.isFinite(outcome.committedVersion)
			? { committedVersion: outcome.committedVersion }
			: {}),
		...(outcome.recovery ? { recoveryRequired: true } : {}),
		...(outcome.failure?.code === "preference_failed" ? { failureCode: outcome.failure.code } : {}),
	};
}

/** Preserve uncertain/committed outcomes rather than claiming a successful desktop mutation. */
export function requireAppliedPreference(outcome: SdkPreferenceOutcome): "session" | "persisted" {
	if (!outcome.applied || outcome.durability === "unknown")
		throw new DesktopPreferenceError(
			"preference_failed",
			"The preference operation was not confirmed as applied.",
			structuredClone(outcome),
		);
	return outcome.durability;
}

/** Read factory-owned data; all mutations, admission and lifecycle fencing belong to SDK controls. */
export function createDesktopPreferencesController(session: Session): DesktopPreferencesController {
	const controls = createSdkPreferenceControls(session);
	const settings = session.settings;
	let disposed = false;
	const assertCurrent = (): void => {
		if (disposed) throw new DesktopPreferenceError("stale_preferences", "Session preferences have been closed.");
		// The SDK owns identity, transition and retirement checks, even for reads.
		controls.readRoles();
	};
	const canPersist = (): boolean => settings.canPersistDurableConfig() && settings.canWriteDurableConfig();
	const listProfiles = (): DesktopModelProfile[] => {
		assertCurrent();
		const active = session.getActiveModelProfile();
		const defaultName = settings.getGlobal("modelProfile.default");
		return controls.readProfiles().map(profile => {
			return {
				id: profile.id,
				name: profile.displayName,
				description: null,
				group: profile.providerGroup ?? null,
				groupRank: profile.providerGroupRank ?? null,
				available: profile.available,
				source: profile.source,
				active: profile.id === active,
				default: profile.id === defaultName,
				capabilities: {
					selectSession: { available: true, reason: null },
					persistDefault: canPersist() ? { available: true, reason: null } : unavailable(STORAGE_GAP),
				},
				roles: ROLES.map(role => ({
					id: role,
					model: profile.roles.find(item => item.role === role)?.model ?? null,
				})),
			};
		});
	};
	const read = (): DesktopPreferences => {
		assertCurrent();
		const rolePreferences = controls.readRoles();
		const catalog = new Map(getSettingsCatalog(settings).items.map(item => [item.path, item]));
		const roles: DesktopModelRolePreference[] = ROLES.map(id => {
			const task = rolePreferences.roles.find(role => role.role === id);
			const path = id === "default" || id === "image" ? "modelRoles" : "task.agentModelOverrides";
			const resolved =
				id === "default"
					? { model: session.model, thinkingLevel: session.thinkingLevel }
					: id === "image"
						? session.resolveRoleModelWithThinking(id)
						: undefined;
			return {
				id,
				name: id[0]!.toUpperCase() + id.slice(1),
				configured: task ? task.configured !== null : settings.get("modelRoles")[id] !== undefined,
				model: task?.effective
					? { id: task.effective.modelId, provider: task.effective.provider, name: task.effective.name }
					: resolved?.model
						? { id: resolved.model.id, provider: resolved.model.provider, name: resolved.model.name }
						: null,
				thinkingLevel: task?.effective?.thinkingLevel ?? resolved?.thinkingLevel ?? null,
				configurationResolution: task
					? { origin: task.configurationResolution.origin, layers: [...task.configurationResolution.layers] }
					: resolution(catalog.get(path)!),
				canApply:
					id === "image"
						? unavailable(IMAGE_ROLE_GAP)
						: id === "default" && !canPersist()
							? unavailable(STORAGE_GAP)
							: { available: true, reason: null },
				scope: id === "image" ? null : id === "default" ? "default" : "session",
				canClear: task?.canClear
					? { available: true, reason: null }
					: unavailable("No session-owned role choice is present."),
			};
		});
		return {
			profiles: listProfiles(),
			roles,
			sampling: SAMPLING_PARAMETERS.map(parameter => {
				const item = catalog.get(parameter)!;
				const value =
					item.effectiveValue.status === "available" && typeof item.effectiveValue.value === "number"
						? item.effectiveValue.value
						: null;
				return {
					parameter,
					configuredValue: value,
					effectiveValue: value !== null && value >= 0 ? value : null,
					mode: value === -1 ? "provider-default" : value !== null && value >= 0 ? "value" : "invalid",
					resolution: resolution(item),
					application: "next-run",
					modelSupport: "unknown",
					canApply: unavailable(SAMPLING_GAP),
				};
			}),
		};
	};
	return {
		listProfiles,
		read,
		async writeConfig(input) {
			assertCurrent();
			return controls.patchConfig(input);
		},
		dispose: () => {
			disposed = true;
			controls.dispose();
		},
		async apply(input) {
			let outcome: SdkPreferenceOutcome | undefined;
			try {
				assertCurrent();
				const action = validateAction(input);
				if (action.type === "sampling.set")
					throw new DesktopPreferenceError("unsupported_preference", SAMPLING_GAP);
				if (action.type === "profile.select") {
					const result = await controls.selectProfile({
						name: action.name,
						scope: action.scope === "default" ? "global" : "session",
					});
					outcome = result;
					return {
						applied: action.type,
						profileId: result.profileId,
						scope: action.scope,
						durability: requireAppliedPreference(result),
						preferences: read(),
						outcome: projectPreferenceOutcome(result),
					};
				}
				if (action.role === "image") throw new DesktopPreferenceError("unsupported_preference", IMAGE_ROLE_GAP);
				if (action.role === "default") {
					if (action.modelId === null)
						throw new DesktopPreferenceError("unsupported_preference", "The default model cannot be cleared.");
					const separator = action.modelId.indexOf("/");
					if (separator < 1 || separator === action.modelId.length - 1)
						throw new DesktopPreferenceError("invalid_input", "Invalid model identity.");
					const result = await controls.selectModel({
						provider: action.modelId.slice(0, separator),
						modelId: action.modelId.slice(separator + 1),
						scope: "global",
					});
					outcome = result;
					return {
						applied: action.type,
						role: action.role,
						scope: "default",
						durability: requireAppliedPreference(result),
						preferences: read(),
						outcome: projectPreferenceOutcome(result),
					};
				}
				const result = await controls.setRole({ role: action.role, modelId: action.modelId });
				outcome = result;
				return {
					applied: action.type,
					role: action.role,
					scope: "session",
					durability: requireAppliedPreference(result),
					preferences: read(),
					outcome: projectPreferenceOutcome(result),
				};
			} catch (error) {
				if (outcome?.applied && outcome.durability !== "unknown") {
					const stale =
						(error instanceof DesktopPreferenceError || error instanceof SdkPreferenceError) &&
						error.code === "stale_preferences";
					throw new DesktopPreferenceError(
						stale ? "stale_preferences" : "preference_failed",
						"The preference was applied, but current preferences could not be read. Refresh before retrying.",
						structuredClone(outcome),
						{ cause: error },
					);
				}
				if (error instanceof SdkPreferenceError) {
					const code =
						error.code === "persistence_unavailable"
							? "unsupported_preference"
							: error.code === "secret_field_forbidden"
								? "invalid_input"
								: error.code;
					throw new DesktopPreferenceError(code, error.message, undefined, { cause: error });
				}
				throw error;
			}
		},
	};
}
