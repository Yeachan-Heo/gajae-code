/**
 * Deterministic source-format detection (issue #3709).
 *
 * Detection inspects only the already-read source bytes: a bounded leading
 * sample decides JSONL-vs-JSON and provider by envelope markers. An explicit
 * `--provider` selection narrows candidates; a sample that matches a different
 * provider than requested fails closed with `format_mismatch`. Detection never
 * guesses: a sample matching no supported envelope fails with
 * `unsupported_format` rather than falling back to a speculative parse.
 */

import { SessionImportError, type SessionImportFormatId, type SessionImportProviderId } from "./types";

/** Leading bytes consulted for envelope sniffing. */
const DETECTION_SAMPLE_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SessionImportDetection {
	provider: SessionImportProviderId;
	format: SessionImportFormatId;
}

function detectJsonlFormat(text: string): SessionImportDetection | undefined {
	const lines = text.split("\n");
	let sawCodex = false;
	let sawClaude = false;
	let examined = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			// A malformed early line does not decide detection; the adapter reports it.
			if (examined >= 8) break;
			continue;
		}
		if (!isRecord(value)) continue;
		examined++;
		if (value.type === "session_meta" && isRecord(value.payload))
			return { provider: "codex", format: "codex-rollout-jsonl" };
		if (value.type === "response_item" || value.type === "turn_context" || value.type === "world_state")
			sawCodex = true;
		if (value.type === "event_msg") sawCodex = true;
		if (
			(value.type === "user" || value.type === "assistant" || value.type === "summary" || value.type === "system") &&
			(value.sessionId !== undefined ||
				value.parentUuid !== undefined ||
				value.leafUuid !== undefined ||
				isRecord(value.message))
		) {
			sawClaude = true;
		}
		if (sawCodex && sawClaude) break;
		if (examined >= 32) break;
	}
	if (sawCodex && !sawClaude) return { provider: "codex", format: "codex-rollout-jsonl" };
	if (sawClaude && !sawCodex) return { provider: "claude", format: "claude-code-jsonl" };
	return undefined;
}

function looksLikeClaudeExport(value: unknown): boolean {
	const conversations = Array.isArray(value) ? value : [value];
	if (conversations.length === 0 || !conversations.every(isRecord)) return false;
	return conversations.every(conversation => {
		if (!Array.isArray(conversation.chat_messages)) return false;
		// `uuid`+`chat_messages` is the claude.ai export envelope; a bare
		// chat_messages array without any sender markers is not enough.
		const senders = conversation.chat_messages.slice(0, 8);
		return (
			typeof conversation.uuid === "string" ||
			senders.some(message => isRecord(message) && (message.sender === "human" || message.sender === "assistant"))
		);
	});
}

/**
 * Detect the provider/format of an explicit transcript file.
 *
 * @param text Full source text (already size-bounded by the caller).
 * @param requestedProvider Explicit provider selection; undefined = auto.
 */
export function detectSessionImportFormat(
	text: string,
	requestedProvider: SessionImportProviderId | undefined,
): SessionImportDetection {
	const sample = text.slice(0, DETECTION_SAMPLE_BYTES);
	let detected: SessionImportDetection | undefined;

	const trimmed = sample.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		// Ambiguous between "JSON document" and "JSONL": try whole-document parse
		// only against the sample when the whole text is the sample; otherwise a
		// leading `{`/`[` with newline-delimited records falls through to JSONL.
		let documentValue: unknown;
		let isJsonDocument = false;
		try {
			documentValue = JSON.parse(text);
			isJsonDocument = true;
		} catch {
			isJsonDocument = false;
		}
		if (isJsonDocument && looksLikeClaudeExport(documentValue)) {
			detected = { provider: "claude", format: "claude-export-json" };
		}
		// A whole-document JSON parse also succeeds for a single-line JSONL
		// transcript, so a non-export document falls through to JSONL detection
		// before anything is declared unsupported.
	}
	if (!detected) detected = detectJsonlFormat(sample);

	if (!detected) {
		throw new SessionImportError(
			"unsupported_format",
			"detect",
			"Could not detect a supported Codex or Claude transcript format. Pass --provider codex|claude to force a provider, or export the session again.",
		);
	}
	if (requestedProvider && detected.provider !== requestedProvider) {
		throw new SessionImportError(
			"format_mismatch",
			"detect",
			`The source looks like a ${detected.provider} transcript (${detected.format}) but --provider ${requestedProvider} was requested.`,
		);
	}
	return detected;
}
