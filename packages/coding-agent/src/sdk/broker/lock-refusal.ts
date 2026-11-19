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
