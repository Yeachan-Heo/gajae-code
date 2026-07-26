import * as crypto from "node:crypto";
import * as path from "node:path";
import type { RecoveryFsRoot } from "@gajae-code/natives";
import type {
	RecoveryHydrationContext,
	ResumeSessionIdentity,
	SessionDestinationInput,
	SessionManager,
	SessionManagerCheckpointRevisionStrings,
	StrictSessionOpenFailure,
} from "./session-manager";

export interface MemoryGuardTranscriptDescriptorV1 {
	bytes: string;
	relative_path: string;
	sha256: string;
}

export interface MemoryGuardCheckpointBlobAuthorityV1 {
	kind: "checkpoint_blob_tree_v1";
	manifest_relative_path: string;
	manifest_sha256: string;
	root_relative_path: string;
}

export interface MemoryGuardCheckpointBlobManifestEntryV1 {
	bytes: string;
	relative_path: string;
	sha256: string;
}

export interface MemoryGuardCheckpointBlobManifestV1 {
	entries: MemoryGuardCheckpointBlobManifestEntryV1[];
	schema_version: 1;
}

export interface MemoryGuardSessionManagerCheckpointV1 {
	blob_authority: MemoryGuardCheckpointBlobAuthorityV1;
	revisions: SessionManagerCheckpointRevisionStrings;
	schema_version: 1;
	session_id: string;
	session_name: string | null;
	transcript: MemoryGuardTranscriptDescriptorV1;
}

export interface MemoryGuardParticipantDescriptorV1 {
	ordinal: number;
	checkpoint: MemoryGuardCheckpointBlobAuthorityV1;
	revisions: SessionManagerCheckpointRevisionStrings;
	session_id: string;
	session_name: string | null;
	transcript: MemoryGuardTranscriptDescriptorV1;
}

export interface MemoryGuardParticipantIngressLease {
	readonly token: symbol;
	release(): void;
}

export interface MemoryGuardCreateCheckpointInput {
	ingressLease: MemoryGuardParticipantIngressLease;
	checkpointRoot: string;
}

export type MemoryGuardRestoreBlockedReason =
	| StrictSessionOpenFailure["reason"]
	| "checkpoint-mismatch"
	| "participant-mismatch"
	| "transcript-mismatch"
	| "blob-manifest-mismatch"
	| "blob-missing"
	| "blob-hash-mismatch"
	| "blob-authority-mismatch"
	| "destination-unavailable";

export interface MemoryGuardRestoreInput {
	incidentAuthority: RecoveryFsRoot;
	participant: MemoryGuardParticipantDescriptorV1;
	checkpoint: MemoryGuardSessionManagerCheckpointV1;
	destination: SessionDestinationInput;
}

export type MemoryGuardRestoreResult =
	| {
			kind: "staged";
			manager: SessionManager;
			hydrationContext: RecoveryHydrationContext;
			transcriptIdentity: ResumeSessionIdentity;
	  }
	| { kind: "blocked"; reason: MemoryGuardRestoreBlockedReason };

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortJson(child)]),
		);
	}
	return value;
}

export function memoryGuardCanonicalJson(value: unknown): string {
	return `${JSON.stringify(sortJson(value))}\n`;
}

export function memoryGuardSha256Hex(value: Uint8Array | string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function isMemoryGuardDecimalString(value: unknown): value is string {
	return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}

export function isMemoryGuardSha256Hex(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isMemoryGuardRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (path.isAbsolute(value) || value.includes("\\")) return false;
	const parts = value.split("/");
	return parts.every(part => part.length > 0 && part !== "." && part !== "..");
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}
