/**
 * Minimal Sentry Envelope construction for crash aggregation.
 *
 * This intentionally does not use a Sentry SDK: SDK defaults capture process
 * context and breadcrumbs, while this module must prove every crash-derived
 * byte passed the single outbound sanitizer before it reaches the relay.
 */
import { randomUUID } from "node:crypto";
import { CRASH_BODY_MAX_BYTES, type SanitizeVerdict, sanitizeExternalCrashV1 } from "../sanitize";
import { type SentryDsn, toDsnString } from "./dsn";

export interface CrashEventFrame {
	readonly filename: string;
	readonly function: string;
}

export interface BuildCrashEnvelopeInput {
	readonly eventId: string;
	readonly fingerprint: string;
	readonly errorName: string;
	readonly messageClass: string;
	readonly frames: readonly CrashEventFrame[];
	readonly firstSeen: number;
	readonly lastSeen: number;
	readonly lifetimeCount: number;
	readonly release: string;
	readonly platform: string;
	readonly bunVersion: string;
	readonly dsn: SentryDsn;
}

export type BuildCrashEnvelopeResult = { ok: true; body: string; eventId: string } | { ok: false; reason: string };

const EVENT_ID = /^[0-9a-f]{32}$/;
const CREDENTIAL_LIKE_PATTERNS: readonly RegExp[] = [
	/\bAIza[0-9A-Za-z_-]{20,}\b/,
	/\bnpm_[A-Za-z0-9]{20,}\b/,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/,
	/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
	/\bhf_[A-Za-z0-9]{20,}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function sanitizeEgressField(value: string): SanitizeVerdict {
	if (CREDENTIAL_LIKE_PATTERNS.some(pattern => pattern.test(value)))
		return { ok: false, reason: "credential-like content" };
	return sanitizeExternalCrashV1(value, CRASH_BODY_MAX_BYTES);
}

function coarseDate(epochMs: number): string | undefined {
	const date = new Date(epochMs);
	if (!Number.isFinite(epochMs) || Number.isNaN(date.getTime())) return undefined;
	return date.toISOString().slice(0, 10);
}

/**
 * Seconds at UTC midnight of the given instant.
 *
 * Sentry requires an event `timestamp`, but the egress contract says exact
 * crash times never leave the machine: a precise timestamp is a behavioural
 * fingerprint of when a specific person was working. Truncating to the day
 * keeps the field well-formed and keeps the resolution identical to the
 * firstSeen/lastSeen dates the issue flow already publishes.
 */
function coarseEpochSeconds(epochMs: number): number | undefined {
	const date = coarseDate(epochMs);
	return date === undefined ? undefined : Date.parse(`${date}T00:00:00.000Z`) / 1000;
}

function reject(reason: string): BuildCrashEnvelopeResult {
	return { ok: false, reason };
}

/** Create Sentry's required lowercase 128-bit event identifier. */
export function newSentryEventId(): string {
	return randomUUID().replaceAll("-", "");
}

/** Build the exact auth header used for the hand-rolled envelope POST. */
export function sentryAuthHeader(dsn: SentryDsn, clientVersion: string): string {
	return `Sentry sentry_version=7, sentry_client=gjc.crash-relay/${clientVersion}, sentry_key=${dsn.publicKey}`;
}

/**
 * Build a three-line event envelope. Sanitization failures and oversize output
 * refuse the complete event: JSON must never be truncated into a new payload.
 */
export function buildCrashEnvelope(input: BuildCrashEnvelopeInput): BuildCrashEnvelopeResult {
	if (!EVENT_ID.test(input.eventId)) return reject("invalid event id");
	if (!EVENT_ID.test(input.fingerprint)) return reject("invalid fingerprint");
	if (!Number.isFinite(input.lifetimeCount) || input.lifetimeCount < 0) return reject("invalid lifetime count");
	const firstSeen = coarseDate(input.firstSeen);
	const lastSeen = coarseDate(input.lastSeen);
	if (!firstSeen || !lastSeen) return reject("invalid timestamp");

	const errorName = sanitizeEgressField(input.errorName);
	if (!errorName.ok) return reject(errorName.reason);
	const messageClass = sanitizeEgressField(input.messageClass);
	if (!messageClass.ok) return reject(messageClass.reason);

	const frames: { filename: string; function: string; in_app: true }[] = [];
	for (const frame of input.frames) {
		const filename = sanitizeEgressField(frame.filename);
		if (!filename.ok) return reject(filename.reason);
		const functionName = sanitizeEgressField(frame.function);
		if (!functionName.ok) return reject(functionName.reason);
		frames.push({ filename: filename.value, function: functionName.value, in_app: true });
	}

	const dsn = toDsnString(input.dsn);
	if (!dsn) return reject("invalid dsn");
	const coarseTimestamp = coarseEpochSeconds(input.lastSeen);
	if (coarseTimestamp === undefined) return reject("invalid timestamp");
	const payload = JSON.stringify({
		event_id: input.eventId,
		timestamp: coarseTimestamp,
		platform: "node",
		level: "fatal",
		logger: "gjc.crash",
		release: input.release,
		environment: "production",
		fingerprint: [input.fingerprint],
		exception: {
			values: [
				{
					type: errorName.value,
					value: messageClass.value,
					stacktrace: { frames: frames.reverse() },
				},
			],
		},
		tags: {
			"gjc.fingerprint": input.fingerprint,
			"gjc.fpv": "1",
			"gjc.platform": input.platform,
			bun: input.bunVersion,
		},
		extra: { lifetimeCount: input.lifetimeCount, firstSeen, lastSeen },
		sdk: { name: "gjc.crash-relay", version: input.release },
	});
	const itemHeader = JSON.stringify({
		type: "event",
		length: Buffer.byteLength(payload, "utf8"),
		content_type: "application/json",
	});
	const envelopeHeader = JSON.stringify({ event_id: input.eventId, dsn });
	const body = `${envelopeHeader}\n${itemHeader}\n${payload}`;
	if (Buffer.byteLength(body, "utf8") > CRASH_BODY_MAX_BYTES) return reject("envelope exceeds size limit");
	return { ok: true, body, eventId: input.eventId };
}
