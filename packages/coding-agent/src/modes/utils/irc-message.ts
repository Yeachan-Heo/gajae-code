import * as crypto from "node:crypto";
import type { AgentMessage } from "@gajae-code/agent-core";
import { getSegmenter } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { associateSessionMessageObservationId, getSessionMessageObservationId } from "../../session/session-manager";

const graphemeSegmenter = getSegmenter();
const IRC_IDENTITY_SOURCE_MAX_UTF8_BYTES = 4 * 1_024;
const IRC_IDENTITY_DISPLAY_MAX_UTF8_BYTES = 256;
export type IrcMessageKind = "incoming" | "autoreply" | "relay";

export type ParsedIrcMessage = {
	observationId: string;
	from: string;
	to: string;
	text: string;
	timestamp: number;
	kind: IrcMessageKind;
};

export interface IrcMessageBlock {
	readonly sender: string;
	readonly recipient: string;
	readonly kind: "incoming" | "autoreply" | "outgoing";
	readonly time: string;
	readonly bodyLines: readonly string[];
}

export function projectIrcText(
	text: string,
	maxUtf8Bytes: number,
): { text: string; truncated: boolean; utf8Bytes: number } {
	let end = 0;
	let utf8Bytes = 0;
	for (const part of graphemeSegmenter.segment(text)) {
		const segmentBytes = Buffer.byteLength(part.segment, "utf8");
		if (utf8Bytes + segmentBytes > maxUtf8Bytes) break;
		utf8Bytes += segmentBytes;
		end = part.index + part.segment.length;
	}
	return { text: text.slice(0, end), truncated: end < text.length, utf8Bytes };
}

/** Normalizes and bounds untrusted IRC identity fields without splitting visible graphemes. */
export function normalizeIrcIdentity(identity: string): string {
	const source = projectIrcText(identity, IRC_IDENTITY_SOURCE_MAX_UTF8_BYTES);
	const sanitized = sanitizeText(source.text.replace(/[\r\n\t\u2028\u2029]+/g, " ")).replace(
		/[\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/g,
		"",
	);
	const display = projectIrcText(sanitized, IRC_IDENTITY_DISPLAY_MAX_UTF8_BYTES);
	return source.truncated || display.truncated ? `${display.text}…` : display.text;
}

/** Formats IRC observations into display-neutral semantic blocks for both IRC surfaces. */
export function formatIrcMessageBlock(message: ParsedIrcMessage & { timestamp: number }): IrcMessageBlock {
	const date = new Date(message.timestamp);
	// IRC timestamps are human-facing, so use local time rather than UTC serialization.
	const time = Number.isFinite(date.getTime())
		? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
		: "--:--";
	const bodyLines = message.text === "" ? [] : message.text.replaceAll("\t", "    ").split("\n");
	return {
		sender: normalizeIrcIdentity(message.from),
		recipient: normalizeIrcIdentity(message.to),
		kind: message.kind === "relay" ? "outgoing" : message.kind,
		time,
		bodyLines,
	};
}

type IrcCustomMessage = Extract<AgentMessage, { role: "custom" }>;

export function isIrcCustomType(customType: string | undefined): customType is `irc:${IrcMessageKind}` {
	return customType === "irc:incoming" || customType === "irc:autoreply" || customType === "irc:relay";
}

function stringDetail(details: unknown, key: string): string {
	if (!details || typeof details !== "object") return "";
	const value = (details as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function legacyObservationId(fields: readonly string[]): string {
	const hash = crypto.createHash("sha256");
	hash.update("gjc:irc:legacy-observation:v1\0");
	for (const field of fields) {
		hash.update(String(Buffer.byteLength(field, "utf8")));
		hash.update(":");
		hash.update(field);
	}
	return `legacy:sha256:${hash.digest("hex")}`;
}

/**
 * Normalizes every supported IRC custom message into its UI observation shape.
 * Legacy records have no UUID, so their immutable payload is used as a stable key.
 */
export function parseIrcMessage(message: IrcCustomMessage): ParsedIrcMessage | undefined {
	if (!isIrcCustomType(message.customType)) return undefined;

	const kind = message.customType.slice(4) as IrcMessageKind;
	const sourceTimestamp =
		typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
	const timestamp = sourceTimestamp ?? Date.now();
	const rawFrom = kind === "autoreply" ? "you" : stringDetail(message.details, "from") || "?";
	const rawTo = kind === "incoming" ? "you" : stringDetail(message.details, "to") || "?";
	const rawText =
		kind === "incoming"
			? stringDetail(message.details, "message")
			: kind === "autoreply"
				? stringDetail(message.details, "reply")
				: stringDetail(message.details, "body");
	const from = normalizeIrcIdentity(rawFrom);
	const to = normalizeIrcIdentity(rawTo);
	const text = sanitizeText(rawText);
	const explicitObservationId = stringDetail(message.details, "observationId");
	const observationId = associateSessionMessageObservationId(
		message,
		explicitObservationId ||
			getSessionMessageObservationId(message) ||
			legacyObservationId([
				kind,
				sourceTimestamp === undefined ? "null" : String(sourceTimestamp),
				rawFrom,
				rawTo,
				rawText,
			]),
	);
	return {
		observationId,
		from,
		to,
		text,
		timestamp,
		kind,
	};
}
