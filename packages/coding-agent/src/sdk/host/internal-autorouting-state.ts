const inactiveAutoroutingState = new WeakMap<object, boolean>();

export function markAutoroutingInactive(target: object): void {
	inactiveAutoroutingState.set(target, true);
}

export function isAutoroutingInactive(target: unknown): boolean {
	return typeof target === "object" && target !== null && inactiveAutoroutingState.get(target) === true;
}
