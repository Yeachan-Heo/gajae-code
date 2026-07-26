export type ActiveProviderConnectionKind = "credential" | "credentialless";

export interface ActiveProviderDescriptor {
	provider: string;
	connectionKind: ActiveProviderConnectionKind;
}
function compareProviderIdsByUtf8(left: string, right: string): number {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	const length = Math.min(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		const difference = leftBytes[index]! - rightBytes[index]!;
		if (difference !== 0) return difference;
	}
	return leftBytes.length - rightBytes.length;
}

/**
 * Project active-provider inputs to the exact public DTO shape.
 *
 * Connection credentials take precedence when the same provider is reported
 * more than once. Provider IDs are sorted by their UTF-8 bytes without
 * normalization.
 */
export function projectActiveProviderDescriptors(
	descriptors: readonly { provider: string; connectionKind: unknown }[],
): ActiveProviderDescriptor[] {
	const active = new Map<string, ActiveProviderConnectionKind>();
	for (const descriptor of descriptors) {
		if (descriptor.connectionKind !== "credential" && descriptor.connectionKind !== "credentialless") {
			throw new Error("Invalid active provider connection kind.");
		}
		if (active.get(descriptor.provider) === "credential") continue;
		active.set(descriptor.provider, descriptor.connectionKind);
	}
	return [...active.entries()]
		.sort(([left], [right]) => compareProviderIdsByUtf8(left, right))
		.map(([provider, connectionKind]) => ({ provider, connectionKind }));
}

export const ACTIVE_PROVIDER_RESOLUTION_ERROR_CODE = "internal" as const;
export const ACTIVE_PROVIDER_RESOLUTION_ERROR_MESSAGE = "Unable to resolve active providers.";

export class ActiveProviderResolutionError extends Error {
	readonly code = ACTIVE_PROVIDER_RESOLUTION_ERROR_CODE;

	constructor() {
		super(ACTIVE_PROVIDER_RESOLUTION_ERROR_MESSAGE);
		this.name = "ActiveProviderResolutionError";
	}
}
