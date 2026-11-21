/** Why broker startup refused an existing `sdk/broker.lock`. */
export type BrokerLockRefusalCode = "host_unqualified" | "foreign_host" | "live_owner";

export const BROKER_LOCK_REFUSAL_CODES: readonly BrokerLockRefusalCode[] = [
	"host_unqualified",
	"foreign_host",
	"live_owner",
];

/**
 * Startup refusal of an existing `sdk/broker.lock`. The lock is never displaced
 * automatically in these cases, so the refusal is an operator condition rather
 * than a crash: entry points report it and exit non-zero.
 *
 * Kept separate from `broker.ts` so the exit-record and startup-failure modules
 * can name its codes without an import cycle through the broker.
 */
export class BrokerLockRefusedError extends Error {
	constructor(
		message: string,
		readonly lockPath: string,
		readonly code: BrokerLockRefusalCode,
		readonly ownerPid: number,
	) {
		super(message);
		this.name = "BrokerLockRefusedError";
	}
}

/**
 * API-safe message for a broker lock refusal, without exposing paths or stderr.
 * The message indicates whether the owner's liveness could be verified.
 */
export function brokerLockRefusalApiMessage(code: BrokerLockRefusalCode): string {
	switch (code) {
		case "live_owner":
			return "SDK broker startup refused existing lock, held by a live owner.";
		case "host_unqualified":
		case "foreign_host":
			return "SDK broker startup refused existing lock, held by an owner whose liveness cannot be verified.";
	}
}

/**
 * Normalizes broker startup or lock refusal errors to extract refusal info and cleanup uncertainty.
 * Returns the primary error (which might be BrokerLockRefusedError or BrokerStartupError with lockRefused),
 * the refusal code if available, and whether cleanup is unverified (AggregateError case).
 */
export function normalizeBrokerLockRefusalError(error: unknown): {
	primaryError: unknown;
	refusalCode?: BrokerLockRefusalCode;
	cleanupUnverified: boolean;
} {
	const cleanupUnverified = error instanceof AggregateError;
	const primary = cleanupUnverified ? error.errors[0] : error;

	if (primary instanceof BrokerLockRefusedError) {
		return {
			primaryError: primary,
			refusalCode: primary.code,
			cleanupUnverified,
		};
	}

	return {
		primaryError: primary,
		refusalCode: undefined,
		cleanupUnverified,
	};
}
