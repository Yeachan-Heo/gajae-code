/**
 * Provider-neutral session-import contract (issue #3709).
 *
 * An import accepts ONE explicit user-selected Codex or Claude transcript/export
 * file, normalizes it into the intermediate representation below, and rebuilds a
 * bounded, redacted continuation context inside a NEW GJC session. The source
 * file is only ever read; provider process state is never scraped.
 */

/** Providers with a first-party observable transcript/export format. */
export type SessionImportProviderId = "codex" | "claude";

/** Concrete on-disk format variants the adapters understand. */
export type SessionImportFormatId = "codex-rollout-jsonl" | "claude-code-jsonl" | "claude-export-json";

/** One normalized conversational unit produced by a provider adapter. */
export interface ImportedMessage {
	/** Conversational role. Tool evidence is attached to assistant turns. */
	role: "user" | "assistant";
	/** Visible text (may be empty when only tool evidence exists). */
	text: string;
	/** ISO-8601 source timestamp when the record carried one. */
	timestamp?: string;
	/**
	 * Bounded, already redacted tool/file evidence lines (e.g. `$ ls` → `ok`).
	 * Rendered inline after the text so completed work stays visible.
	 */
	toolEvidence?: string[];
}

/** Provider-neutral normalized conversation. */
export interface ImportedConversation {
	provider: SessionImportProviderId;
	format: SessionImportFormatId;
	/** Source-side session/conversation identifier when the format carries one. */
	sourceSessionId?: string;
	/** Source title when the format carries one. */
	title?: string;
	/** Source workspace cwd when the format carries one. */
	cwd?: string;
	messages: ImportedMessage[];
}

/** Deterministic, actionable import failure codes. */
export type SessionImportErrorCode =
	| "invalid_request"
	| "source_not_found"
	| "source_unreadable"
	| "source_changed"
	| "unsupported_format"
	| "format_mismatch"
	| "malformed_input"
	| "content_too_large"
	| "destination_conflict"
	| "io_failed";

/** Import pipeline phase a failure belongs to. */
export type SessionImportPhase = "request" | "read" | "detect" | "parse" | "normalize" | "persist" | "switch";

export class SessionImportError extends Error {
	readonly code: SessionImportErrorCode;
	readonly phase: SessionImportPhase;
	readonly retryable: boolean;
	readonly limitBytes?: number;
	readonly observedBytes?: number;

	constructor(
		code: SessionImportErrorCode,
		phase: SessionImportPhase,
		message: string,
		options?: { retryable?: boolean; limitBytes?: number; observedBytes?: number },
	) {
		super(message);
		this.name = "SessionImportError";
		this.code = code;
		this.phase = phase;
		this.retryable = options?.retryable ?? false;
		this.limitBytes = options?.limitBytes;
		this.observedBytes = options?.observedBytes;
	}
}

/** One record the adapter could not map. Never carries raw content. */
export interface ImportQuarantineRecord {
	/** 1-based record/line number in the source. */
	record: number;
	byteLength: number;
	sha256: string;
	reason: "invalid_json" | "unknown_record" | "missing_fields" | "oversized_record";
}

/** Bounded tallies reported to the user and persisted in provenance. */
export interface SessionImportCounts {
	/** Records successfully mapped into the normalized conversation. */
	mapped: number;
	/** Records quarantined (never silently dropped). */
	quarantined: number;
	/** Secret/credential redactions applied to imported text. */
	redacted: number;
	/** Messages omitted from the rendered context by head/tail bounding. */
	omitted: number;
}

/** Provenance persisted as a `custom` session entry on the import target. */
export interface SessionImportProvenance {
	schemaVersion: 1;
	customType: "session-import";
	provider: SessionImportProviderId;
	format: SessionImportFormatId;
	/** Basename of the explicit user-selected source file (never a full path). */
	sourceFileName: string;
	sourceSessionId?: string;
	sourceTitle?: string;
	/** SHA-256 over the exact source bytes that were imported. */
	sourceSha256: string;
	sourceBytes: number;
	/** RFC 4122 UUID of the GJC session that received the import. */
	targetSessionId: string;
	importedAt: string;
	converterVersion: number;
	sanitizerVersion: number;
	counts: SessionImportCounts;
	/** True when head/tail bounding elided part of the conversation. */
	truncated: boolean;
	quarantine: { present: boolean; truncated: boolean };
}

/** Fully prepared import: parsed, normalized, redacted, bounded. No session state mutated yet. */
export interface PreparedSessionImport {
	conversation: ImportedConversation;
	/** Rendered continuation context for the `custom_message` entry. */
	contextText: string;
	provenance: Omit<SessionImportProvenance, "targetSessionId" | "importedAt">;
	counts: SessionImportCounts;
	/** Distinct redaction pattern ids that fired (for the user-facing summary). */
	redactionKinds: string[];
	sourcePath: string;
	sourceSha256: string;
	sourceBytes: number;
}

/** Result of a completed import into a freshly created session file. */
export interface SessionImportCompleted {
	targetSessionId: string;
	targetPath: string;
	title: string;
	prepared: PreparedSessionImport;
}
