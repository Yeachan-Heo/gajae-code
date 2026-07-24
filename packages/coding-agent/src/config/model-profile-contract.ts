import { formatModelProfileDisplayLabel, type ModelProfileDefinition } from "./model-profiles";

export const MODEL_PROFILE_DISCOVERY_QUERY = "models.profiles.list";
export const MODEL_PROFILE_ERROR_DETAIL_MAX_BYTES = 2048;
const REQUESTED_PROFILE_MAX_BYTES = 256;

const LEGACY_MODEL_PROFILE_ALIASES: ReadonlyMap<string, string> = new Map([["codex-standard", "codex-medium"]]);

export interface ModelProfileCatalogItem {
	id: string;
	displayName: string;
	source: "builtin" | "configured";
}

export interface UnknownModelProfileDetails {
	requestedProfile: string;
	availableProfiles: string[];
	discoveryQuery: typeof MODEL_PROFILE_DISCOVERY_QUERY;
}

export interface ModelProfileRegistryErrorDetails {
	requestedProfile?: string;
	availableProfiles: [];
	discoveryQuery: typeof MODEL_PROFILE_DISCOVERY_QUERY;
}

export type ModelProfileErrorDetails = UnknownModelProfileDetails | ModelProfileRegistryErrorDetails;
export type ModelProfileErrorCode = "unknown_model_profile" | "model_profile_registry_error";

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	let end = value.length;
	while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end--;
	return value.slice(0, end);
}

function diagnosticProfileEcho(value: string): string {
	return truncateUtf8(value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]+/gu, " "), REQUESTED_PROFILE_MAX_BYTES);
}

function boundedAvailableProfiles(requestedProfile: string, profiles: ReadonlyMap<string, unknown>): string[] {
	const availableProfiles: string[] = [];
	for (const id of [...new Set(profiles.keys())].sort((left, right) => left.localeCompare(right))) {
		const candidate: UnknownModelProfileDetails = {
			requestedProfile,
			availableProfiles: [...availableProfiles, id],
			discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY,
		};
		if (Buffer.byteLength(JSON.stringify(candidate)) > MODEL_PROFILE_ERROR_DETAIL_MAX_BYTES) continue;
		availableProfiles.push(id);
	}
	return availableProfiles;
}

export class UnknownModelProfileError extends Error {
	readonly code = "unknown_model_profile" as const;
	readonly details: UnknownModelProfileDetails;

	constructor(requestedProfile: string, profiles: ReadonlyMap<string, unknown>) {
		const echoed = diagnosticProfileEcho(requestedProfile);
		const availableProfiles = boundedAvailableProfiles(echoed, profiles);
		const available = availableProfiles.length > 0 ? availableProfiles.join(", ") : "none";
		super(
			truncateUtf8(
				`Unknown model profile ${JSON.stringify(echoed)}. Available profiles: ${available}. Query ${MODEL_PROFILE_DISCOVERY_QUERY} for the complete catalog.`,
				512,
			),
		);
		this.name = "UnknownModelProfileError";
		this.details = {
			requestedProfile: echoed,
			availableProfiles,
			discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY,
		};
	}
}

export class ModelProfileRegistryError extends Error {
	readonly code = "model_profile_registry_error" as const;
	readonly details: ModelProfileRegistryErrorDetails;

	constructor(requestedProfile?: string) {
		super(
			`The model profile registry is unavailable. Query ${MODEL_PROFILE_DISCOVERY_QUERY} after fixing models.yml.`,
		);
		this.name = "ModelProfileRegistryError";
		const echoed = requestedProfile === undefined ? undefined : diagnosticProfileEcho(requestedProfile);
		this.details = {
			...(echoed ? { requestedProfile: echoed } : {}),
			availableProfiles: [],
			discoveryQuery: MODEL_PROFILE_DISCOVERY_QUERY,
		};
	}
}

export function resolveModelProfileName(profileName: string, profiles: ReadonlyMap<string, unknown>): string {
	if (profiles.has(profileName)) return profileName;
	const replacement = LEGACY_MODEL_PROFILE_ALIASES.get(profileName);
	return replacement && profiles.has(replacement) ? replacement : profileName;
}

export function validateModelProfileName(
	profileName: string,
	profiles: ReadonlyMap<string, unknown>,
	registryError?: unknown,
): string {
	if (registryError !== undefined) throw new ModelProfileRegistryError(profileName);
	const resolved = resolveModelProfileName(profileName, profiles);
	if (!profiles.has(resolved)) throw new UnknownModelProfileError(profileName, profiles);
	return resolved;
}

export function projectModelProfileCatalog(
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
	registryError?: unknown,
): ModelProfileCatalogItem[] {
	if (registryError !== undefined) throw new ModelProfileRegistryError();
	return [...profiles.entries()]
		.map(([id, definition]) => ({
			id,
			displayName: formatModelProfileDisplayLabel(definition),
			source: definition.source === "user" ? ("configured" as const) : ("builtin" as const),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function isModelProfileError(value: unknown): value is {
	code: ModelProfileErrorCode;
	message: string;
	details: ModelProfileErrorDetails;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const error = value as Record<string, unknown>;
	if (
		(error.code !== "unknown_model_profile" && error.code !== "model_profile_registry_error") ||
		typeof error.message !== "string" ||
		!error.details ||
		typeof error.details !== "object" ||
		Array.isArray(error.details)
	)
		return false;
	const details = error.details as Record<string, unknown>;
	const detailKeys = Object.keys(details);
	if (
		!detailKeys.every(key => key === "requestedProfile" || key === "availableProfiles" || key === "discoveryQuery") ||
		details.discoveryQuery !== MODEL_PROFILE_DISCOVERY_QUERY ||
		!Array.isArray(details.availableProfiles) ||
		!details.availableProfiles.every(id => typeof id === "string") ||
		Buffer.byteLength(JSON.stringify(details)) > MODEL_PROFILE_ERROR_DETAIL_MAX_BYTES ||
		(typeof details.requestedProfile === "string" &&
			Buffer.byteLength(details.requestedProfile) > REQUESTED_PROFILE_MAX_BYTES)
	)
		return false;
	if (error.code === "unknown_model_profile")
		return detailKeys.length === 3 && typeof details.requestedProfile === "string";
	return (
		detailKeys.length === (details.requestedProfile === undefined ? 2 : 3) &&
		details.availableProfiles.length === 0 &&
		(details.requestedProfile === undefined || typeof details.requestedProfile === "string")
	);
}
