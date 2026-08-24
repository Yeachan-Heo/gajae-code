export type NativePublishMutationState = "not_committed" | "committed" | "unknown";
export type NativePublishDurabilityState = "not_attempted" | "proven" | "not_provable";
export type NativePublishReason =
	| "none"
	| "destination_exists"
	| "atomic_unavailable"
	| "cross_device"
	| "permission_denied"
	| "io_failure"
	| "interrupted"
	| "invalid_request"
	| "identity_violation"
	| "durability_not_provable"
	| "unknown";
export type NativePublishOperation = "direct_rename" | "retained_file" | "retained_tree" | "retained_replace";

export type NativePublishPrimitive =
	| "renameat2_noreplace"
	| "linkat_noreplace"
	| "mkdirat_renameat_noreplace"
	| "renameat2_exchange"
	| "linkat_exchange"
	| "renameatx_np_excl"
	| "windows_rename_noreplace"
	| "unsupported"
	| "unknown";
export type NativePublishPhase =
	| "preflight"
	| "file_sync"
	| "rename"
	| "source_unlink"
	| "source_parent_sync"
	| "destination_parent_sync"
	| "terminal_identity"
	| "complete"
	| "unknown";

type SyncFailure = {
	phase: Exclude<NativePublishPhase, "preflight" | "file_sync" | "rename" | "complete" | "unknown">;
	parentRole: "source" | "destination" | "shared" | "staged_file";
	osCode?: number;
	kind: "unsupported" | "io" | "permission" | "other";
};

type PublishDiagnostic = {
	schemaVersion: 1;
	collectionState: "complete" | "partial" | "unavailable";
	osCode?: number;
	syncFailures?: readonly SyncFailure[];
};

export type NativePublishIdentity = {
	readonly dev: string;
	readonly ino: string;
	readonly size: string;
	readonly nlink?: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
	readonly sha256?: string;
};

export type NativePublishOutcome = {
	readonly ok: boolean;
	readonly code?: string;
	readonly identity?: NativePublishIdentity;
	readonly mutationState: NativePublishMutationState;
	readonly durabilityState: NativePublishDurabilityState;
	readonly reason: NativePublishReason;
	readonly primitive: NativePublishPrimitive;
	readonly phase: NativePublishPhase;
	readonly diagnostic: PublishDiagnostic;
};

const mutationStates = new Set<NativePublishMutationState>(["not_committed", "committed", "unknown"]);
const durabilityStates = new Set<NativePublishDurabilityState>(["not_attempted", "proven", "not_provable"]);
const reasons = new Set<NativePublishReason>([
	"none",
	"destination_exists",
	"atomic_unavailable",
	"cross_device",
	"permission_denied",
	"io_failure",
	"interrupted",
	"invalid_request",
	"identity_violation",
	"durability_not_provable",
	"unknown",
]);
const primitives = new Set<NativePublishPrimitive>([
	"renameat2_noreplace",
	"linkat_noreplace",
	"mkdirat_renameat_noreplace",
	"renameat2_exchange",
	"linkat_exchange",
	"renameatx_np_excl",
	"windows_rename_noreplace",
	"unsupported",
	"unknown",
]);
const phases = new Set<NativePublishPhase>([
	"preflight",
	"file_sync",
	"rename",
	"source_unlink",
	"source_parent_sync",
	"destination_parent_sync",
	"terminal_identity",
	"complete",
	"unknown",
]);
const preMutationReasons = new Set<NativePublishReason>([
	"destination_exists",
	"atomic_unavailable",
	"cross_device",
	"permission_denied",
	"io_failure",
	"interrupted",
	"invalid_request",
	"durability_not_provable",
	"identity_violation",
]);
const int32 = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const ownPlainRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).every(key => keys.includes(key));

const malformed: NativePublishOutcome = Object.freeze({
	ok: false,
	mutationState: "unknown",
	durabilityState: "not_provable",
	reason: "unknown",
	primitive: "unknown",
	phase: "unknown",
	diagnostic: Object.freeze({ schemaVersion: 1, collectionState: "unavailable" }),
});

function validIdentity(value: unknown): boolean {
	if (value === undefined) return true;
	if (!ownPlainRecord(value) || !exactKeys(value, ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs", "sha256"]))
		return false;
	const decimal = (field: unknown) => typeof field === "string" && /^-?[0-9]{1,32}$/.test(field);
	return (
		decimal(value.dev) &&
		decimal(value.ino) &&
		(value.nlink === undefined || decimal(value.nlink)) &&
		decimal(value.size) &&
		decimal(value.mtimeNs) &&
		decimal(value.ctimeNs) &&
		(value.sha256 === undefined || (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)))
	);
}

function validDiagnostic(value: unknown): value is PublishDiagnostic {
	if (!ownPlainRecord(value) || !exactKeys(value, ["schemaVersion", "collectionState", "osCode", "syncFailures"]))
		return false;
	if (value.schemaVersion !== 1 || !["complete", "partial", "unavailable"].includes(value.collectionState as string))
		return false;
	if (value.osCode !== undefined && !int32(value.osCode)) return false;
	if (value.syncFailures === undefined) return true;
	if (!Array.isArray(value.syncFailures) || value.syncFailures.length > 4) return false;
	return value.syncFailures.every(failure => {
		if (!ownPlainRecord(failure) || !exactKeys(failure, ["phase", "parentRole", "osCode", "kind"])) return false;
		const phase = failure.phase;
		const role = failure.parentRole;
		const compatibleRole =
			(phase === "source_parent_sync" && ["source", "shared"].includes(role as string)) ||
			(phase === "destination_parent_sync" && role === "destination") ||
			(phase === "terminal_identity" && ["source", "destination", "shared", "staged_file"].includes(role as string));
		return (
			["source_parent_sync", "destination_parent_sync", "terminal_identity"].includes(phase as string) &&
			compatibleRole &&
			(failure.osCode === undefined || int32(failure.osCode)) &&
			["unsupported", "io", "permission", "other"].includes(failure.kind as string)
		);
	});
}

function legalOutcome(outcome: NativePublishOutcome): boolean {
	if (outcome.mutationState === "not_committed")
		return (
			!outcome.ok &&
			outcome.durabilityState === "not_attempted" &&
			preMutationReasons.has(outcome.reason) &&
			((outcome.phase === "rename" &&
				[
					"destination_exists",
					"atomic_unavailable",
					"cross_device",
					"permission_denied",
					"io_failure",
					"interrupted",
				].includes(outcome.reason)) ||
				(outcome.phase === "preflight" &&
					!["atomic_unavailable", "cross_device", "interrupted"].includes(outcome.reason)) ||
				(outcome.phase === "file_sync" && outcome.reason === "io_failure"))
		);
	if (outcome.mutationState === "unknown")
		return (
			!outcome.ok &&
			outcome.durabilityState === "not_provable" &&
			outcome.reason === "unknown" &&
			["rename", "terminal_identity"].includes(outcome.phase)
		);
	if (outcome.ok)
		return (
			outcome.reason === "none" &&
			outcome.phase === "complete" &&
			["proven", "not_attempted"].includes(outcome.durabilityState)
		);
	return (
		!outcome.ok &&
		outcome.durabilityState === "not_provable" &&
		((outcome.reason === "durability_not_provable" &&
			["file_sync", "source_parent_sync", "destination_parent_sync"].includes(outcome.phase)) ||
			(outcome.reason === "identity_violation" && outcome.phase === "terminal_identity") ||
			(outcome.reason === "io_failure" && ["source_unlink", "terminal_identity"].includes(outcome.phase)))
	);
}

/**
 * Treat incompatible native results as an unknown mutation; never infer safety from legacy fields.
 * Retained descriptor operations have a stricter contract than direct rename: a reported success
 * includes the terminal identity and all required durability evidence.
 */
export function classifyNativePublishOutcome(
	value: unknown,
	operation: NativePublishOperation = "direct_rename",
): NativePublishOutcome {
	if (
		!ownPlainRecord(value) ||
		!exactKeys(value, [
			"ok",
			"code",
			"identity",
			"mutationState",
			"durabilityState",
			"reason",
			"primitive",
			"phase",
			"diagnostic",
		])
	)
		return malformed;
	if (
		typeof value.ok !== "boolean" ||
		(value.code !== undefined && (typeof value.code !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.code))) ||
		!mutationStates.has(value.mutationState as NativePublishMutationState) ||
		!durabilityStates.has(value.durabilityState as NativePublishDurabilityState) ||
		!reasons.has(value.reason as NativePublishReason) ||
		!primitives.has(value.primitive as NativePublishPrimitive) ||
		!phases.has(value.phase as NativePublishPhase) ||
		!validIdentity(value.identity) ||
		!validDiagnostic(value.diagnostic)
	)
		return malformed;
	const outcome = value as unknown as NativePublishOutcome;
	if (!legalOutcome(outcome)) return malformed;
	if (operation === "direct_rename") return outcome;
	const retainedPrimitiveValid =
		operation === "retained_file"
			? outcome.primitive === "renameat2_noreplace" || outcome.primitive === "linkat_noreplace"
		: operation === "retained_tree"
			? outcome.primitive === "renameat2_noreplace" || outcome.primitive === "mkdirat_renameat_noreplace"
			: outcome.primitive === "renameat2_exchange" || outcome.primitive === "linkat_exchange";
	if (
		!retainedPrimitiveValid ||
		(outcome.ok && (!outcome.identity || outcome.durabilityState !== "proven" || outcome.phase !== "complete"))
	)
		return malformed;
	return outcome;
}

/** Only a fully validated pre-mutation result permits exact cleanup of current staging. */
export function mayCleanCurrentStaging(outcome: NativePublishOutcome): boolean {
	return outcome.mutationState === "not_committed" && outcome.durabilityState === "not_attempted";
}

/** Stable, bounded text for startup errors. Native paths and messages are intentionally excluded. */
export function formatNativePublishDiagnostic(outcome: NativePublishOutcome): string {
	const osCode = outcome.diagnostic.osCode === undefined ? "" : ` os=${outcome.diagnostic.osCode}`;
	const failures = outcome.diagnostic.syncFailures
		?.map(
			failure =>
				`${failure.parentRole}:${failure.phase}:${failure.kind}${failure.osCode === undefined ? "" : `:${failure.osCode}`}`,
		)
		.join(",");
	return `${outcome.reason} primitive=${outcome.primitive} phase=${outcome.phase}${osCode}${failures ? ` sync=${failures}` : ""}`;
}
