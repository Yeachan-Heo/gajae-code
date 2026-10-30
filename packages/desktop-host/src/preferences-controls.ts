import {
	projectModelProfileCatalog,
	resolveModelProfileName,
	validateModelProfileName,
} from "@gajae-code/coding-agent/config/model-profile-contract";
import {
	GJC_MODEL_ASSIGNMENT_TARGET_IDS,
	GJC_MODEL_ASSIGNMENT_TARGETS,
} from "@gajae-code/coding-agent/config/model-registry";
import { validateSettingPatch } from "@gajae-code/coding-agent/config/settings-schema";
import { getSettingsCatalog, type SettingCatalogItem } from "@gajae-code/coding-agent/sdk/settings-catalog";
import type { AgentSession, SessionAgentModelRole } from "@gajae-code/coding-agent/session/agent-session";
import type {
	DesktopModelProfile,
	DesktopModelRolePreference,
	DesktopPreferenceAction,
	DesktopPreferenceCapability,
	DesktopPreferenceResolution,
	DesktopPreferenceResult,
	DesktopPreferences,
	DesktopSamplingParameter,
	DesktopSamplingPreference,
} from "./preferences-protocol";

const SAMPLING_PARAMETERS: readonly DesktopSamplingParameter[] = [
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"repetitionPenalty",
];
const DEFAULT_PROFILE_UNAVAILABLE =
	"This session's captured settings do not provide writable durable configuration storage.";
const IMAGE_ROLE_GAP = "Image-role selection is not available in this picker.";
const TASK_ROLES: readonly SessionAgentModelRole[] = ["executor", "planner", "critic", "architect"];
const SAMPLING_GAP =
	"The public SDK does not expose per-model sampling capabilities and parameter validation; sampling writes are unavailable.";

export class DesktopPreferenceError extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "unsupported_preference"
			| "stale_preferences"
			| "preference_busy"
			| "preference_superseded",
		message: string,
	) {
		super(message);
		this.name = "DesktopPreferenceError";
	}
}

export interface DesktopPreferencesController {
	listProfiles(): DesktopModelProfile[];
	read(): DesktopPreferences;
	apply(action: unknown): Promise<DesktopPreferenceResult>;
	/** Recreate after a committed lifecycle/identity change; transient preparation does not retire this controller. */
	dispose(): void;
}

function unavailable(reason: string): DesktopPreferenceCapability {
	return { available: false, reason };
}

function resolution(item: SettingCatalogItem): DesktopPreferenceResolution {
	return { origin: item.resolution.origin, layers: [...item.resolution.layers] };
}

function exactKeys(action: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(action).length !== keys.length || keys.some(key => !Object.hasOwn(action, key))) {
		throw new DesktopPreferenceError("invalid_input", "Invalid preference action fields.");
	}
}

/** Validate the explicit wire union before any session/operator-intent mutation. */
function validateAction(value: unknown): DesktopPreferenceAction {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new DesktopPreferenceError("invalid_input", "Invalid preference action.");
	}
	const action = value as Record<string, unknown>;
	if (action.type === "profile.select") {
		exactKeys(action, ["type", "name", "scope"]);
		if (typeof action.name !== "string" || (action.scope !== "session" && action.scope !== "default")) {
			throw new DesktopPreferenceError("invalid_input", "Invalid profile selection.");
		}
		// Profile names are exact catalog identities; do not trim, pattern-restrict or preempt canonical unknown errors.
		return { type: action.type, name: action.name, scope: action.scope };
	}
	if (action.type === "sampling.set") {
		exactKeys(action, ["type", "parameter", "value", "scope"]);
		if (
			!SAMPLING_PARAMETERS.some(parameter => parameter === action.parameter) ||
			(action.scope !== "session" && action.scope !== "default")
		)
			throw new DesktopPreferenceError("invalid_input", "Invalid sampling action.");
		const parameter = action.parameter as DesktopSamplingParameter;
		if (validateSettingPatch({ [parameter]: action.value }).length > 0) {
			throw new DesktopPreferenceError("invalid_input", "Invalid sampling value.");
		}
		return { type: action.type, parameter, value: action.value as number, scope: action.scope };
	}
	if (action.type === "role.set") {
		exactKeys(action, ["type", "role", "modelId"]);
		if (
			!GJC_MODEL_ASSIGNMENT_TARGET_IDS.some(role => role === action.role) ||
			(action.modelId !== null && typeof action.modelId !== "string")
		) {
			throw new DesktopPreferenceError("invalid_input", "Invalid model role action.");
		}
		return { type: action.type, role: action.role as DesktopModelRolePreference["id"], modelId: action.modelId };
	}
	throw new DesktopPreferenceError("invalid_input", "Unknown preference action.");
}

/**
 * Capture the actual session's registry/settings, never process defaults, paths,
 * caller-supplied ownership claims or a reconstructed profile authority.
 * Profile activation and durable defaults use the session's canonical controls.
 * Task-role choices are owned by the live SDK session; sampling stays capability-refused.
 */
export function createDesktopPreferencesController(session: AgentSession): DesktopPreferencesController {
	const settings = session.settings;
	const registry = session.modelRegistry;
	const manager = session.sessionManager;
	const sessionId = session.sessionId;
	const sessionFile = session.sessionFile;
	const cwd = manager.getCwd();
	const lifecycleGeneration = session.sessionLifecycle.generation;
	let generation = 0;
	let disposed = false;
	let inFlight = false;
	const cleanups: Array<() => void> = [];
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		generation++;
		for (const cleanup of cleanups.splice(0)) cleanup();
	};
	const identityState = (): "current" | "transitioning" | "stale" => {
		if (disposed) return "stale";
		// One frozen SDK snapshot is authority. Notifications and cleanup hooks
		// merely prompt this observation; they do not prove a committed successor.
		const lifecycle = session.sessionLifecycle;
		if (
			lifecycle.disposed ||
			lifecycle.generation !== lifecycleGeneration ||
			session.settings !== settings ||
			session.modelRegistry !== registry ||
			session.sessionManager !== manager ||
			session.sessionId !== sessionId ||
			session.sessionFile !== sessionFile ||
			manager.getCwd() !== cwd
		) {
			dispose();
			return "stale";
		}
		return lifecycle.transitioning ? "transitioning" : "current";
	};
	const identityCurrent = (): boolean => identityState() === "current";
	const assertIdentity = (): void => {
		const state = identityState();
		if (state === "stale")
			throw new DesktopPreferenceError(
				"stale_preferences",
				"Session preferences identity changed; reopen preferences.",
			);
		if (state === "transitioning")
			throw new DesktopPreferenceError(
				"preference_busy",
				"Session preferences are temporarily unavailable during a session transition.",
			);
	};
	const observeIdentity = (): void => {
		identityState();
	};
	// A committed generation change permanently invalidates even A -> B -> A.
	// Unchanged-generation maintenance or cancelled preparation remains reusable.
	cleanups.push(session.subscribeSessionIdentityChanges(observeIdentity));
	cleanups.push(session.registerToolSessionTransitionCleanup(observeIdentity));
	cleanups.push(session.registerToolSessionCleanup(observeIdentity));

	const canPersistDefault = (): boolean => settings.canPersistDurableConfig() && settings.canWriteDurableConfig();

	const listProfiles = (): DesktopModelProfile[] => {
		assertIdentity();
		const profiles = registry.getModelProfiles();
		const catalog = projectModelProfileCatalog(profiles, registry.getError());
		const active = session.getActiveModelProfile();
		const configuredDefault = settings.getGlobal("modelProfile.default");
		const defaultName =
			configuredDefault === undefined ? undefined : resolveModelProfileName(configuredDefault, profiles);
		return catalog.map(item => ({
			id: item.id,
			name: item.displayName,
			description: null,
			source: item.source,
			active: item.id === active,
			default: item.id === defaultName,
			capabilities: {
				selectSession: { available: true, reason: null },
				persistDefault: canPersistDefault()
					? { available: true, reason: null }
					: unavailable(DEFAULT_PROFILE_UNAVAILABLE),
			},
		}));
	};

	const read = (): DesktopPreferences => {
		assertIdentity();
		const profiles = listProfiles();
		const catalog = new Map(getSettingsCatalog(settings).items.map(item => [item.path, item]));
		const roles: DesktopModelRolePreference[] = GJC_MODEL_ASSIGNMENT_TARGET_IDS.map(id => {
			const target = GJC_MODEL_ASSIGNMENT_TARGETS[id];
			const sessionOwned = id !== "default" && session.hasSessionAgentModelOverride(id);
			const configured = sessionOwned || settings.get(target.settingsPath)[id] !== undefined;
			const resolved =
				id === "default"
					? { model: session.model, thinkingLevel: session.thinkingLevel }
					: session.resolveRoleModelWithThinking(id);
			return {
				id,
				name: target.name,
				configured,
				model: resolved.model
					? { id: resolved.model.id, provider: resolved.model.provider, name: resolved.model.name }
					: null,
				thinkingLevel: resolved.thinkingLevel ?? null,
				configurationResolution: resolution(catalog.get(target.settingsPath)!),
				canApply:
					id === "image"
						? unavailable(IMAGE_ROLE_GAP)
						: id === "default" && !canPersistDefault()
							? unavailable(DEFAULT_PROFILE_UNAVAILABLE)
							: { available: true, reason: null },
				scope: id === "image" ? null : id === "default" ? "default" : "session",
				canClear: sessionOwned
					? { available: true, reason: null }
					: unavailable("No session-owned role choice is present."),
			};
		});
		const sampling: DesktopSamplingPreference[] = SAMPLING_PARAMETERS.map(parameter => {
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
		});
		return { profiles, roles, sampling };
	};

	const apply = async (input: unknown): Promise<DesktopPreferenceResult> => {
		assertIdentity();
		const action = validateAction(input);
		if (action.type === "sampling.set") throw new DesktopPreferenceError("unsupported_preference", SAMPLING_GAP);
		if (action.type === "role.set") {
			if (action.role === "image") throw new DesktopPreferenceError("unsupported_preference", IMAGE_ROLE_GAP);
			if (action.role === "default" && (action.modelId === null || !canPersistDefault()))
				throw new DesktopPreferenceError(
					"unsupported_preference",
					action.modelId === null ? "The default model cannot be cleared." : DEFAULT_PROFILE_UNAVAILABLE,
				);
			if (inFlight || session.isStreaming)
				throw new DesktopPreferenceError(
					"preference_busy",
					"A model or preferences operation is already in progress.",
				);
			inFlight = true;
			try {
				const model =
					action.modelId === null
						? null
						: (await session.getAvailableModels()).find(
								model => `${model.provider}/${model.id}` === action.modelId,
							);
				assertIdentity();
				if (model === undefined)
					throw new DesktopPreferenceError(
						"invalid_input",
						"The requested model is not available to this session.",
					);
				if (action.role === "default") {
					if (!model) throw new DesktopPreferenceError("invalid_input", "A default model is required.");
					await session.setDefaultModelSelection(model, undefined, { onBeforeMutation: assertIdentity });
				} else {
					if (!TASK_ROLES.some(role => role === action.role))
						throw new DesktopPreferenceError("invalid_input", "Invalid task model role.");
					await session.setSessionAgentModelSelection(action.role as SessionAgentModelRole, model);
				}
				assertIdentity();
				return {
					applied: "role.set",
					role: action.role,
					scope: action.role === "default" ? "default" : "session",
					durability: action.role === "default" ? "persisted" : "session",
					preferences: read(),
				};
			} finally {
				inFlight = false;
			}
		}
		const canonicalName = validateModelProfileName(action.name, registry.getModelProfiles(), registry.getError());
		if (action.scope === "default" && !canPersistDefault())
			throw new DesktopPreferenceError("unsupported_preference", DEFAULT_PROFILE_UNAVAILABLE);
		if (inFlight)
			throw new DesktopPreferenceError("preference_busy", "A preferences operation is already in progress.");
		inFlight = true;
		const operationGeneration = ++generation;
		// SDK controls synchronously reserve intent and own admission, predecessor
		// receipts, lifecycle fencing and ownership CAS. Never nest their admission
		// or mark the same operator request twice.
		const pending =
			action.scope === "default"
				? session.setDefaultModelProfileForControl(canonicalName, {
						persistDefault: true,
						onBeforeActivation: assertIdentity,
					})
				: session.activateModelProfileForControl(canonicalName);
		const revision = session.getUserModelSelectionRevision();
		const isCurrent = (): boolean =>
			identityCurrent() &&
			generation === operationGeneration &&
			session.getUserModelSelectionRevision() === revision;
		const assertCurrent = (): void => {
			assertIdentity();
			if (!isCurrent())
				throw new DesktopPreferenceError(
					"preference_superseded",
					"A newer model selection superseded this profile selection.",
				);
		};
		try {
			await pending;
			assertCurrent();
			if (session.getActiveModelProfile() !== canonicalName) {
				throw new DesktopPreferenceError(
					"preference_superseded",
					"Profile activation did not retain the requested selection.",
				);
			}
			return {
				applied: "profile.select",
				profileId: canonicalName,
				scope: action.scope,
				durability: action.scope === "default" ? "persisted" : "session",
				preferences: read(),
			};
		} catch (error) {
			// A committed-but-unapplied SDK result must retain its explicit durable
			// outcome; never disguise it as a cancellable local request.
			if (error && typeof error === "object" && "code" in error && error.code === "model_profile_apply_committed")
				throw error;
			assertCurrent();
			throw error;
		} finally {
			inFlight = false;
		}
	};
	return { listProfiles, read, apply, dispose };
}
