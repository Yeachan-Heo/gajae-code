import * as util from "node:util";
import type { SettingsAtomicPatch } from "./settings";

export type ModelProfileOwnershipMarker =
	| { kind: "inherit" }
	| { kind: "cleared" }
	| { kind: "profile"; profile: string };

export interface DurableModelProfileOwnership {
	schemaVersion: 1;
	version: number;
	marker: ModelProfileOwnershipMarker;
}

export interface ModelProfileOwnershipSettings {
	getGlobal(path: "modelProfile.ownership" | "modelProfile.default"): unknown;
}

export interface DurableModelProfileOwnershipCommit {
	ownership: DurableModelProfileOwnership;
	wrote: boolean;
}

export interface DurableModelProfileOwnershipStore extends ModelProfileOwnershipSettings {
	commitAtomicBatchWithCurrent(
		buildPatches: (
			current: Readonly<Record<string, unknown>>,
		) => Promise<readonly SettingsAtomicPatch[]> | readonly SettingsAtomicPatch[],
	): Promise<unknown>;
}

export const MODEL_PROFILE_OWNERSHIP_ENTRY = "model_profile_ownership";

export function validateModelProfileOwnershipMarker(value: unknown): ModelProfileOwnershipMarker | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const marker = value as Record<string, unknown>;
	if (marker.kind === "inherit" || marker.kind === "cleared") {
		return Object.keys(marker).length === 1 ? { kind: marker.kind } : undefined;
	}
	if (marker.kind === "profile" && typeof marker.profile === "string" && marker.profile.trim() !== "") {
		return Object.keys(marker).length === 2 ? { kind: "profile", profile: marker.profile } : undefined;
	}
	return undefined;
}

export function validateDurableModelProfileOwnership(value: unknown): DurableModelProfileOwnership | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const marker = validateModelProfileOwnershipMarker(record.marker);
	if (
		record.schemaVersion !== 1 ||
		!Number.isSafeInteger(record.version) ||
		(record.version as number) < 0 ||
		!marker ||
		Object.keys(record).some(key => !["schemaVersion", "version", "marker"].includes(key))
	) {
		return undefined;
	}
	return { schemaVersion: 1, version: record.version as number, marker };
}

function markersEqual(left: ModelProfileOwnershipMarker, right: ModelProfileOwnershipMarker): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind !== "profile" || (right.kind === "profile" && left.profile === right.profile);
}

function rawValueAtPath(raw: Readonly<Record<string, unknown>>, path: string): unknown {
	const dotted = raw[path];
	if (dotted !== undefined) return dotted;
	let current: unknown = raw;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function extraPatchesAlreadyApplied(
	current: Readonly<Record<string, unknown>>,
	patches: readonly SettingsAtomicPatch[],
): boolean {
	return patches.every(patch => {
		const actual = rawValueAtPath(current, patch.path);
		return patch.op === "unset" ? actual === undefined : util.isDeepStrictEqual(actual, patch.value);
	});
}

function assertLegacyDefaultMatchesOwnership(marker: ModelProfileOwnershipMarker, legacyProfile: unknown): void {
	const expected = marker.kind === "profile" ? marker.profile : undefined;
	if (legacyProfile !== expected) throw new InvalidModelProfileOwnershipError();
}

export class InvalidModelProfileOwnershipError extends Error {
	readonly code = "model_profile_ownership_invalid";

	constructor() {
		super("Persisted model-profile ownership state is invalid; refusing to infer an owner.");
		this.name = "InvalidModelProfileOwnershipError";
	}
}

export class UnresolvedModelProfileOwnershipError extends Error {
	readonly code = "model_profile_unresolved";

	constructor(readonly profileName: string) {
		super(
			`Model profile "${profileName}" is referenced by this session but no longer exists. Choose a replacement profile explicitly.`,
		);
		this.name = "UnresolvedModelProfileOwnershipError";
	}
}

export class ModelProfileReplacementRequiredError extends Error {
	readonly code = "model_profile_replacement_required";

	constructor(readonly profileName: string) {
		super(`Choose a replacement profile before deleting the active profile "${profileName}".`);
		this.name = "ModelProfileReplacementRequiredError";
	}
}

export class ModelProfileOwnershipConflictError extends Error {
	readonly code = "model_profile_ownership_conflict";

	constructor(
		readonly expectedVersion: number,
		readonly actualVersion: number,
		readonly actualMarker?: ModelProfileOwnershipMarker,
	) {
		super(
			`Model-profile ownership changed concurrently (expected version ${expectedVersion}, found ${actualVersion}).`,
		);
		this.name = "ModelProfileOwnershipConflictError";
	}
}

export class ModelProfileApplyCommittedError extends Error {
	readonly code = "model_profile_apply_committed";

	constructor(
		readonly profileName: string,
		readonly committedVersion: number,
		cause: unknown,
	) {
		super(
			`Model-profile ownership for "${profileName}" was durably committed at version ${committedVersion}, but could not be applied. The requesting session is fail-closed; the durable version was not compensated.`,
			{ cause },
		);
		this.name = "ModelProfileApplyCommittedError";
	}
}

export interface ProfileOwnershipChangedEvent {
	type: "profile_ownership_changed";
	transitionId: string;
	source: "session" | "durable" | "recovery";
	oldMarker: ModelProfileOwnershipMarker;
	newMarker: ModelProfileOwnershipMarker;
	oldSessionId: string;
	sessionId: string;
	observedDurableVersion: number;
	committedDurableVersion?: number;
	outcome: "committed" | "failed" | "reconciled";
}

export function readDurableModelProfileOwnership(
	settings: ModelProfileOwnershipSettings,
): DurableModelProfileOwnership {
	const configured = settings.getGlobal("modelProfile.ownership");
	if (configured !== undefined) {
		const validated = validateDurableModelProfileOwnership(configured);
		if (!validated) throw new InvalidModelProfileOwnershipError();
		assertLegacyDefaultMatchesOwnership(validated.marker, settings.getGlobal("modelProfile.default"));
		return validated;
	}
	const legacyProfile = settings.getGlobal("modelProfile.default");
	return {
		schemaVersion: 1,
		version: 0,
		marker:
			typeof legacyProfile === "string" && legacyProfile.trim() !== ""
				? { kind: "profile", profile: legacyProfile }
				: { kind: "inherit" },
	};
}

export function readDurableModelProfileOwnershipFromRaw(
	raw: Readonly<Record<string, unknown>>,
): DurableModelProfileOwnership {
	const nested = (path: string): unknown => {
		const dotted = raw[path];
		if (dotted !== undefined) return dotted;
		let current: unknown = raw;
		for (const segment of path.split(".")) {
			if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
			current = (current as Record<string, unknown>)[segment];
		}
		return current;
	};
	const configured = nested("modelProfile.ownership");
	if (configured !== undefined) {
		const validated = validateDurableModelProfileOwnership(configured);
		if (!validated) throw new InvalidModelProfileOwnershipError();
		assertLegacyDefaultMatchesOwnership(validated.marker, nested("modelProfile.default"));
		return validated;
	}
	const legacyProfile = nested("modelProfile.default");
	return {
		schemaVersion: 1,
		version: 0,
		marker:
			typeof legacyProfile === "string" && legacyProfile.trim() !== ""
				? { kind: "profile", profile: legacyProfile }
				: { kind: "inherit" },
	};
}

export function resolveEffectiveModelProfileMarker(
	sessionMarker: ModelProfileOwnershipMarker | undefined,
	durable: DurableModelProfileOwnership,
): ModelProfileOwnershipMarker {
	const session = sessionMarker ?? { kind: "inherit" as const };
	return session.kind === "inherit" ? durable.marker : session;
}

export function resolveOwnedModelProfileName(
	marker: ModelProfileOwnershipMarker,
	profiles: ReadonlyMap<string, unknown>,
): string | undefined {
	if (marker.kind !== "profile") return undefined;
	if (!profiles.has(marker.profile)) throw new UnresolvedModelProfileOwnershipError(marker.profile);
	return marker.profile;
}

export function nextDurableModelProfileOwnership(
	current: DurableModelProfileOwnership,
	marker: ModelProfileOwnershipMarker,
): DurableModelProfileOwnership {
	if (current.version === Number.MAX_SAFE_INTEGER)
		throw new RangeError("Model-profile ownership version is exhausted.");
	return { schemaVersion: 1, version: current.version + 1, marker };
}

export async function commitDurableModelProfileOwnershipWithResult(
	settings: DurableModelProfileOwnershipStore,
	marker: ModelProfileOwnershipMarker,
	extraPatches: readonly SettingsAtomicPatch[] = [],
	validateCurrent?: () => Promise<void> | void,
	observedOwnership?: DurableModelProfileOwnership,
): Promise<DurableModelProfileOwnershipCommit> {
	const expected = observedOwnership ?? readDurableModelProfileOwnership(settings);
	let result = expected;
	let wrote = false;
	await settings.commitAtomicBatchWithCurrent(async current => {
		const actual = readDurableModelProfileOwnershipFromRaw(current);
		if (actual.version !== expected.version || !markersEqual(actual.marker, expected.marker)) {
			throw new ModelProfileOwnershipConflictError(expected.version, actual.version, actual.marker);
		}
		await validateCurrent?.();
		if (
			actual.version > 0 &&
			markersEqual(actual.marker, marker) &&
			extraPatchesAlreadyApplied(current, extraPatches)
		) {
			result = actual;
			return [];
		}
		result = nextDurableModelProfileOwnership(actual, marker);
		wrote = true;
		return [
			{ path: "modelProfile.ownership", op: "set", value: result },
			marker.kind === "profile"
				? { path: "modelProfile.default", op: "set", value: marker.profile }
				: { path: "modelProfile.default", op: "unset" },
			...extraPatches,
		];
	});
	return { ownership: result, wrote };
}

export async function commitDurableModelProfileOwnership(
	settings: DurableModelProfileOwnershipStore,
	marker: ModelProfileOwnershipMarker,
	extraPatches: readonly SettingsAtomicPatch[] = [],
	validateCurrent?: () => Promise<void> | void,
	observedOwnership?: DurableModelProfileOwnership,
): Promise<DurableModelProfileOwnership> {
	return (
		await commitDurableModelProfileOwnershipWithResult(
			settings,
			marker,
			extraPatches,
			validateCurrent,
			observedOwnership,
		)
	).ownership;
}

export function modelProfileOwnershipMarkersEqual(
	left: ModelProfileOwnershipMarker | undefined,
	right: ModelProfileOwnershipMarker | undefined,
): boolean {
	return markersEqual(left ?? { kind: "inherit" }, right ?? { kind: "inherit" });
}
