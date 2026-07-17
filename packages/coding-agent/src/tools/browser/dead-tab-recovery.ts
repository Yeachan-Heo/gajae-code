export type DeadTabRecoveryConsumeStatus = "consumed" | "expired_or_missing" | "owner_mismatch";

export interface DeadTabRecoveryConsumeResult<T> {
	status: DeadTabRecoveryConsumeStatus;
	descriptor?: T;
}

interface StoredDescriptor<T> {
	descriptor: T;
	ownerId: string | undefined;
	expiresAt: number;
}

interface DeadTabRecoveryDeps {
	now(): number;
	onPeek(): void;
}

const DEFAULT_TTL_MS = 30_000;
const descriptors = new Map<string, StoredDescriptor<unknown>>();
let deps: DeadTabRecoveryDeps = { now: () => Date.now(), onPeek: () => {} };

/** Store a short-lived immutable recovery descriptor for a dead tab worker. */
export function registerDeadTabRecovery<T extends object>(
	name: string,
	ownerId: string | undefined,
	descriptor: T,
	ttlMs = DEFAULT_TTL_MS,
): void {
	descriptors.set(name, { descriptor: Object.freeze(descriptor), ownerId, expiresAt: deps.now() + ttlMs });
}

/**
 * Check whether a recovery descriptor may be consumed by this owner. The test hook is
 * intentionally synchronous: recovery must not yield between this check and consume.
 */
export function peekDeadTabRecovery<T>(name: string, ownerId: string | undefined): DeadTabRecoveryConsumeResult<T> {
	const stored = descriptors.get(name);
	const result: DeadTabRecoveryConsumeResult<T> =
		!stored || stored.expiresAt <= deps.now()
			? { status: "expired_or_missing" }
			: stored.ownerId !== ownerId
				? { status: "owner_mismatch" }
				: { status: "consumed", descriptor: stored.descriptor as T };
	deps.onPeek();
	return result;
}

/** Consume only a live descriptor belonging to the expected owner. */
export function consumeDeadTabRecovery<T>(name: string, ownerId: string | undefined): DeadTabRecoveryConsumeResult<T> {
	const stored = descriptors.get(name);
	if (!stored || stored.expiresAt <= deps.now()) {
		if (stored) descriptors.delete(name);
		return { status: "expired_or_missing" };
	}
	if (stored.ownerId !== ownerId) return { status: "owner_mismatch" };
	descriptors.delete(name);
	return { status: "consumed", descriptor: stored.descriptor as T };
}

export function discardDeadTabRecovery(name: string): void {
	descriptors.delete(name);
}

/** Whether an unconsumed descriptor remains live at the supplied policy clock. */
export function isDeadTabRecoveryLive(name: string, now: number): boolean {
	const stored = descriptors.get(name);
	return stored !== undefined && stored.expiresAt > now;
}

export function __setDeadTabRecoveryDepsForTest(overrides: Partial<DeadTabRecoveryDeps>): void {
	deps = { ...deps, ...overrides };
}

export function __resetDeadTabRecoveryForTest(): void {
	descriptors.clear();
	deps = { now: () => Date.now(), onPeek: () => {} };
}
