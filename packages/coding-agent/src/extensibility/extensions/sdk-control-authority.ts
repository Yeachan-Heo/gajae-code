declare const sdkControlAuthorityBrand: unique symbol;

/** Opaque authority required for app-server-only projection controls. It closes the documented extension route; it is not process isolation. */
export type SdkControlAuthority = symbol & {
	readonly [sdkControlAuthorityBrand]: true;
};

export type SdkControlHandler = (
	operation: string,
	input: Record<string, unknown>,
	authority?: SdkControlAuthority,
) => unknown | Promise<unknown>;

const authorities = new WeakMap<SdkControlHandler, SdkControlAuthority>();

/** Associates a runtime-owned sdkControl handler with its private authority token. */
export function registerSdkControlAuthority(handler: SdkControlHandler, authority: SdkControlAuthority): void {
	authorities.set(handler, authority);
}

/** Returns the authority for a runtime-owned sdkControl context function, if present. */
export function getSdkControlAuthority(handler: SdkControlHandler | undefined): SdkControlAuthority | undefined {
	return handler === undefined ? undefined : authorities.get(handler);
}
