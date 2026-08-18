/**
 * Opt-in crash relay to a Sentry-compatible upstream.
 *
 * This is a **second, separate** egress channel from `gjc crash report`. The
 * issue flow keeps its per-invocation, digest-confirmed consent boundary; this
 * one is gated by configuration instead, and is therefore deliberately much
 * narrower in what it can ever emit:
 *
 * 1. `crashReport.upstream` must be `sentry`. The default is `off`, and while
 *    it is off this module performs no IO at all — not even a state read.
 * 2. An operator must supply a DSN. No DSN literal is compiled into the binary,
 *    so a build has no destination to fall back to; an unset DSN is a hard stop
 *    and never means "use ours".
 * 3. Every crash-derived byte must pass `sanitizeExternalCrashV1`. A refusal
 *    drops that signature entirely. There is no less-sanitized fallback path.
 *
 * The relay never runs on the fatal path. A crashing process still does exactly
 * one `O_APPEND` write and dies; relaying happens at the *next* startup, after
 * compaction, where blocking and failing are both safe.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, normalizeCrashFrames, VERSION } from "@gajae-code/utils";
import { $credentialEnv } from "@gajae-code/utils/env";
import {
	type CrashSignatureView,
	type CrashStatePaths,
	compactCrashIndex,
	listCrashSignatures,
	recordCrashStateEvent,
	resolveCrashStatePaths,
} from "../index-store";
import { findLatestRecord } from "../record-loader";
import { parseSentryDsn, type SentryDsn } from "./dsn";
import { buildCrashEnvelope, type CrashEventFrame, sentryAuthHeader } from "./envelope";

/** Trusted environment variable form of the DSN, for CI and one-off runs. */
export const CRASH_UPSTREAM_DSN_ENV = "GJC_CRASH_SENTRY_DSN";

/**
 * Cap per startup. A crash loop can produce many signatures; a bounded batch
 * keeps a pathological machine from turning startup into a network stall.
 */
const MAX_RELAY_PER_RUN = 8;
const RELAY_TIMEOUT_MS = 10_000;
const RELAY_CLAIM_TTL_MS = RELAY_TIMEOUT_MS * 2;

export interface CrashRelayConfig {
	readonly upstream: "off" | "sentry";
	readonly dsn: string;
}

/**
 * The only settings surface the relay is allowed to read.
 *
 * `Settings.get` merges project `.gjc` configuration into the answer, so using
 * it here would let merely opening a repository turn the relay on and choose
 * its destination — an untrusted checkout could redirect crash signatures that
 * were recorded long before it was cloned. Both keys are therefore read from
 * the user/global layer only, which is exactly what `getGlobal` documents
 * itself for.
 */
export interface TrustedRelaySettings {
	getGlobal(path: "crashReport.upstream" | "crashReport.upstreamDsn"): unknown;
}

/**
 * Resolve the relay configuration from the trusted layer.
 *
 * The values are re-validated rather than trusted by type. `getGlobal` reports
 * whatever the hand-editable global config file holds, and it returns
 * `undefined` instead of a schema default, so anything that is not literally
 * `"sentry"` lands on `off` and anything that is not a string lands on an empty
 * DSN. Both absent and malformed therefore fail closed.
 */
export function readTrustedRelayConfig(settings: TrustedRelaySettings): CrashRelayConfig {
	const upstream = settings.getGlobal("crashReport.upstream");
	const dsn = settings.getGlobal("crashReport.upstreamDsn");
	return {
		upstream: upstream === "sentry" ? "sentry" : "off",
		dsn: typeof dsn === "string" ? dsn : "",
	};
}

/**
 * The exact shape the relay uses. Narrower than `typeof fetch` on purpose: the
 * relay only ever issues one POST to a known URL, and depending on the full
 * runtime signature (Bun adds `preconnect`) would force every caller and test
 * double to fake surface this module never touches.
 */
export type CrashRelayFetch = (url: string, init: RequestInit) => Promise<Response>;

export type CrashRelaySkip = "disabled" | "no-dsn" | "invalid-dsn" | "nothing-to-relay";

export type CrashRelayOutcome =
	| { readonly status: "skipped"; readonly reason: CrashRelaySkip }
	| {
			readonly status: "ran";
			/** Signatures the upstream accepted and that are now stamped `relayedAt`. */
			readonly sent: number;
			/** Signatures dropped because the sanitizer refused a field. */
			readonly refused: number;
			/** Signatures the upstream rejected or that failed in transport. */
			readonly failed: number;
	  };

export interface CrashRelayOptions {
	readonly config: CrashRelayConfig;
	readonly paths?: CrashStatePaths;
	readonly env?: Record<string, string | undefined>;
	readonly fetchImpl?: CrashRelayFetch;
	readonly now?: () => number;
	readonly maxPerRun?: number;
	readonly platform?: string;
	readonly release?: string;
	readonly bunVersion?: string;
}

/**
 * Resolve the destination. Explicit config wins over the environment so a
 * machine-wide export cannot silently redirect a configured install.
 */
export function resolveRelayDsn(
	config: CrashRelayConfig,
	env: Record<string, string | undefined> = {},
): { ok: true; dsn: SentryDsn } | { ok: false; reason: CrashRelaySkip } {
	if (config.upstream !== "sentry") return { ok: false, reason: "disabled" };
	// `env` is an injection seam only. Production resolution uses
	// `$credentialEnv`, which excludes the checkout's `.env` overlay.
	const raw =
		config.dsn.trim() || (env[CRASH_UPSTREAM_DSN_ENV] ?? $credentialEnv(CRASH_UPSTREAM_DSN_ENV) ?? "").trim();
	if (!raw) return { ok: false, reason: "no-dsn" };
	const dsn = parseSentryDsn(raw);
	if (!dsn) return { ok: false, reason: "invalid-dsn" };
	return { ok: true, dsn };
}

/**
 * A signature is due when it has never been relayed, or when new occurrences
 * have landed since the last accepted send. Sentry groups by our fingerprint,
 * so a repeat send updates that group's count rather than creating noise.
 */
export function isRelayDue(signature: CrashSignatureView): boolean {
	return signature.relayedRecordId === undefined || signature.relayedRecordId !== signature.lastRecordId;
}

/** Split a normalized `path#function` frame into Sentry's frame shape. */
function toEventFrames(stack: string): CrashEventFrame[] {
	return normalizeCrashFrames(stack).map(frame => {
		const hash = frame.lastIndexOf("#");
		return hash < 0
			? { filename: frame, function: "<anonymous>" }
			: { filename: frame.slice(0, hash), function: frame.slice(hash + 1) };
	});
}

function coarsePlatform(): string {
	if (process.platform === "darwin") return "macOS";
	if (process.platform === "win32") return "Windows";
	return "Linux";
}

async function claimRelay(
	paths: CrashStatePaths,
	fingerprint: string,
	eventId: string,
	watermark: number,
	now: number,
): Promise<
	{ readonly status: "claimed"; readonly release: () => Promise<void> } | { readonly status: "contended" | "failed" }
> {
	const claimPath = path.join(path.dirname(paths.index), `.gjc-crash-relay-${fingerprint}`);
	try {
		const file = await fs.open(claimPath, "wx", 0o600);
		await file.writeFile(`${JSON.stringify({ eventId, watermark })}\n`);
		await file.close();
		return { status: "claimed", release: () => fs.rm(claimPath, { force: true }) };
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") return { status: "failed" };
		try {
			const stat = await fs.stat(claimPath);
			if (now - stat.mtimeMs > RELAY_CLAIM_TTL_MS) await fs.rm(claimPath, { force: true });
		} catch {
			return { status: "failed" };
		}
		return { status: "contended" };
	}
}

/**
 * Relay every due signature once. Never throws: a broken upstream, an offline
 * machine or a corrupt crash log must not be able to take down startup.
 */
export async function relayCrashSignatures(options: CrashRelayOptions): Promise<CrashRelayOutcome> {
	const resolved = resolveRelayDsn(options.config, options.env);
	// Gate before any filesystem access: `off` must be indistinguishable from
	// the feature not existing.
	if (!resolved.ok) return { status: "skipped", reason: resolved.reason };

	// Relay historical crashes only from the global agent directory. The
	// ordinary resolver honors XDG_STATE_HOME, which a repository `.env` can
	// influence before startup; that makes its files untrusted for egress.
	const paths = options.paths ?? resolveCrashStatePaths(getAgentDir());
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const release = options.release ?? VERSION;
	const platform = options.platform ?? coarsePlatform();
	const bunVersion = options.bunVersion ?? Bun.version;
	const limit = options.maxPerRun ?? MAX_RELAY_PER_RUN;

	// Compaction is the same step the nudge and the CLI rely on: it folds the
	// append-only journal into the index under the cross-process lock, so the
	// counts we are about to relay are the reconciled ones.
	const index = await compactCrashIndex({ paths, now: now() });
	const signatures = listCrashSignatures(index)
		.filter(isRelayDue)
		.sort((a, b) => a.firstSeen - b.firstSeen || a.fingerprint.localeCompare(b.fingerprint))
		.slice(0, limit);
	if (signatures.length === 0) return { status: "skipped", reason: "nothing-to-relay" };

	let crashLog = "";
	try {
		crashLog = await fs.readFile(paths.crashLog, "utf8");
	} catch {
		// A missing or unreadable log means no stack to attach; the signature
		// metadata alone is not worth a send.
		return { status: "skipped", reason: "nothing-to-relay" };
	}

	let sent = 0;
	let refused = 0;
	let failed = 0;

	for (const signature of signatures) {
		// Retrying after an accepted POST but before the local state event becomes
		// durable must reuse the same upstream event identity.
		const eventId = createHash("sha256")
			.update(`${signature.fingerprint}:${signature.lastRecordId}`)
			.digest("hex")
			.slice(0, 32);
		const claim = await claimRelay(paths, signature.fingerprint, eventId, signature.lastSeen, now());
		if (claim.status !== "claimed") {
			if (claim.status === "failed") failed++;
			continue;
		}
		const record = findLatestRecord(crashLog, signature.fingerprint);
		if (!record) {
			refused++;
			await claim.release().catch(() => {});
			continue;
		}

		const envelope = buildCrashEnvelope({
			eventId,
			fingerprint: signature.fingerprint,
			errorName: signature.errorName,
			messageClass: signature.messageClass,
			frames: toEventFrames(record.body),
			firstSeen: signature.firstSeen,
			lastSeen: signature.lastSeen,
			lifetimeCount: signature.lifetimeCount,
			release,
			platform,
			bunVersion,
			dsn: resolved.dsn,
		});
		if (!envelope.ok) {
			// Fail closed. Deliberately no retry with a reduced payload.
			refused++;
			await claim.release().catch(() => {});
			continue;
		}

		const accepted = await postEnvelope(fetchImpl, resolved.dsn, envelope.body, release);
		if (!accepted) {
			failed++;
			await claim.release().catch(() => {});
			continue;
		}

		// Stamp the watermark the envelope actually represented, not the wall clock.
		// An occurrence appended between the snapshot above and this write advances
		// `lastSeen` past what was sent; stamping `now()` would hide it behind
		// `isRelayDue` and that occurrence would never be relayed. Stamping the
		// snapshot's `lastSeen` leaves the signature due again, which is the
		// conservative direction: at worst one duplicate event that Sentry folds
		// into the same fingerprint group.
		try {
			await recordCrashStateEvent(
				{
					kind: "relayed",
					fingerprint: signature.fingerprint,
					at: signature.lastSeen,
					eventId: envelope.eventId,
					recordId: signature.lastRecordId,
				},
				{ paths, now: now() },
			);
			sent++;
		} catch {
			// The upstream may have accepted, but delivery is not complete until
			// the local idempotency watermark is durable.
			failed++;
		} finally {
			await claim.release().catch(() => {});
		}
	}

	return { status: "ran", sent, refused, failed };
}

/** POST one envelope. Any non-2xx, transport error or timeout is a plain false. */
async function postEnvelope(
	fetchImpl: CrashRelayFetch,
	dsn: SentryDsn,
	body: string,
	release: string,
): Promise<boolean> {
	try {
		const response = await fetchImpl(dsn.envelopeUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-sentry-envelope",
				"X-Sentry-Auth": sentryAuthHeader(dsn, release),
			},
			body,
			redirect: "error",
			credentials: "omit",
			signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
}
