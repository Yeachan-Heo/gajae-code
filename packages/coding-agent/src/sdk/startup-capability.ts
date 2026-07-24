import {
	isModelProfileError,
	type ModelProfileErrorCode,
	type ModelProfileErrorDetails,
} from "../config/model-profile-contract";
export type SdkStartupPhase = "registration" | "startup";

export type SdkStartupReason = "disabled" | "ineligible" | "factory_absent" | "runner_absent" | "pending" | "failed";

export interface SdkStartupFailure {
	phase: SdkStartupPhase;
	reason: SdkStartupReason;
	message: string;
	code?: ModelProfileErrorCode;
	details?: ModelProfileErrorDetails;
}

export type SdkStartupResult = { status: "started" } | { status: "failed"; failure: SdkStartupFailure };

const FALLBACK_MESSAGE = "SDK startup failed.";
const MAX_MESSAGE_BYTES = 512;

/** Internal symbols for lifecycle-only SDK startup construction and bus wiring. */
export const lifecycleStartupCapabilityOption: unique symbol = Symbol("lifecycleStartupCapability");
const lifecycleStartupCapabilityOnApi: unique symbol = Symbol("lifecycleStartupCapabilityOnApi");

export function attachLifecycleStartupCapability(api: object, capability: SdkStartupCapability): void {
	(api as { [lifecycleStartupCapabilityOnApi]?: SdkStartupCapability })[lifecycleStartupCapabilityOnApi] = capability;
}

export function lifecycleStartupCapabilityForApi(api: object): SdkStartupCapability | undefined {
	return (api as { [lifecycleStartupCapabilityOnApi]?: SdkStartupCapability })[lifecycleStartupCapabilityOnApi];
}

export interface SdkStartupRollbackResult {
	endpointGeneration: number | null;
	fenced: boolean;
	runtimeRemoved: boolean;
	hostStopped: boolean;
	brokerRegistrationReleased: boolean;
}

/** Internal lifecycle-only proof recorder. Fields become true only after their operation completes. */
export class SdkStartupRollbackTracker {
	#generation: number | undefined;
	#result: SdkStartupRollbackResult = {
		endpointGeneration: null,
		fenced: false,
		runtimeRemoved: false,
		hostStopped: false,
		brokerRegistrationReleased: false,
	};

	get generation(): number | undefined {
		return this.#generation;
	}

	get result(): SdkStartupRollbackResult {
		return { ...this.#result };
	}

	recordGeneration(generation: number): void {
		this.#generation ??= generation;
		this.#result.endpointGeneration ??= generation;
	}

	recordAbsent(): void {
		if (this.#generation !== undefined) return;
		this.#result.fenced = true;
		this.#result.runtimeRemoved = true;
		this.#result.hostStopped = true;
		this.#result.brokerRegistrationReleased = true;
	}

	recordStop(
		generation: number,
		result: Pick<SdkStartupRollbackResult, "runtimeRemoved" | "hostStopped" | "brokerRegistrationReleased">,
	): void {
		if (this.#generation !== generation) return;
		this.#result.runtimeRemoved ||= result.runtimeRemoved;
		this.#result.hostStopped ||= result.hostStopped;
		this.#result.brokerRegistrationReleased ||= result.brokerRegistrationReleased;
		this.#result.fenced ||= result.hostStopped && result.brokerRegistrationReleased;
	}
}

/** Redact untrusted startup errors before they cross the lifecycle boundary. */
export function sanitizeSdkStartupMessage(value: unknown, knownSecrets: Iterable<unknown> = []): string {
	const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
	const secrets = [...knownSecrets]
		.filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
		.map(secret => ({ raw: secret, normalized: secret.normalize("NFKC") }))
		.sort((left, right) => right.normalized.length - left.normalized.length);
	let secretSafe = raw;
	for (const secret of secrets) {
		secretSafe = secretSafe.replaceAll(secret.raw, "[redacted-secret]");
		if (secret.normalized) secretSafe = secretSafe.replaceAll(secret.normalized, "[redacted-secret]");
	}
	let text = secretSafe
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	text = text
		.replace(/\b(?:https?|wss?):\/\/[^\s]+/giu, "[redacted-url]")
		.replace(/([?&](?:token|secret|password|key|api[_-]?key)=[^\s&]*)/giu, "[redacted-query]")
		.replace(
			/(^|[^\p{L}\p{N}_-])[\p{L}\p{N}_-]*(?:token|secret|password|api[_-]?key|key|credential|auth)\s*[=:]\s*[^\s,;]+/giu,
			"$1[redacted-secret]",
		)
		.replace(
			/\b(?:bearer\s+|token\s*[=:]\s*|secret\s*[=:]\s*|password\s*[=:]\s*|(?:api[_-]?)?key\s*[=:]\s*)[^\s,;]+/giu,
			"[redacted-secret]",
		);
	if (!text) return FALLBACK_MESSAGE;
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= MAX_MESSAGE_BYTES) return text;
	const suffix = "…";
	let end = text.length;
	while (end > 0 && new TextEncoder().encode(`${text.slice(0, end)}${suffix}`).length > MAX_MESSAGE_BYTES) end--;
	return end > 0 ? `${text.slice(0, end)}${suffix}` : FALLBACK_MESSAGE;
}

/** Convert every lifecycle bootstrap outcome to the public, bounded failure shape. */
export function normalizeSdkStartupFailure(
	phase: SdkStartupPhase,
	reason: SdkStartupReason,
	error?: unknown,
	knownSecrets?: Iterable<unknown>,
): SdkStartupFailure {
	const fallback =
		reason === "disabled"
			? "SDK startup is disabled."
			: reason === "ineligible"
				? "SDK startup is ineligible for this session."
				: reason === "factory_absent"
					? "SDK startup factory is unavailable."
					: reason === "runner_absent"
						? "SDK startup extension runner is unavailable."
						: reason === "pending"
							? "SDK startup did not complete before readiness cutoff."
							: FALLBACK_MESSAGE;
	const message = sanitizeSdkStartupMessage(error, knownSecrets);
	const profileError = isModelProfileError(error) ? { code: error.code, details: error.details } : {};
	return { phase, reason, message: message === FALLBACK_MESSAGE ? fallback : message, ...profileError };
}

/** Collect process-scoped credentials without exposing a raw-secret API. */
function lifecycleKnownSecrets(): string[] {
	return Object.entries(process.env)
		.filter(([name, value]) => value && /(?:token|secret|password|credential|api[_-]?key|auth)/iu.test(name))
		.map(([, value]) => value!);
}

/** Session-owned, exactly-once lifecycle bootstrap completion. */
export class SdkStartupCapability {
	#result: SdkStartupResult | undefined;
	#settled = Promise.withResolvers<SdkStartupResult>();
	#cancelled = false;

	get cancelled(): boolean {
		return this.#cancelled;
	}

	cancel(): void {
		this.#cancelled = true;
	}

	constructor(readonly rollback?: SdkStartupRollbackTracker) {}

	normalizeFailure(phase: SdkStartupPhase, reason: SdkStartupReason, error?: unknown): SdkStartupFailure {
		return normalizeSdkStartupFailure(phase, reason, error, lifecycleKnownSecrets());
	}

	get result(): SdkStartupResult | undefined {
		return this.#result;
	}

	get promise(): Promise<SdkStartupResult> {
		return this.#settled.promise;
	}

	settleStarted(): SdkStartupResult {
		return this.#settle({ status: "started" });
	}

	settleFailure(failure: SdkStartupFailure): SdkStartupResult {
		return this.#settle({ status: "failed", failure });
	}

	#settle(result: SdkStartupResult): SdkStartupResult {
		if (this.#result) return this.#result;
		this.#result = result;
		this.#settled.resolve(result);
		return result;
	}
}
