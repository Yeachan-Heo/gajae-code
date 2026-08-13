/**
 * Codex adapter (issue #3709).
 *
 * Parses the Codex CLI rollout transcript: one JSON object per line
 * (`rollout-*.jsonl`, e.g. `~/.codex/sessions/2026/08/01/rollout-….jsonl`).
 * This is Codex's own observable transcript format; the file the user passes is
 * treated as an explicit export and is only read.
 *
 * Strictness contract: records that fail to parse or lack required fields are
 * quarantined with deterministic digests — never silently dropped. Unknown
 * record/event types are mapped when their payload shape is recognized and
 * quarantined otherwise.
 */

import { createHash } from "node:crypto";
import { redactImportedText } from "./redact";
import type { ImportedConversation, ImportedMessage, ImportQuarantineRecord, SessionImportCounts } from "./types";

type JsonRecord = Record<string, unknown>;

export interface CodexParseResult {
	conversation: ImportedConversation;
	quarantine: ImportQuarantineRecord[];
	counts: SessionImportCounts;
	redactionKinds: string[];
}

const MAX_EVIDENCE_LINE_CHARS = 400;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContentBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		// Codex rollout uses output_text/input_text; accept plain text blocks too.
		if (
			typeof block.text === "string" &&
			(block.type === "output_text" || block.type === "input_text" || block.type === "text")
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function summarizeArguments(args: unknown): string {
	if (typeof args !== "string" || args.length === 0) return "";
	const trimmed = args.trim();
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (isRecord(parsed)) {
			const command = parsed.command;
			if (Array.isArray(command) && command.every(part => typeof part === "string")) {
				return command.join(" ");
			}
			if (typeof command === "string") return command;
			if (typeof parsed.cmd === "string") return parsed.cmd;
			if (typeof parsed.path === "string") return parsed.path;
			if (typeof parsed.file_path === "string") return parsed.file_path;
			if (typeof parsed.input === "string") return parsed.input;
			if (typeof parsed.query === "string") return parsed.query;
		}
	} catch {
		// Fall through to the bounded raw form.
	}
	return trimmed;
}

function boundEvidence(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_EVIDENCE_LINE_CHARS) return singleLine;
	return `${singleLine.slice(0, MAX_EVIDENCE_LINE_CHARS - 1)}…`;
}

class EvidenceCollector {
	readonly #lines: string[] = [];
	#bytes = 0;
	truncated = false;

	static readonly MAX_LINES = 100;
	static readonly MAX_BYTES = 8 * 1024;

	add(line: string): void {
		if (line.length === 0) return;
		if (
			this.#lines.length >= EvidenceCollector.MAX_LINES ||
			this.#bytes + line.length > EvidenceCollector.MAX_BYTES
		) {
			this.truncated = true;
			return;
		}
		this.#lines.push(line);
		this.#bytes += line.length;
	}

	get lines(): string[] {
		return this.#lines;
	}
}

/** Parse a Codex rollout JSONL transcript into the provider-neutral IR. */
export function parseCodexRollout(text: string): CodexParseResult {
	const messages: ImportedMessage[] = [];
	const quarantine: ImportQuarantineRecord[] = [];
	const counts: SessionImportCounts = { mapped: 0, quarantined: 0, redacted: 0, omitted: 0 };
	const redactionKinds = new Set<string>();
	const redact = (input: string): string => {
		const result = redactImportedText(input);
		counts.redacted += result.redacted;
		for (const kind of result.kinds) redactionKinds.add(kind);
		return result.value;
	};

	let sourceSessionId: string | undefined;
	let title: string | undefined;
	let cwd: string | undefined;
	let current: ImportedMessage | undefined;
	let evidence = new EvidenceCollector();

	const closeEvidence = (): void => {
		if (!current) {
			evidence = new EvidenceCollector();
			return;
		}
		if (evidence.lines.length > 0) {
			current.toolEvidence = [...(current.toolEvidence ?? []), ...evidence.lines];
		}
		evidence = new EvidenceCollector();
	};

	/** Assemble visible text into the running conversation. `mapped` is counted by the caller per recognized record. */
	const pushMessage = (role: "user" | "assistant", rawText: string, timestamp?: string): void => {
		const sanitized = redact(rawText).trim();
		if (role === "user") {
			closeEvidence();
			if (!sanitized) {
				current = undefined;
				return;
			}
			current = { role, text: sanitized, ...(timestamp ? { timestamp } : {}) };
			messages.push(current);
			return;
		}
		if (!sanitized) return;
		if (current?.role === "assistant") {
			current.text = current.text ? `${current.text}\n\n${sanitized}` : sanitized;
		} else {
			closeEvidence();
			current = { role, text: sanitized, ...(timestamp ? { timestamp } : {}) };
			messages.push(current);
		}
	};

	const quarantineRecord = (record: number, line: string, reason: ImportQuarantineRecord["reason"]): void => {
		quarantine.push({ record, byteLength: Buffer.byteLength(line, "utf8"), sha256: sha256Hex(line), reason });
		counts.quarantined++;
	};

	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trim();
		if (line.length === 0) continue;
		const recordNumber = index + 1;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			quarantineRecord(recordNumber, line, "invalid_json");
			continue;
		}
		if (!isRecord(record) || typeof record.type !== "string") {
			quarantineRecord(recordNumber, line, "invalid_json");
			continue;
		}
		const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;

		switch (record.type) {
			case "session_meta": {
				const payload = record.payload;
				if (!isRecord(payload)) {
					quarantineRecord(recordNumber, line, "missing_fields");
					break;
				}
				if (typeof payload.id === "string") sourceSessionId = payload.id;
				if (typeof payload.cwd === "string") cwd = payload.cwd;
				if (typeof payload.title === "string" && payload.title.trim().length > 0) {
					title = redact(payload.title).trim();
				}
				counts.mapped++;
				break;
			}
			case "response_item": {
				const payload = record.payload;
				if (!isRecord(payload) || typeof payload.type !== "string") {
					quarantineRecord(recordNumber, line, "missing_fields");
					break;
				}
				switch (payload.type) {
					case "message": {
						const role = payload.role;
						if (role !== "user" && role !== "assistant") {
							// developer/system prompts are provider framing, not conversation.
							counts.mapped++;
							break;
						}
						counts.mapped++;
						pushMessage(role, textFromContentBlocks(payload.content), timestamp);
						break;
					}
					case "reasoning": {
						// Model-internal reasoning is never imported (non-goal).
						counts.mapped++;
						break;
					}
					case "function_call": {
						const name = typeof payload.name === "string" ? payload.name : "tool";
						const summary = redact(boundEvidence(summarizeArguments(payload.arguments)));
						evidence.add(summary ? `$ ${name} ${summary}` : `$ ${name}`);
						counts.mapped++;
						break;
					}
					case "function_call_output":
					case "custom_tool_call_output": {
						const output = isRecord(payload.output)
							? JSON.stringify(payload.output)
							: typeof payload.output === "string"
								? payload.output
								: "";
						const summary = redact(boundEvidence(output));
						if (summary) evidence.add(`→ ${summary}`);
						counts.mapped++;
						break;
					}
					case "custom_tool_call": {
						const name = typeof payload.name === "string" ? payload.name : "tool";
						const input = typeof payload.input === "string" ? payload.input : "";
						const summary = redact(boundEvidence(input));
						evidence.add(summary ? `$ ${name} ${summary}` : `$ ${name}`);
						counts.mapped++;
						break;
					}
					case "local_shell_call": {
						const action = isRecord(payload.action) ? payload.action : undefined;
						const command = action && Array.isArray(action.command) ? action.command.join(" ") : "";
						const summary = redact(boundEvidence(command));
						evidence.add(summary ? `$ ${summary}` : "$ shell");
						counts.mapped++;
						break;
					}
					case "web_search_call": {
						evidence.add("[web search]");
						counts.mapped++;
						break;
					}
					default:
						quarantineRecord(recordNumber, line, "unknown_record");
				}
				break;
			}
			case "event_msg": {
				const payload = record.payload;
				if (!isRecord(payload) || typeof payload.type !== "string") {
					quarantineRecord(recordNumber, line, "missing_fields");
					break;
				}
				switch (payload.type) {
					case "user_message":
						counts.mapped++;
						pushMessage("user", typeof payload.message === "string" ? payload.message : "", timestamp);
						break;
					case "agent_message":
						counts.mapped++;
						pushMessage("assistant", typeof payload.message === "string" ? payload.message : "", timestamp);
						break;
					case "agent_reasoning":
					case "agent_reasoning_delta":
					case "agent_reasoning_raw_content":
					case "agent_reasoning_raw_content_delta":
					case "agent_reasoning_section_break":
					case "token_count":
						// Reasoning/token telemetry is model-internal or display-only.
						counts.mapped++;
						break;
					default:
						// Recognized event envelope, unmapped payload variant.
						quarantineRecord(recordNumber, line, "unknown_record");
				}
				break;
			}
			case "turn_context":
			case "world_state":
				// Provider environment framing; not conversation content.
				counts.mapped++;
				break;
			default:
				quarantineRecord(recordNumber, line, "unknown_record");
		}
	}
	closeEvidence();

	return {
		conversation: {
			provider: "codex",
			format: "codex-rollout-jsonl",
			...(sourceSessionId ? { sourceSessionId } : {}),
			...(title ? { title } : {}),
			...(cwd ? { cwd } : {}),
			messages,
		},
		quarantine,
		counts,
		redactionKinds: [...redactionKinds].sort(),
	};
}

function sha256Hex(text: string): string {
	// Deterministic per-record digest for quarantine evidence (content never stored).
	return createHash("sha256").update(text, "utf8").digest("hex");
}
