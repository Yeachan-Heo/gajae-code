import type { OwnerMembership } from "../owner-group";

type NativeForkOwnerPublication = <T>(
	source: OwnerMembership,
	destination: OwnerMembership,
	publish: (assertOwners: () => void) => Promise<T>,
) => Promise<T>;

let publication: NativeForkOwnerPublication | undefined;

/** Bind the module-local authority implementation without exposing it through the session wildcard. */
export function bindNativeForkOwnerPublication(implementation: NativeForkOwnerPublication): void {
	if (publication) throw new Error("Native fork owner publication is already bound");
	publication = implementation;
}

export function withNativeForkSuccessorPublication<T>(
	source: OwnerMembership,
	destination: OwnerMembership,
	publish: (assertOwners: () => void) => Promise<T>,
): Promise<T> {
	if (!publication) throw new Error("Native fork owner publication is unavailable");
	return publication(source, destination, publish);
}
