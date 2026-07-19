import type {
	FilesystemMemoryOutcomeCode,
	FilesystemMemoryRepositoryPolicyV1,
	FilesystemMemoryScope,
	FilesystemMemoryScopeAvailability,
	FilesystemMemoryUserPolicyV1,
} from "./contracts";

const ALL_SCOPES: readonly FilesystemMemoryScope[] = ["global", "project", "project-local", "session"];

function hasOnlyKnownScopes(scopes: readonly string[]): scopes is readonly FilesystemMemoryScope[] {
	return scopes.every(scope => ALL_SCOPES.includes(scope as FilesystemMemoryScope));
}

function hasValidScopes(value: unknown): value is readonly FilesystemMemoryScope[] {
	return Array.isArray(value) && value.every(scope => typeof scope === "string") && hasOnlyKnownScopes(value);
}

export function validateFilesystemMemoryUserPolicy(
	policy: FilesystemMemoryUserPolicyV1,
): FilesystemMemoryOutcomeCode | null {
	if (!policy || typeof policy !== "object" || policy.version !== 1 || !hasValidScopes(policy.allowedScopes))
		return "unknown_version";
	return null;
}

export function validateFilesystemMemoryRepositoryPolicy(
	policy: FilesystemMemoryRepositoryPolicyV1,
): FilesystemMemoryOutcomeCode | null {
	if (!policy || typeof policy !== "object" || policy.version !== 1) return "unknown_version";
	if (policy.allowedScopes !== undefined && !hasValidScopes(policy.allowedScopes)) return "unknown_version";
	return null;
}

/** Repository policy is a deny-only narrowing layer; it cannot grant a user-disabled scope. */
export function resolveFilesystemMemoryScopeAvailability(
	userPolicy: FilesystemMemoryUserPolicyV1,
	repositoryPolicy: FilesystemMemoryRepositoryPolicyV1 | null,
	initializedScopes: ReadonlySet<FilesystemMemoryScope>,
	identityScopes: ReadonlySet<FilesystemMemoryScope> = new Set(ALL_SCOPES),
): readonly FilesystemMemoryScopeAvailability[] {
	const userError = validateFilesystemMemoryUserPolicy(userPolicy);
	const repositoryError = repositoryPolicy ? validateFilesystemMemoryRepositoryPolicy(repositoryPolicy) : null;
	return ALL_SCOPES.map(scope => {
		if (userError || repositoryError) return { scope, available: false, reason: "unknown_version" };
		if (!userPolicy.allowedScopes.includes(scope)) return { scope, available: false, reason: "policy_denied" };
		if (repositoryPolicy?.allowedScopes && !repositoryPolicy.allowedScopes.includes(scope))
			return { scope, available: false, reason: "policy_denied" };
		if (!initializedScopes.has(scope)) return { scope, available: false, reason: "not_initialized" };
		if (!identityScopes.has(scope)) return { scope, available: false, reason: "identity_unavailable" };
		return { scope, available: true, reason: null };
	});
}

export function isFilesystemMemoryScopeAvailable(
	availability: readonly FilesystemMemoryScopeAvailability[],
	scope: FilesystemMemoryScope,
): boolean {
	return availability.some(entry => entry.scope === scope && entry.available);
}
