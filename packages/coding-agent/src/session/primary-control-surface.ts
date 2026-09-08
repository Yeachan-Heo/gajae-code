export type PrimaryControlSurface = "cli" | "sdk";

const primaryControlSurfaceByOptions = new WeakMap<object, PrimaryControlSurface>();

/** @internal Trusted CLI bootstrap hook; ordinary SDK callers remain SDK-owned. */
export function setPrimaryControlSurface(options: object, surface: PrimaryControlSurface): void {
	primaryControlSurfaceByOptions.set(options, surface);
}

export function primaryControlSurfaceFor(options: object): PrimaryControlSurface {
	return primaryControlSurfaceByOptions.get(options) ?? "sdk";
}
