/**
 * Provider-neutral session import service (issue #3709).
 *
 * Pipeline: bounded read-only source load → format detection → provider adapter
 * → normalization + fail-closed redaction → head/tail bounding → persistence
 * into a NEW GJC session through the public SessionManager API.
 *
 * The source file is never written, moved, or enumerated. The live session is
 * never touched by this module; callers switch sessions explicitly after a
 * successful materialization.
 */

import { createHash } from "node:crypto";
import type * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { canContinuePersistedHistory } from "@gajae-code/agent-core";
import { type SessionDestinationInput, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { parseClaudeCodeTranscript, parseClaudeExport } from "./claude";
import { parseCodexRollout } from "./codex";
import { detectSessionImportFormat } from "./detect";
import { IMPORT_SANITIZER_VERSION } from "./redact";
import {
	type ImportedConversation,
	type ImportQuarantineRecord,
	type PreparedSessionImport,
	type SessionImportCompleted,
	type SessionImportCounts,
	SessionImportError,
	type SessionImportProvenance,
	type SessionImportProviderId,
} from "./types";

/** Bumped when normalization/rendering changes; persisted in provenance. */
export const IMPORT_CONVERTER_VERSION = 1;
/** Persisted custom-entry type carrying import provenance (never enters LLM context). */
export const SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE = "session-import";
/** Persisted custom-message type carrying the reconstructed continuation context. */
export const SESSION_IMPORT_CONTEXT_CUSTOM_TYPE = "session-import";

/** Hard source size limit; larger exports fail with `content_too_large`. */
export const SESSION_IMPORT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_MESSAGES = 5000;
const MAX_CONTEXT_CHARS = 120_000;
const HEAD_CONTEXT_CHARS = 20_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_TITLE_CHARS = 200;
const MAX_QUARANTINE_RECORDS = 512;

export interface SessionImportRequest {
	/** Explicit user-selected transcript/export file. */
	sourcePath: string;
	/** Explicit provider; omitted = deterministic auto-detection. */
	provider?: SessionImportProviderId;
	/** Import-owner workspace (recorded as the new session's cwd). */
	cwd: string;
	/** Session destination; defaults to the workspace's managed session store. */
	destination?: SessionDestinationInput;
	/** Test seam for deterministic provenance timestamps. */
	now?: () => Date;
}

interface ParsedSource {
	conversation: ImportedConversation;
	quarantine: { present: boolean; truncated: boolean };
	counts: SessionImportCounts;
	redactionKinds: string[];
}

/** Read the explicit source file with fixed bounds. The source is never written. */
async function readImportSource(sourcePath: string): Promise<{ text: string; bytes: number; sha256: string }> {
	const resolved = path.resolve(sourcePath);
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(resolved);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new SessionImportError("source_not_found", "read", `Transcript file does not exist: ${sourcePath}`);
		}
		throw new SessionImportError(
			"source_unreadable",
			"read",
			`Transcript file cannot be read (${code ?? "unknown error"}): ${sourcePath}`,
			{ retryable: true },
		);
	}
	if (!stat.isFile()) {
		throw new SessionImportError(
			"invalid_request",
			"read",
			`Import source must be a regular file, not a directory or special file: ${sourcePath}`,
		);
	}
	if (stat.size === 0) {
		throw new SessionImportError("malformed_input", "parse", `Transcript file is empty: ${sourcePath}`);
	}
	if (stat.size > SESSION_IMPORT_SOURCE_MAX_BYTES) {
		throw new SessionImportError(
			"content_too_large",
			"read",
			`Transcript is ${stat.size} bytes, exceeding the ${SESSION_IMPORT_SOURCE_MAX_BYTES}-byte import limit. Export a shorter session or trim the file.`,
			{ limitBytes: SESSION_IMPORT_SOURCE_MAX_BYTES, observedBytes: stat.size },
		);
	}
	let text: string;
	try {
		text = await fsp.readFile(resolved, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new SessionImportError(
			"source_unreadable",
			"read",
			`Transcript file cannot be read (${code ?? "unknown error"}): ${sourcePath}`,
			{ retryable: true },
		);
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > SESSION_IMPORT_SOURCE_MAX_BYTES) {
		throw new SessionImportError(
			"content_too_large",
			"read",
			`Transcript is ${bytes} bytes, exceeding the ${SESSION_IMPORT_SOURCE_MAX_BYTES}-byte import limit.`,
			{ limitBytes: SESSION_IMPORT_SOURCE_MAX_BYTES, observedBytes: bytes },
		);
	}
	let after: fs.Stats;
	try {
		after = await fsp.stat(resolved);
	} catch {
		throw new SessionImportError(
			"source_changed",
			"read",
			"The transcript file changed while it was being read. Re-export or retry with a stable file.",
			{ retryable: true },
		);
	}
	if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
		throw new SessionImportError(
			"source_changed",
			"read",
			"The transcript file changed while it was being read. Re-export or retry with a stable file.",
			{ retryable: true },
		);
	}
	return { text, bytes, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function parseDetectedFormat(detection: ReturnType<typeof detectSessionImportFormat>, text: string): ParsedSource {
	switch (detection.format) {
		case "codex-rollout-jsonl":
			return normalizeAdapterResult(parseCodexRollout(text));
		case "claude-code-jsonl":
			return normalizeAdapterResult(parseClaudeCodeTranscript(text));
		case "claude-export-json":
			return normalizeAdapterResult(parseClaudeExport(text));
	}
}

function normalizeAdapterResult(result: {
	conversation: ImportedConversation;
	quarantine: ImportQuarantineRecord[];
	counts: SessionImportCounts;
	redactionKinds: string[];
}): ParsedSource {
	return {
		conversation: result.conversation,
		quarantine: {
			present: result.quarantine.length > 0,
			truncated: result.quarantine.length > MAX_QUARANTINE_RECORDS,
		},
		counts: result.counts,
		redactionKinds: result.redactionKinds,
	};
}

function assertValidTimestamps(conversation: ImportedConversation): void {
	for (const message of conversation.messages) {
		if (message.timestamp === undefined) continue;
		if (!Number.isFinite(Date.parse(message.timestamp))) {
			throw new SessionImportError(
				"malformed_input",
				"normalize",
				"A message carries an unparseable timestamp; the transcript is not a clean export.",
			);
		}
	}
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 1)}…`;
}

/** Render the bounded continuation context document (head + tail with an elision marker). */
function renderImportContext(conversation: ImportedConversation): {
	text: string;
	omitted: number;
	truncated: boolean;
} {
	const titleLine = conversation.title ? ` titled "${truncateText(conversation.title, MAX_TITLE_CHARS)}"` : "";
	const lines: string[] = [
		`<imported-session provider="${conversation.provider}" format="${conversation.format}">`,
		"",
		`The conversation below was imported from an external ${conversation.provider === "codex" ? "Codex" : "Claude"} session transcript${titleLine}.`,
		"It is reconstructed context only: roles and text are preserved, but tool/internal provider state was not cloned, and secrets were redacted.",
		"Continue this conversation naturally as its current participant.",
		"",
	];
	if (conversation.cwd) lines.push(`Original workspace: ${conversation.cwd}`, "");

	const rendered: string[] = [];
	for (const message of conversation.messages) {
		const speaker = message.role === "user" ? "User" : "Assistant";
		const blocks: string[] = [];
		if (message.text) blocks.push(truncateText(message.text, MAX_MESSAGE_CHARS));
		if (message.toolEvidence && message.toolEvidence.length > 0) {
			blocks.push(["Tool/file evidence:", ...message.toolEvidence.map(line => `  ${line}`)].join("\n"));
		}
		if (blocks.length === 0) continue;
		rendered.push(`### ${speaker}\n\n${blocks.join("\n\n")}`);
	}

	let omitted = 0;
	let truncated = false;
	let body: string[];
	if (rendered.length === 0) {
		body = [];
	} else {
		const chars = rendered.reduce((total, part) => total + part.length + 2, 0);
		if (chars <= MAX_CONTEXT_CHARS) {
			body = rendered;
		} else {
			truncated = true;
			const head: string[] = [];
			let headChars = 0;
			while (head.length < rendered.length && headChars + rendered[head.length]!.length + 2 <= HEAD_CONTEXT_CHARS) {
				headChars += rendered[head.length]!.length + 2;
				head.push(rendered[head.length]!);
			}
			const tail: string[] = [];
			let tailChars = 0;
			for (let index = rendered.length - 1; index >= head.length; index--) {
				const part = rendered[index]!;
				if (tailChars + part.length + 2 > MAX_CONTEXT_CHARS - headChars) break;
				tailChars += part.length + 2;
				tail.unshift(part);
			}
			omitted = rendered.length - head.length - tail.length;
			body = [
				...head,
				`[… ${omitted} earlier message${omitted === 1 ? "" : "s"} from the imported ${conversation.provider} session were elided to bound context; the continuation tail is preserved below. …]`,
				...tail,
			];
		}
	}

	lines.push(...body);
	lines.push("", "</imported-session>");
	return { text: lines.join("\n"), omitted, truncated };
}

/**
 * Phase 1: read, detect, parse, normalize, redact, and bound. Performs no
 * session mutation; safe to run before any session transition.
 */
export async function prepareSessionImport(
	request: Pick<SessionImportRequest, "sourcePath" | "provider">,
): Promise<PreparedSessionImport> {
	if (typeof request.sourcePath !== "string" || request.sourcePath.trim().length === 0) {
		throw new SessionImportError(
			"invalid_request",
			"request",
			"A transcript file path is required: /import-session <file> [--provider codex|claude]",
		);
	}
	if (request.provider !== undefined && request.provider !== "codex" && request.provider !== "claude") {
		throw new SessionImportError(
			"invalid_request",
			"request",
			`Unsupported provider "${String(request.provider)}"; expected codex or claude.`,
		);
	}
	const source = await readImportSource(request.sourcePath);
	const detection = detectSessionImportFormat(source.text, request.provider);
	const parsed = parseDetectedFormat(detection, source.text);
	assertValidTimestamps(parsed.conversation);

	if (parsed.conversation.messages.length === 0) {
		throw new SessionImportError(
			"malformed_input",
			"parse",
			`No importable user/assistant messages were found in the ${detection.format} transcript.`,
		);
	}
	if (parsed.conversation.messages.length > MAX_SOURCE_MESSAGES) {
		throw new SessionImportError(
			"content_too_large",
			"normalize",
			`The transcript has ${parsed.conversation.messages.length} messages, exceeding the ${MAX_SOURCE_MESSAGES}-message import limit. Export a shorter session.`,
			{ limitBytes: MAX_SOURCE_MESSAGES, observedBytes: parsed.conversation.messages.length },
		);
	}

	const rendered = renderImportContext(parsed.conversation);
	const counts: SessionImportCounts = { ...parsed.counts, omitted: rendered.omitted };
	const provenance: PreparedSessionImport["provenance"] = {
		schemaVersion: 1,
		customType: SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE,
		provider: parsed.conversation.provider,
		format: parsed.conversation.format,
		sourceFileName: path.basename(path.resolve(request.sourcePath)),
		...(parsed.conversation.sourceSessionId ? { sourceSessionId: parsed.conversation.sourceSessionId } : {}),
		...(parsed.conversation.title ? { sourceTitle: truncateText(parsed.conversation.title, MAX_TITLE_CHARS) } : {}),
		sourceSha256: source.sha256,
		sourceBytes: source.bytes,
		converterVersion: IMPORT_CONVERTER_VERSION,
		sanitizerVersion: IMPORT_SANITIZER_VERSION,
		counts,
		truncated: rendered.truncated,
		quarantine: parsed.quarantine,
	};
	return {
		conversation: parsed.conversation,
		contextText: rendered.text,
		provenance,
		counts,
		redactionKinds: parsed.redactionKinds,
		sourcePath: path.resolve(request.sourcePath),
		sourceSha256: source.sha256,
		sourceBytes: source.bytes,
	};
}

/**
 * Phase 2: materialize a prepared import as a NEW GJC session file and verify
 * it reopens as a resumable session. The caller's live session is untouched.
 */
export async function materializeSessionImport(
	prepared: PreparedSessionImport,
	options: Pick<SessionImportRequest, "cwd" | "destination" | "now">,
): Promise<SessionImportCompleted> {
	if (typeof options.cwd !== "string" || options.cwd.length === 0) {
		throw new SessionImportError("invalid_request", "request", "A workspace cwd is required to host the import.");
	}
	const importedAt = (options.now?.() ?? new Date()).toISOString();
	const manager = SessionManager.create(options.cwd, options.destination);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		await manager.close().catch(() => {});
		throw new SessionImportError(
			"io_failed",
			"persist",
			"Session persistence is unavailable for this workspace; the import has nowhere to live.",
		);
	}
	const targetSessionId = manager.getSessionId();
	try {
		const provenance: SessionImportProvenance = {
			...prepared.provenance,
			targetSessionId,
			importedAt,
		};
		manager.appendCustomEntry(SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE, provenance);
		manager.appendCustomMessageEntry(
			SESSION_IMPORT_CONTEXT_CUSTOM_TYPE,
			prepared.contextText,
			true,
			{
				provider: prepared.conversation.provider,
				format: prepared.conversation.format,
				sourceSha256: prepared.sourceSha256,
				sourceBytes: prepared.sourceBytes,
				counts: prepared.counts,
				truncated: prepared.provenance.truncated,
				importedAt,
			},
			"agent",
		);
		const title =
			prepared.conversation.title ??
			`Imported ${prepared.conversation.provider === "codex" ? "Codex" : "Claude"} session ${(
				prepared.conversation.sourceSessionId ?? prepared.sourceSha256
			).slice(0, 8)}`;
		await manager.setSessionName(truncateText(title, MAX_TITLE_CHARS), "user");
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.close();

		// Verify the written file reopens cleanly and is continuable before the
		// caller switches to it; a failed verification discards the new file.
		const reopened = await SessionManager.open(sessionFile, options.destination);
		try {
			if (!canContinuePersistedHistory(reopened.buildSessionContext().messages)) {
				throw new SessionImportError(
					"malformed_input",
					"persist",
					"The imported session did not reconstruct a continuable conversation.",
				);
			}
		} finally {
			await reopened.close().catch(() => {});
		}
		return { targetSessionId, targetPath: sessionFile, title: truncateText(title, MAX_TITLE_CHARS), prepared };
	} catch (error) {
		await manager.close().catch(() => {});
		// The import manager is closed and its file was never handed to the
		// caller's session, so a storage-level exact delete cannot conflict with
		// a live writer. Best-effort: the failure diagnostic still wins.
		await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile).catch(() => {});
		if (error instanceof SessionImportError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SessionImportError("io_failed", "persist", `Failed to persist the imported session: ${message}`, {
			retryable: true,
		});
	}
}

/** Full import: prepare + materialize. Never switches the caller's session. */
export async function importExternalSession(request: SessionImportRequest): Promise<SessionImportCompleted> {
	const prepared = await prepareSessionImport(request);
	return materializeSessionImport(prepared, request);
}

/** Human-facing summary lines for a completed import. */
export function formatSessionImportSummary(result: SessionImportCompleted): string {
	const { prepared } = result;
	const providerLabel = prepared.conversation.provider === "codex" ? "Codex" : "Claude";
	const lines = [
		`Imported ${providerLabel} session (${prepared.conversation.format}) into a new GJC session.`,
		`Session: ${result.targetSessionId}`,
		`Title: ${result.title}`,
		`Messages: ${prepared.conversation.messages.length} reconstructed (${prepared.counts.mapped} records mapped, ${prepared.counts.quarantined} quarantined)`,
		`Source: ${prepared.provenance.sourceFileName} (${prepared.sourceBytes} bytes, sha256 ${prepared.sourceSha256.slice(0, 12)}…)`,
	];
	if (prepared.counts.omitted > 0) {
		lines.push(`Bounded: ${prepared.counts.omitted} earlier messages elided between the preserved head and tail.`);
	}
	if (prepared.counts.redacted > 0) {
		lines.push(
			`Redacted: ${prepared.counts.redacted} secret/credential value${prepared.counts.redacted === 1 ? "" : "s"} (${prepared.redactionKinds.join(", ")}).`,
		);
	}
	lines.push("The original transcript file was not modified.");
	return lines.join("\n");
}

/** Human-facing diagnostic for a failed import. */
export function formatSessionImportError(error: unknown): string {
	if (error instanceof SessionImportError) {
		const retry = error.retryable ? " (retryable)" : "";
		return `Import failed: ${error.code} [${error.phase}]${retry} — ${error.message}`;
	}
	return `Import failed: ${error instanceof Error ? error.message : String(error)}`;
}
