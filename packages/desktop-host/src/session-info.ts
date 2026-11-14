import {
	type SdkComposerObservation,
	SdkComposerObservationError,
	type SdkSessionInfo,
} from "@gajae-code/coding-agent/sdk";
import type { DesktopSessionInfo } from "./session-info-protocol";

/** fieldChars counts Unicode code points, plus at most one truncation ellipsis. */
export const DESKTOP_SESSION_INFO_LIMITS = { fieldChars: 512, inputChars: 65_536 } as const;

export interface DesktopSessionInfoOptions {
	/** Required opaque identity from the owning host's app catalog, never supplied by the SDK. */
	catalogSessionId: string;
	/** Host-known secret/path/identity policy, applied before desktop display truncation. */
	redact: (text: string) => string;
	/** Additional app catalog/selection fence; the SDK separately fences its own identity. */
	isCurrent?: () => boolean;
}

const FAILURE_REASONS = {
	invalid_catalog_session: "A valid host-owned app catalog session identity is required.",
	disposed: "Session information is unavailable after disposal.",
	transitioning: "Session information is temporarily unavailable during a session transition.",
	stale_session: "The session changed while reading information; refresh the view.",
	backend_failure: "Session information could not be read from the public SDK.",
	redaction_failed: "Session information redaction failed; no content was returned.",
} as const;

type FailureCode = keyof typeof FAILURE_REASONS;

function failure(code: FailureCode): DesktopSessionInfo {
	return { available: false, code, reason: FAILURE_REASONS[code] };
}

class RedactionFailure extends Error {}

function text(value: string, redact: DesktopSessionInfoOptions["redact"]): string {
	// Withhold overlarge metadata in full: never truncate a secret before redacting it.
	if (value.length > DESKTOP_SESSION_INFO_LIMITS.inputChars) return "[withheld: display limit]";
	let redacted: unknown;
	try {
		redacted = redact(value);
	} catch {
		throw new RedactionFailure();
	}
	if (typeof redacted !== "string") throw new RedactionFailure();
	if (redacted.length > DESKTOP_SESSION_INFO_LIMITS.inputChars) return "[withheld: display limit]";
	const safe = redacted
		.toWellFormed()
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ");
	let result = "";
	let length = 0;
	for (const character of safe) {
		if (length++ === DESKTOP_SESSION_INFO_LIMITS.fieldChars) return `${result}…`;
		result += character;
	}
	return result;
}

function validCatalogSessionId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.exec(value)?.[0] === value;
}

function observationFailure(error: unknown): DesktopSessionInfo {
	if (error instanceof RedactionFailure) return failure("redaction_failed");
	if (error instanceof SdkComposerObservationError) {
		switch (error.code) {
			case "disposed":
				return failure("disposed");
			case "session_transitioning":
				return failure("transitioning");
			case "stale_session":
				return failure("stale_session");
		}
	}
	return failure("backend_failure");
}

/** Maps a trusted SDK owner snapshot; remote callers must also fence their query await. */
export function projectDesktopSessionInfo(
	info: SdkSessionInfo,
	options: DesktopSessionInfoOptions,
): DesktopSessionInfo {
	try {
		const catalogSessionId: unknown = options?.catalogSessionId;
		// The host resolves catalog membership; shape validation does not authorize a renderer claim.
		if (!validCatalogSessionId(catalogSessionId)) return failure("invalid_catalog_session");
		if (options.isCurrent && !options.isCurrent()) return failure("stale_session");
		if (info.sessionId && catalogSessionId.includes(info.sessionId)) return failure("invalid_catalog_session");
		const maskIdentity = (value: string): string =>
			info.sessionId ? value.replaceAll(info.sessionId, "[session]") : value;
		const redactMetadata = (value: string): string => {
			const redacted: unknown = options.redact(maskIdentity(value));
			if (typeof redacted !== "string") throw new RedactionFailure();
			return maskIdentity(redacted);
		};
		const result: DesktopSessionInfo = {
			available: true,
			metadata: {
				catalogSessionId,
				name: info.name === undefined ? null : text(info.name, redactMetadata),
				// The public observation intentionally exposes no native session-file capability.
				sessionFileDisplay: null,
				cwd: text(info.cwd, redactMetadata),
				createdAt: info.metadata.createdAt === null ? null : text(info.metadata.createdAt, redactMetadata),
				persisted: info.metadata.persisted,
			},
			model: info.model
				? {
						provider: text(info.model.provider, redactMetadata),
						id: text(info.model.id, redactMetadata),
						name: text(info.model.name, redactMetadata),
					}
				: null,
			thinkingLevel: info.thinkingLevel === null ? null : text(info.thinkingLevel, redactMetadata),
			run: { ...info.run },
			tools: { ...info.tools },
			recordedTotals: structuredClone(info.recordedTotals),
			activeTotals: structuredClone(info.activeTotals),
			liveProgress: structuredClone(info.liveProgress),
			context: { ...info.context },
			accountQuota: { ...info.accountQuota },
			actualBilledCost: { ...info.actualBilledCost },
		};
		if (options.isCurrent && !options.isCurrent()) return failure("stale_session");
		return result;
	} catch (error) {
		return observationFailure(error);
	}
}

/** Read-only public SDK observation, with an additional host identity/redaction boundary. */
export function readDesktopSessionInfo(
	observation: Pick<SdkComposerObservation, "info">,
	options: DesktopSessionInfoOptions,
): DesktopSessionInfo {
	try {
		if (!validCatalogSessionId(options?.catalogSessionId)) return failure("invalid_catalog_session");
		if (options.isCurrent && !options.isCurrent()) return failure("stale_session");
		const info = observation.info({});
		const result = projectDesktopSessionInfo(info, options);
		if (!result.available) return result;
		// Redaction is caller code and may re-enter lifecycle controls. Revalidate through
		// the same public observation rather than reaching into the SDK's session manager.
		const current = observation.info({});
		if (
			current.sessionId !== info.sessionId ||
			current.sessionGeneration !== info.sessionGeneration ||
			current.cwd !== info.cwd ||
			(options.isCurrent && !options.isCurrent())
		)
			return failure("stale_session");
		return result;
	} catch (error) {
		return observationFailure(error);
	}
}
