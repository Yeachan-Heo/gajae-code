export type DoctorDaemonOwner = "telegram" | "discord" | "slack";

export interface DoctorDaemonIdentity {
	owner: DoctorDaemonOwner;
	ownerId: string;
	generation: number;
	incarnation: string;
}

export interface DoctorDaemonOccupancy {
	attached: number;
	inflight: number;
	inbound: number;
	outbound: number;
	cleanup: number;
}

const DOCTOR_DAEMON_OCCUPANCY_KEYS = ["attached", "inflight", "inbound", "outbound", "cleanup"] as const;

export interface DoctorDaemonStatus extends DoctorDaemonIdentity {
	requestId: string;
	phase: "idle" | "prepared" | "committed" | "cancelled" | "expired";
	admitting: boolean;
	occupancy: DoctorDaemonOccupancy;
	leaseExpiresAt: number;
}

export interface DoctorDaemonControlRequest extends DoctorDaemonIdentity {
	version: 1;
	requestId: string;
	action: "prepare" | "commit" | "cancel" | "status";
	createdAt: number;
	leaseExpiresAt?: number;
}

export function doctorDaemonOccupancyEmpty(): DoctorDaemonOccupancy {
	return { attached: 0, inflight: 0, inbound: 0, outbound: 0, cleanup: 0 };
}

/**
 * True only when every named occupancy category is an explicit, valid,
 * zero-valued integer. An empty object, a partial object, or an object with
 * extra/malformed keys is never vacuously "settled" — `Object.values({}).
 * every(...)` was previously `true` for `{}` because there is nothing to
 * iterate; this checks the exact required key set instead.
 */
export function doctorDaemonOccupancySettled(occupancy: DoctorDaemonOccupancy | undefined): boolean {
	if (!occupancy || typeof occupancy !== "object") return false;
	if (Object.keys(occupancy).length !== DOCTOR_DAEMON_OCCUPANCY_KEYS.length) return false;
	return DOCTOR_DAEMON_OCCUPANCY_KEYS.every(key => {
		const value = occupancy[key];
		return typeof value === "number" && Number.isSafeInteger(value) && value === 0;
	});
}

export function doctorDaemonIdentityMatches(
	left: DoctorDaemonIdentity | undefined,
	right: DoctorDaemonIdentity,
): boolean {
	return (
		left?.owner === right.owner &&
		left?.ownerId === right.ownerId &&
		left?.generation === right.generation &&
		left?.incarnation === right.incarnation
	);
}

export function isDoctorDaemonControlRequest(value: unknown): value is DoctorDaemonControlRequest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === 1 &&
		typeof candidate.requestId === "string" &&
		candidate.requestId.length > 0 &&
		(candidate.action === "prepare" ||
			candidate.action === "commit" ||
			candidate.action === "cancel" ||
			candidate.action === "status") &&
		(candidate.owner === "telegram" || candidate.owner === "discord" || candidate.owner === "slack") &&
		typeof candidate.ownerId === "string" &&
		candidate.ownerId.length > 0 &&
		typeof candidate.generation === "number" &&
		Number.isSafeInteger(candidate.generation) &&
		candidate.generation >= 0 &&
		typeof candidate.incarnation === "string" &&
		candidate.incarnation.length > 0 &&
		typeof candidate.createdAt === "number" &&
		Number.isFinite(candidate.createdAt) &&
		(candidate.leaseExpiresAt === undefined ||
			(typeof candidate.leaseExpiresAt === "number" && Number.isFinite(candidate.leaseExpiresAt)))
	);
}
